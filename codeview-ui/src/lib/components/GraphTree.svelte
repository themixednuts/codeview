<script lang="ts">
	import type { Node, NodeKind } from '$lib/graph';
	import type { NodeSummary, TreeNodeDTO } from '$lib/schema';
	import type { CrateStatusValue } from '$lib/context';
	import { Data, Effect } from 'effect';
	import { SvelteSet } from 'svelte/reactivity';
	import { CHILDREN_PLACEHOLDER, matchesFilter, type TreeNode } from '$lib/tree';
	import { expandPathCtx, treeParamsCtx } from '$lib/context';
	import { getStaticTreeChildren, getTreeChildren } from '$lib/rpc/children.remote';
	import { getStaticTreeAncestors, getTreeAncestors } from '$lib/rpc/ancestors.remote';
	import { isHosted } from '$lib/platform';
	import VirtualTree from './VirtualTree.svelte';
	import { perf } from '$lib/perf';
	import { perfTick } from '$lib/perf.svelte';
	import { getLogger } from '$lib/log';
	import { onMount } from 'svelte';

	let {
		roots = null,
		crateName = '',
		crateVersion = '',
		selected = null,
		selectedId = '',
		getNodeUrl,
		filter,
		kindFilter,
		rootChildren = null,
		prefetchedChildren = [],
		status = 'unknown',
		showBlanketImpls = false,
	} = $props<{
		/** Root DTOs from server. */
		roots?: TreeNodeDTO[] | null;
		/** Crate name for children RPC calls. */
		crateName?: string;
		/** Crate version for children RPC calls. */
		crateVersion?: string;
		selected?: Node | null;
		/** Selected node ID — used for highlighting and auto-expand. */
		selectedId?: string;
		getNodeUrl: (id: string) => string;
		filter: string;
		kindFilter: Set<NodeKind>;
		rootChildren?: { id: string; children: TreeNodeDTO[] } | null;
		prefetchedChildren?: Array<{ id: string; children: TreeNodeDTO[] }> | null;
		status?: CrateStatusValue;
		showBlanketImpls?: boolean;
	}>();
	const log = getLogger('graph-tree');

	class TreeChildrenFetchError extends Data.TaggedError('TreeChildrenFetchError')<{
		readonly nodeId: string;
		readonly cause: unknown;
		readonly message: string;
	}> {}

	function unknownMessage(cause: unknown): string {
		return cause instanceof Error ? cause.message : String(cause);
	}

	function loadTreeChildren(input: { name: string; version?: string; nodeId: string }) {
		return isHosted ? getStaticTreeChildren(input) : getTreeChildren(input);
	}

	function loadTreeAncestors(input: { name: string; version?: string; nodeId: string }) {
		return isHosted ? getStaticTreeAncestors(input) : getTreeAncestors(input);
	}

	function loadTreeChildrenEffect(crate: string, ver: string, nodeId: string) {
		return Effect.tryPromise({
			try: async () => ({
				id: nodeId,
				children: await loadTreeChildren({ name: crate, version: ver, nodeId }),
			}),
			catch: (cause) =>
				new TreeChildrenFetchError({
					nodeId,
					cause,
					message: `children fetch failed for ${nodeId}: ${unknownMessage(cause)}`,
				}),
		});
	}

	function loadTreeChildrenBatch(crate: string, ver: string, nodeIds: string[]) {
		return Effect.forEach(nodeIds, (nodeId) => loadTreeChildrenEffect(crate, ver, nodeId), {
			concurrency: 8,
		});
	}

	let hydrated = $state(false);

	onMount(() => {
		hydrated = true;
	});

	/** Pre-fetched expand path from DetailView via context (ancestors + children). */
	const expandPath = $derived(expandPathCtx.getOr(null));

	/** Reactive URL params singleton from layout — tree writes `ex` param here. */
	const treeParams = treeParamsCtx.getOr(null);

	/** Effective selected node ID — from explicit selectedId prop or selected.id. */
	const selId = $derived(selectedId || selected?.id || null);

	const expandedIds = new SvelteSet<string>();
	// Tracks nodes the user explicitly collapsed — prevents selectedAncestorIds
	// from forcing ancestor nodes back open after the user collapses them.
	const collapsedIds = new SvelteSet<string>();

	// Seed expanded IDs from URL synchronously during init — MUST happen before
	// any $effect runs, otherwise the extraExpandedIds write-effect fires first
	// with empty expandedIds and deletes `ex` from treeParams.
	if (treeParams) {
		const ex = treeParams.get('ex');
		if (ex) {
			for (const id of ex.split(',').filter(Boolean)) expandedIds.add(id);
		}
	}

	// ── Children cache ──────────────────────────────────────────────────

	// Cache of fetched children (survives expand/collapse cycles)
	const childrenCache = new Map<string, TreeNodeDTO[]>();
	// Version counter bumped when cache changes (triggers reactive derivations)
	let cacheVersion = $state(0);

	function seedServerChildren(bumpVersion: boolean) {
		let changed = false;
		if (rootChildren?.id) {
			const rootId = rootChildren.id;
			const cached = childrenCache.get(rootId);
			const shouldRefresh =
				!cached ||
				(rootChildren.children.length > cached.length && rootChildren.children.length > 0) ||
				(status === 'ready' && cached.length === 0 && rootChildren.children.length > 0);
			if (shouldRefresh) {
				childrenCache.set(rootId, rootChildren.children);
				changed = true;
			}
			if (!collapsedIds.has(rootId)) {
				if (!expandedIds.has(rootId)) changed = true;
				expandedIds.add(rootId);
			}
		}

		const seeds = prefetchedChildren ?? [];
		for (const { id, children } of seeds) {
			if (!id) continue;
			const cached = childrenCache.get(id);
			if (cached !== children) {
				childrenCache.set(id, children);
				changed = true;
			}
			if (!collapsedIds.has(id) && !expandedIds.has(id)) {
				expandedIds.add(id);
				changed = true;
			}
		}
		if (changed && bumpVersion) cacheVersion += 1;
	}

	seedServerChildren(false);

	$effect(() => {
		seedServerChildren(true);
	});

	function isBlanketImplNode(node: { kind: NodeKind; [key: string]: unknown }): boolean {
		if (node.kind !== 'Impl') return false;
		const category = node.impl_category;
		return category === 'Blanket' || category === 'Synthetic';
	}

	function shouldIncludeTreeNode(node: NodeSummary): boolean {
		if (showBlanketImpls) return true;
		if (node.id === selId) return true;
		return !isBlanketImplNode(node);
	}

	function visibleTreeDtos(items: TreeNodeDTO[]): TreeNodeDTO[] {
		if (showBlanketImpls) return items;
		return items.filter((dto) => shouldIncludeTreeNode(dto.node));
	}

	function dtoToTreeNode(dto: TreeNodeDTO): TreeNode {
		const cachedChildren = childrenCache.get(dto.node.id);
		const hasChildren = cachedChildren
			? visibleTreeDtos(cachedChildren).length > 0
			: dto.hasChildren;
		return {
			node: dto.node as Node,
			children: hasChildren ? CHILDREN_PLACEHOLDER : [],
			selectable: true,
		};
	}

	/** Pure cache reader — returns cached children as TreeNodes, or [] if not yet fetched. */
	function getChildren(parentId: string): TreeNode[] {
		const cached = childrenCache.get(parentId);
		if (!cached) return [];
		return visibleTreeDtos(cached).map(dtoToTreeNode);
	}

	// Build a parentMap from the fetched children cache
	const parentMap = $derived.by(() => {
		// Trigger re-evaluation when cache changes
		void cacheVersion;
		const map = new Map<string, string>();
		for (const [parentId, children] of childrenCache) {
			for (const child of children) {
				map.set(child.node.id, parentId);
			}
		}
		return map;
	});

	// ── Derived state ────────────────────────────────────────────

	// Root DTOs → TreeNodes (children resolved lazily by VirtualTree via resolveChildren)
	const baseTree = $derived(
		roots?.length ? visibleTreeDtos(roots).map(dtoToTreeNode) : ([] as TreeNode[]),
	);

	function filterTree(trees: TreeNode[], filter: string, kindFilter: Set<NodeKind>): TreeNode[] {
		function filterNode(tn: TreeNode): TreeNode | null {
			const children = tn.children === CHILDREN_PLACEHOLDER ? getChildren(tn.node.id) : tn.children;

			const filteredChildren: TreeNode[] = [];
			for (const child of children) {
				const next = filterNode(child);
				if (next) filteredChildren.push(next);
			}

			const selfMatches = matchesFilter(tn.node, filter, kindFilter);
			if (!selfMatches && filteredChildren.length === 0) return null;
			if (filteredChildren.length === children.length && children === tn.children) return tn;
			return {
				node: tn.node,
				selectable: tn.selectable,
				children: filteredChildren,
			};
		}

		const result: TreeNode[] = [];
		for (const tree of trees) {
			const filtered = filterNode(tree);
			if (filtered) result.push(filtered);
		}
		return result;
	}

	const normalizedFilter = $derived(filter.trim().toLowerCase());

	const tree = $derived.by(() => {
		if (baseTree.length === 0) return [];
		if (!normalizedFilter && kindFilter.size === 0) {
			return baseTree;
		}
		return perf.time('derived', 'filterTree', () =>
			filterTree(baseTree, normalizedFilter, kindFilter),
		);
	});

	const selectedAncestorIds = $derived.by(() => {
		if (!selId) return [] as string[];
		// Read parentMap (triggers when cache changes)
		const map = parentMap;
		const ancestors: string[] = [];
		let currentId = selId;
		while (map.has(currentId)) {
			const pid = map.get(currentId)!;
			ancestors.push(pid);
			currentId = pid;
		}
		return ancestors;
	});

	const expandedIdsForRender = $derived.by(() => {
		const result = new Set<string>();
		for (const id of expandedIds) result.add(id);
		for (const id of selectedAncestorIds) {
			if (!collapsedIds.has(id)) result.add(id);
		}
		return result;
	});

	// Extra expanded IDs = user-expanded branches not part of the selected node's ancestors.
	// These are persisted in the URL `ex` param so tree state survives refresh.
	// Uses both selectedAncestorIds (from lazy parentMap) and expandPath (from server)
	// to reliably exclude ancestors even before children cache is populated.
	const extraExpandedIds = $derived.by(() => {
		const ancestorSet = new Set(selectedAncestorIds);
		if (expandPath) {
			for (const a of expandPath.ancestors) ancestorSet.add(a.id);
		}
		const extra: string[] = [];
		for (const id of expandedIds) {
			if (id !== selId && !ancestorSet.has(id)) {
				extra.push(id);
			}
		}
		extra.sort();
		return extra;
	});

	// Write extra expanded IDs to treeParams (side effect: writing to shared state)
	$effect(() => {
		if (!treeParams) return;
		const val = extraExpandedIds.join(',');
		if (val) treeParams.set('ex', val);
		else treeParams.delete('ex');
	});

	// Reset internal state on cross-crate navigation (avoids stale tree data
	// when the component stays mounted through an {#if} transition).
	let lastCrateKey = '';
	let lastReadyKey = '';
	let observedNonReady = false;
	let lastRootExpandKey = '';
	let lastReadyExpandKey = '';
	$effect(() => {
		const key = `${crateName}@${crateVersion}`;
		if (!key || key === '@' || key === lastCrateKey) return;
		if (lastCrateKey) {
			childrenCache.clear();
			expandedIds.clear();
			collapsedIds.clear();
			lastExpandKey = null;
			cacheVersion += 1;
			treeParams?.delete('ex');
			log.debug`crate changed ${lastCrateKey} → ${key}, reset tree state`;
		}
		observedNonReady = status !== 'ready';
		lastReadyKey = status === 'ready' ? key : '';
		// First mount seeding from URL is done synchronously at component init
		// (above expandedIds declaration) to prevent the extraExpandedIds write-effect
		// from clearing treeParams before this effect runs.
		lastCrateKey = key;
	});

	$effect(() => {
		if (!crateName || !crateVersion) return;
		if (!baseTree.length) return;
		if (filter || kindFilter.size > 0) return;
		const rootId = baseTree[0].node.id;
		if (!rootId) return;
		if (selId && selId !== rootId) return;
		if (expandedIds.size > 0 || collapsedIds.has(rootId)) return;
		const key = `${crateName}@${crateVersion}:${rootId}`;
		if (lastRootExpandKey === key) return;
		lastRootExpandKey = key;
		void expandAndFetch(rootId);
	});

	$effect(() => {
		if (!crateName || !crateVersion) return;
		if (status !== 'ready') {
			observedNonReady = true;
			return;
		}
		const key = `${crateName}@${crateVersion}`;
		if (!observedNonReady) {
			lastReadyKey = key;
			return;
		}
		if (lastReadyKey === key) return;
		lastReadyKey = key;

		const expanded = Array.from(expandedIds);
		for (const id of expanded) {
			childrenCache.delete(id);
		}
		if (expanded.length > 0) cacheVersion += 1;
		for (const id of expanded) {
			void expandAndFetch(id);
		}
		log.debug`tree cache refreshed on ready for ${key}`;
	});

	$effect(() => {
		if (!crateName || !crateVersion) return;
		if (status !== 'ready') return;
		if (filter || kindFilter.size > 0) return;
		if (!baseTree.length) return;
		if (expandedIds.size > 0) return;
		const rootId = baseTree[0]?.node.id;
		if (!rootId || collapsedIds.has(rootId)) return;
		const expandKey = `${crateName}@${crateVersion}:${rootId}`;
		if (lastReadyExpandKey === expandKey) return;
		lastReadyExpandKey = expandKey;
		void expandAndFetch(rootId);
	});

	// Expand the tree path to the selected node.
	// Prefers pre-fetched context data from nodeView; falls back to RPC.
	let lastExpandKey: string | null = null;
	$effect(() => {
		if (!selId || !crateName || !crateVersion) return;

		// Dedup key includes selId + whether we have expandPath.
		// This lets the effect re-run when expandPath arrives after initial render
		// (e.g. when treeRoots resolves before nodeView sets the expand path).
		const key = expandPath ? `${selId}:ctx` : `${selId}:rpc`;
		if (key === lastExpandKey) return;
		lastExpandKey = key;

		if (expandPath) {
			// Fetch children for path ancestors + any user-expanded branches.
			// The selected node's own children stay lazy until the user expands it.
			fetchAndExpand(
				expandPath.ancestors.map((a) => a.id),
				expandPath,
				crateName,
				crateVersion,
			);
			return;
		}

		// Fallback: fetch ancestors + children (edge case: direct GraphTree usage without DetailView)
		if (hydrated) {
			expandToNode(selId, crateName, crateVersion);
		}
	});

	/** Fetch children for the given IDs + any already-expanded nodes, then expand ancestors. */
	async function fetchAndExpand(
		pathIds: string[],
		path: NonNullable<typeof expandPath>,
		crate: string,
		ver: string,
	) {
		// Include already-expanded IDs (from URL `ex` param) so they have children too
		const allIds = [...new Set([...pathIds, ...expandedIds])];
		const idsToFetch = allIds.filter((id) => !childrenCache.has(id));

		if (idsToFetch.length > 0) {
			try {
				const results = await Effect.runPromise(loadTreeChildrenBatch(crate, ver, idsToFetch));
				for (const { id, children } of results) {
					childrenCache.set(id, children);
				}
			} catch (err) {
				log.warn`fetchAndExpand failed: ${String(err)}`;
			}
		}

		for (const ancestor of path.ancestors) {
			expandedIds.add(ancestor.id);
			collapsedIds.delete(ancestor.id);
		}
		cacheVersion += 1;
	}

	/** Fallback: resolve ancestors via RPC, fetch their children, then expand. */
	async function expandToNode(nodeId: string, crate: string, ver: string) {
		try {
			const ancestors = await loadTreeAncestors({
				name: crate,
				version: ver,
				nodeId,
			});
			if (!ancestors.length) return;

			const idsToFetch = ancestors.map((a) => a.id).filter((id) => !childrenCache.has(id));
			if (idsToFetch.length > 0) {
				const results = await Effect.runPromise(loadTreeChildrenBatch(crate, ver, idsToFetch));
				for (const { id, children } of results) {
					childrenCache.set(id, children);
				}
			}

			for (const ancestor of ancestors) {
				expandedIds.add(ancestor.id);
				collapsedIds.delete(ancestor.id);
			}
			expandedIds.add(nodeId);
			cacheVersion += 1;
		} catch (err) {
			log.warn`expandToNode failed for ${nodeId}: ${String(err)}`;
		}
	}

	function toggleExpand(id: string) {
		if (expandedIdsForRender.has(id)) {
			expandedIds.delete(id);
			collapsedIds.add(id);
		} else {
			expandAndFetch(id);
		}
	}

	/** Fetch children (if not cached), then expand the node. */
	async function expandAndFetch(id: string) {
		if (!childrenCache.has(id) && crateName && crateVersion) {
			try {
				const { children } = await Effect.runPromise(
					loadTreeChildrenEffect(crateName, crateVersion, id),
				);
				childrenCache.set(id, children);
			} catch (err) {
				log.warn`children fetch failed for ${id}: ${String(err)}`;
				return;
			}
		}
		expandedIds.add(id);
		collapsedIds.delete(id);
		cacheVersion += 1;
	}

	function collapseAll() {
		expandedIds.clear();
		collapsedIds.clear();
	}

	function expandAll() {
		if (!tree.length) return;
		const toExpand = new Set<string>();
		const stack: TreeNode[] = [...tree];
		while (stack.length) {
			const node = stack.pop();
			if (!node) break;
			const children =
				node.children === CHILDREN_PLACEHOLDER ? getChildren(node.node.id) : node.children;
			if (children.length > 0) {
				toExpand.add(node.node.id);
				for (const child of children) stack.push(child);
			}
		}
		if (toExpand.size === 0) return;
		expandedIds.clear();
		collapsedIds.clear();
		for (const id of toExpand) expandedIds.add(id);
		cacheVersion += 1;
	}

	// Track render timing
	let lastGraphId = '';
	$effect(() => {
		const gid = roots?.[0]?.node.id ?? '';
		if (gid !== lastGraphId) {
			lastGraphId = gid;
			perfTick('render', 'GraphTree tick');
		}
	});
</script>

<div class="flex h-full flex-col">
	<div class="flex items-center gap-2 border-b border-(--panel-border) px-3 py-2">
		<button
			type="button"
			class="badge badge-sm transition-colors hover:bg-(--panel-strong)"
			onclick={collapseAll}
		>
			Collapse all
		</button>
		<button
			type="button"
			class="badge badge-sm transition-colors hover:bg-(--panel-strong)"
			onclick={expandAll}
		>
			Expand all
		</button>
	</div>

	{#if tree.length === 0}
		<div class="flex-1 p-2">
			<p class="p-4 text-center text-sm text-(--muted)">
				{filter || kindFilter.size > 0 ? 'No matching items' : 'No items to display'}
			</p>
		</div>
	{:else}
		<svelte:boundary>
			<VirtualTree
				{tree}
				treeVersion={cacheVersion}
				selectedId={selId}
				{getNodeUrl}
				expandedIds={expandedIdsForRender}
				onToggleExpand={toggleExpand}
				filter={normalizedFilter}
				{kindFilter}
				resolveChildren={getChildren}
			/>
			{#snippet failed(error, reset)}
				<div class="p-4 text-sm text-(--danger)">
					<p>Tree render error</p>
					<button type="button" class="mt-1 text-(--accent) hover:underline" onclick={reset}>
						Retry
					</button>
				</div>
			{/snippet}
		</svelte:boundary>
	{/if}
</div>
