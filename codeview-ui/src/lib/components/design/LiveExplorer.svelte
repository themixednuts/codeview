<script lang="ts">
	import { browser } from '$app/environment';
	import { goto, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import type {
		KindFacet,
		Node,
		NodeKind,
		NodeSummary,
		NodeView,
		RelationshipGroup,
		TreeNodeDTO,
	} from '$lib/schema';
	import type { CrateStatusValue } from '$lib/context';
	import { SvelteSet } from 'svelte/reactivity';
	import { onMount } from 'svelte';
	import { resolveAppPath } from '$lib/app-paths';
	import {
		crateVersionsCtx,
		docLayoutCtx,
		expandPathCtx,
		resolvedThemeCtx,
	} from '$lib/context';
	import { visibilityLabel } from '$lib/display-names';
	import { toDesignNode } from '$lib/design/live-node';
	import { materializeDetailDocModel } from '$lib/detail-model';
	import { getStaticTreeChildren, getTreeChildren } from '$lib/rpc/children.remote';
	import { isHosted } from '$lib/platform';
	import { CHILDREN_PLACEHOLDER, compareTreeNodes, matchesFilter, type TreeNode } from '$lib/tree';
	import { parseExplorerState, serializeExplorerState, type ExplorerViewState } from '$lib/url-state';
	import DetailView from '$lib/components/DetailView.svelte';
	import SkeletonTree from '$lib/components/SkeletonTree.svelte';
	import DocClassic from '$lib/components/design/docs/DocClassic.svelte';
	import DocReading from '$lib/components/design/docs/DocReading.svelte';
	import DocSplit from '$lib/components/design/docs/DocSplit.svelte';
	import FocusGraphFlow from '$lib/components/design/graph/FocusGraphFlow.svelte';
	import Icon from './Icon.svelte';
	import KindBadge from './KindBadge.svelte';
	import Signature from './Signature.svelte';

	type FlatTreeNode = {
		treeNode: TreeNode;
		depth: number;
		isExpanded: boolean;
		hasChildren: boolean;
		parentId: string | undefined;
	};

	let {
		crateName,
		version,
		workspaceCrateCount,
		crateVersionOptions,
		workspaceCrates,
		loadingWorkspaceCrates,
		onVersionChange,
		debugInfo = null,
		filter,
		kindParams,
		searchQuery,
		selectedNodeId,
		treeRoots,
		canonicalCrateName,
		kindFacets,
		activeKinds,
		kindFilter,
		rootChildren = null,
		prefetchedTreeChildren = [],
		status,
		progressNodeCount,
		showGraphBlanketImpls,
		getNodeUrl,
		onToggleKind,
		onRetryTree,
		nodeView,
		nodeId,
	}: {
		crateName: string | undefined;
		version: string | undefined;
		workspaceCrateCount: number | null;
		crateVersionOptions: string[];
		workspaceCrates: Array<{ id: string; name?: string; version: string }>;
		loadingWorkspaceCrates: boolean;
		onVersionChange: (e: Event) => void;
		debugInfo?: {
			statusDebugKey: string;
			progressDebugKey: string;
		} | null;
		filter: string;
		kindParams: NodeKind[];
		searchQuery: Promise<NodeSummary[]> | null;
		selectedNodeId: string;
		treeRoots: TreeNodeDTO[] | null;
		canonicalCrateName: string | undefined;
		kindFacets: KindFacet[];
		activeKinds: Set<NodeKind>;
		kindFilter: Set<NodeKind>;
		rootChildren?: { id: string; children: TreeNodeDTO[] } | null;
		prefetchedTreeChildren?: Array<{ id: string; children: TreeNodeDTO[] }>;
		status: CrateStatusValue;
		progressNodeCount: number;
		showGraphBlanketImpls: boolean;
		getNodeUrl: (id: string) => string;
		onToggleKind: (kind: NodeKind) => void;
		onRetryTree?: (reset: () => void) => void;
		nodeView: NodeView | null;
		nodeId: string;
	} = $props();

	let hydrated = $state(false);
	const expandedIds = new SvelteSet<string>();
	const collapsedIds = new SvelteSet<string>();
	const childrenCache = new Map<string, TreeNodeDTO[]>();
	let cacheVersion = $state(0);
	let lastExpandKey: string | null = null;
	let lastCrateKey = '';
	let lastRootExpandKey = '';
	let lastReadyExpandKey = '';
	let lastReadyKey = '';
	let observedNonReady = false;

	onMount(() => {
		hydrated = true;
	});

	const viewState = $derived(parseExplorerState(page.url));
	const mode = $derived(viewState.view);
	const expandPath = $derived(expandPathCtx.getOr(null));
	const preferredDocLayout = $derived(docLayoutCtx.getOr('classic'));
	const docLayout = $derived(viewState.layout ?? preferredDocLayout);
	const theme = $derived(resolvedThemeCtx.getOr('light'));
	const crateVersions = $derived(crateVersionsCtx.getOr({}));

	const detail = $derived(nodeView?.detail ?? null);
	const selected = $derived(detail?.node ?? null);
	const ancestors = $derived(nodeView?.ancestors ?? []);
	const detailModel = $derived(materializeDetailDocModel(nodeView?.docModel, detail));
	const selectedDesign = $derived(
		selected ? toDesignNode(selected, { ancestors, getNodeUrl }) : null,
	);
	const selectedPath = $derived(selectedDesign?.path ?? selected?.id ?? selectedNodeId);
	const totalItems = $derived.by(() => {
		return kindFacets.reduce((total, facet) => total + facet.count, 0);
	});
	const populatedKinds = $derived(
		kindFacets.filter((facet) => facet.count > 0 || activeKinds.has(facet.kind)),
	);
	const selectedEdges = $derived(detailModel.selectedEdges);
	const relationshipTotal = $derived(selectedEdges.incoming.length + selectedEdges.outgoing.length);
	const relationshipGroups = $derived(
		nodeView?.relationshipGroups ?? {
			incoming: [] as RelationshipGroup[],
			outgoing: [] as RelationshipGroup[],
		},
	);
	const docSummary = $derived(docsSummary(selected?.docs));

	function loadTreeChildren(input: { name: string; version?: string; nodeId: string }) {
		return isHosted ? getStaticTreeChildren(input) : getTreeChildren(input);
	}

	async function loadChildrenBatch(
		crate: string,
		ver: string,
		nodeIds: string[],
	): Promise<Array<{ id: string; children: TreeNodeDTO[] }>> {
		const unique = [...new Set(nodeIds)].filter(Boolean);
		return Promise.all(
			unique.map(async (id) => ({
				id,
				children: await loadTreeChildren({ name: crate, version: ver, nodeId: id }),
			})),
		);
	}

	function seedServerChildren(bumpVersion: boolean) {
		let changed = false;
		if (rootChildren?.id) {
			const cached = childrenCache.get(rootChildren.id);
			const shouldRefresh =
				!cached ||
				rootChildren.children.length > cached.length ||
				(status === 'ready' && cached.length === 0 && rootChildren.children.length > 0);
			if (shouldRefresh) {
				childrenCache.set(rootChildren.id, rootChildren.children);
				changed = true;
			}
			if (!collapsedIds.has(rootChildren.id) && !expandedIds.has(rootChildren.id)) {
				expandedIds.add(rootChildren.id);
				changed = true;
			}
		}

		for (const seed of prefetchedTreeChildren ?? []) {
			if (!seed.id) continue;
			if (childrenCache.get(seed.id) !== seed.children) {
				childrenCache.set(seed.id, seed.children);
				changed = true;
			}
			if (!collapsedIds.has(seed.id) && !expandedIds.has(seed.id)) {
				expandedIds.add(seed.id);
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
		if (showGraphBlanketImpls) return true;
		if (node.id === selectedNodeId) return true;
		return !isBlanketImplNode(node);
	}

	function visibleTreeDtos(items: TreeNodeDTO[]): TreeNodeDTO[] {
		if (showGraphBlanketImpls) return items;
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

	function getChildren(parentId: string): TreeNode[] {
		const cached = childrenCache.get(parentId);
		if (!cached) return [];
		return visibleTreeDtos(cached).map(dtoToTreeNode).sort(compareTreeNodes);
	}

	const parentMap = $derived.by(() => {
		void cacheVersion;
		const map = new Map<string, string>();
		for (const [parentId, children] of childrenCache) {
			for (const child of children) map.set(child.node.id, parentId);
		}
		return map;
	});

	const baseTree = $derived(
		treeRoots?.length ? visibleTreeDtos(treeRoots).map(dtoToTreeNode).sort(compareTreeNodes) : [],
	);
	const normalizedFilter = $derived(filter.trim().toLowerCase());
	const tree = $derived.by(() => {
		if (!baseTree.length) return [] as TreeNode[];
		if (!normalizedFilter && kindFilter.size === 0) return baseTree;
		return filterTree(baseTree, normalizedFilter, kindFilter);
	});
	const selectedAncestorIds = $derived.by(() => {
		if (!selectedNodeId) return [] as string[];
		const ids = new Set(ancestors.map((ancestor) => ancestor.id));
		let current = selectedNodeId;
		while (parentMap.has(current)) {
			const parentId = parentMap.get(current)!;
			ids.add(parentId);
			current = parentId;
		}
		return Array.from(ids);
	});
	const selectedAncestorSet = $derived(new Set(selectedAncestorIds));
	const expandedIdsForRender = $derived.by(() => {
		const result = new Set<string>();
		for (const id of viewState.ex) {
			if (!collapsedIds.has(id)) result.add(id);
		}
		for (const id of expandedIds) {
			if (!collapsedIds.has(id)) result.add(id);
		}
		for (const id of selectedAncestorIds) {
			if (!collapsedIds.has(id)) result.add(id);
		}
		return result;
	});
	const flatTree = $derived.by(() => flattenTree(tree, expandedIdsForRender));

	$effect(() => {
		const key = `${canonicalCrateName ?? crateName ?? ''}@${version ?? ''}`;
		if (!key || key === '@' || key === lastCrateKey) return;
		if (lastCrateKey) {
			childrenCache.clear();
			expandedIds.clear();
			collapsedIds.clear();
			lastExpandKey = null;
			cacheVersion += 1;
		}
		observedNonReady = status !== 'ready';
		lastReadyKey = status === 'ready' ? key : '';
		lastCrateKey = key;
	});

	$effect(() => {
		if (!canonicalCrateName || !version) return;
		if (!baseTree.length) return;
		if (filter || kindFilter.size > 0) return;
		const rootId = baseTree[0]?.node.id;
		if (!rootId) return;
		if (selectedNodeId && selectedNodeId !== rootId) return;
		if (expandedIds.size > 0 || collapsedIds.has(rootId)) return;
		const key = `${canonicalCrateName}@${version}:${rootId}`;
		if (lastRootExpandKey === key) return;
		lastRootExpandKey = key;
		void expandAndFetch(rootId);
	});

	$effect(() => {
		if (!canonicalCrateName || !version) return;
		if (status !== 'ready') {
			observedNonReady = true;
			return;
		}
		const key = `${canonicalCrateName}@${version}`;
		if (!observedNonReady) {
			lastReadyKey = key;
			return;
		}
		if (lastReadyKey === key) return;
		lastReadyKey = key;
		const expanded = Array.from(expandedIds);
		for (const id of expanded) childrenCache.delete(id);
		if (expanded.length > 0) cacheVersion += 1;
		for (const id of expanded) void expandAndFetch(id);
	});

	$effect(() => {
		if (!canonicalCrateName || !version) return;
		if (status !== 'ready') return;
		if (filter || kindFilter.size > 0) return;
		if (!baseTree.length) return;
		if (expandedIds.size > 0) return;
		const rootId = baseTree[0]?.node.id;
		if (!rootId || collapsedIds.has(rootId)) return;
		const key = `${canonicalCrateName}@${version}:${rootId}`;
		if (lastReadyExpandKey === key) return;
		lastReadyExpandKey = key;
		void expandAndFetch(rootId);
	});

	$effect(() => {
		if (!selectedNodeId || !canonicalCrateName || !version) return;
		const pathIds = expandPath?.ancestors.map((ancestor) => ancestor.id) ?? ancestors.map((a) => a.id);
		const key = `${selectedNodeId}:${pathIds.join('/')}`;
		if (key === lastExpandKey) return;
		lastExpandKey = key;
		if (pathIds.length > 0) {
			void fetchAndExpand(pathIds, canonicalCrateName, version);
		} else if (hydrated && selectedNodeId === baseTree[0]?.node.id) {
			void expandAndFetch(selectedNodeId);
		}
	});

	function filterTree(trees: TreeNode[], currentFilter: string, currentKinds: Set<NodeKind>): TreeNode[] {
		const result: TreeNode[] = [];
		for (const item of trees) {
			const filtered = filterTreeNode(item, currentFilter, currentKinds);
			if (filtered) result.push(filtered);
		}
		return result;
	}

	function filterTreeNode(
		treeNode: TreeNode,
		currentFilter: string,
		currentKinds: Set<NodeKind>,
	): TreeNode | null {
		const children =
			treeNode.children === CHILDREN_PLACEHOLDER ? getChildren(treeNode.node.id) : treeNode.children;
		const filteredChildren: TreeNode[] = [];
		for (const child of children) {
			const filtered = filterTreeNode(child, currentFilter, currentKinds);
			if (filtered) filteredChildren.push(filtered);
		}
		const selfMatches = matchesFilter(treeNode.node, currentFilter, currentKinds);
		if (!selfMatches && filteredChildren.length === 0) return null;
		return {
			node: treeNode.node,
			selectable: treeNode.selectable,
			children:
				filteredChildren.length || treeNode.children !== CHILDREN_PLACEHOLDER
					? filteredChildren
					: treeNode.children,
		};
	}

	function flattenTree(items: TreeNode[], expanded: Set<string>): FlatTreeNode[] {
		void cacheVersion;
		const result: FlatTreeNode[] = [];
		function visit(nodes: TreeNode[], depth: number, parentId: string | undefined) {
			for (const treeNode of nodes) {
				const hasChildren = treeNode.children.length > 0;
				const isExpanded = expanded.has(treeNode.node.id);
				result.push({ treeNode, depth, isExpanded, hasChildren, parentId });
				if (!hasChildren || !isExpanded) continue;
				const children =
					treeNode.children === CHILDREN_PLACEHOLDER ? getChildren(treeNode.node.id) : treeNode.children;
				visit(children, depth + 1, treeNode.node.id);
			}
		}
		visit(items, 0, undefined);
		return result;
	}

	async function fetchAndExpand(pathIds: string[], crate: string, ver: string) {
		const allIds = [...new Set([...pathIds, ...viewState.ex, ...expandedIds])];
		const idsToFetch = allIds.filter((id) => !childrenCache.has(id));
		if (idsToFetch.length > 0) {
			try {
				const results = await loadChildrenBatch(crate, ver, idsToFetch);
				for (const { id, children } of results) childrenCache.set(id, children);
			} catch {
				return;
			}
		}
		for (const id of pathIds) {
			expandedIds.add(id);
			collapsedIds.delete(id);
		}
		cacheVersion += 1;
	}

	async function expandAndFetch(id: string) {
		if (!childrenCache.has(id) && canonicalCrateName && version) {
			try {
				const children = await loadTreeChildren({
					name: canonicalCrateName,
					version,
					nodeId: id,
				});
				childrenCache.set(id, children);
			} catch {
				return;
			}
		}
		expandedIds.add(id);
		collapsedIds.delete(id);
		cacheVersion += 1;
	}

	async function expandAndFetchPersisted(id: string) {
		await expandAndFetch(id);
		if (expandedIds.has(id)) writeExpandedIdsToUrl();
	}

	function toggleExpand(id: string) {
		if (expandedIdsForRender.has(id)) {
			expandedIds.delete(id);
			collapsedIds.add(id);
			cacheVersion += 1;
			writeExpandedIdsToUrl();
		} else {
			void expandAndFetchPersisted(id);
		}
	}

	function collapseAll() {
		expandedIds.clear();
		collapsedIds.clear();
		cacheVersion += 1;
		writeExpandedIdsToUrl();
	}

	function expandLoaded() {
		for (const row of flatTree) {
			if (row.hasChildren) {
				expandedIds.add(row.treeNode.node.id);
				collapsedIds.delete(row.treeNode.node.id);
			}
		}
		cacheVersion += 1;
		writeExpandedIdsToUrl();
	}

	function updateExplorerState(patch: Partial<ExplorerViewState>) {
		void goto(serializeExplorerState(page.url, patch), {
			replaceState: true,
			noScroll: true,
			keepFocus: true,
		});
	}

	function replaceExplorerState(patch: Partial<ExplorerViewState>) {
		if (!browser) return;
		replaceState(serializeExplorerState(page.url, patch), page.state);
	}

	function currentExtraExpandedIds(): string[] {
		const ancestorSet = new Set(selectedAncestorIds);
		if (expandPath) {
			for (const ancestor of expandPath.ancestors) ancestorSet.add(ancestor.id);
		}
		const expanded = new Set([...viewState.ex, ...expandedIds]);
		const extra: string[] = [];
		for (const id of expanded) {
			if (collapsedIds.has(id)) continue;
			if (id !== selectedNodeId && !ancestorSet.has(id)) extra.push(id);
		}
		extra.sort();
		return extra;
	}

	function writeExpandedIdsToUrl() {
		replaceExplorerState({ ex: currentExtraExpandedIds() });
	}

	function submitFilter(event: SubmitEvent) {
		event.preventDefault();
		const form = event.currentTarget;
		if (!(form instanceof HTMLFormElement)) return;
		const raw = new FormData(form).get('q');
		updateExplorerState({ q: typeof raw === 'string' ? raw : '' });
	}

	function docsSummary(docs: string | null | undefined): string | null {
		if (!docs) return null;
		const first = docs
			.trim()
			.split(/\n\s*\n/, 1)[0]
			?.replace(/\s+/g, ' ')
			.trim();
		if (!first) return null;
		return first.length > 220 ? `${first.slice(0, 217)}...` : first;
	}
</script>

{#snippet modeButton(nextMode: 'graph' | 'docs', label: string, icon: 'link' | 'hash')}
	<button
		type="button"
		class="flex items-center gap-1 rounded px-2.5 py-0.5 text-[11.5px] transition-colors {mode ===
		nextMode
			? 'bg-(--panel-solid) text-(--ink) shadow-(--shadow-soft)'
			: 'text-(--muted)'}"
		aria-pressed={mode === nextMode}
		onclick={() => updateExplorerState({ view: nextMode })}
	>
		<Icon name={icon} size={11} />
		{label}
	</button>
{/snippet}

{#snippet searchResultRow(node: NodeSummary)}
	{@const isSelected = selectedNodeId === node.id}
	<a
		href={resolveAppPath(getNodeUrl(node.id))}
		data-sveltekit-noscroll
		data-sveltekit-keepfocus
		aria-current={isSelected ? 'page' : undefined}
		class="group flex items-center gap-2 rounded-md px-2.5 py-1.5 transition-colors hover:bg-(--panel-muted) {isSelected
			? 'bg-(--accent-soft)'
			: ''}"
	>
		<KindBadge kind={node.kind} size={14} />
		<span class="min-w-0 flex-1">
			<span
				class="mono block truncate text-[12px] font-semibold {isSelected
					? 'text-(--accent-strong)'
					: 'text-(--ink-soft)'}"
			>
				{node.name}
			</span>
			<span class="mono block truncate text-[10px] text-(--muted-soft)">{node.id}</span>
		</span>
	</a>
{/snippet}

{#snippet treeRow(row: FlatTreeNode)}
	{@const node = row.treeNode.node}
	{@const isSelected = selectedNodeId === node.id}
	{@const isAncestor = selectedAncestorSet.has(node.id)}
	{@const href = resolveAppPath(getNodeUrl(node.id))}
	<div
		role="treeitem"
		aria-level={row.depth + 1}
		aria-current={isSelected ? 'page' : undefined}
		aria-selected={isSelected}
		aria-expanded={row.hasChildren ? row.isExpanded : undefined}
		class="group relative flex min-h-8 items-center gap-1.5 rounded-md pr-2 transition-colors hover:bg-(--panel-muted) {isSelected
			? 'bg-(--accent-soft)'
			: ''}"
		style={`padding-left: ${8 + row.depth * 14}px`}
	>
		{#if row.depth > 0}
			<span
				class="absolute top-0 bottom-0 w-px"
				style={`left: ${4 + row.depth * 14 - 8}px; background: ${isSelected ? 'var(--accent)' : 'var(--panel-border-soft)'}`}
			></span>
		{/if}
		{#if row.hasChildren}
			<button
				type="button"
				class="grid size-5 shrink-0 place-items-center rounded text-(--muted-soft) hover:bg-(--panel-solid) hover:text-(--ink)"
				aria-label={row.isExpanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
				aria-expanded={row.isExpanded}
				onclick={(event) => {
					event.preventDefault();
					event.stopPropagation();
					toggleExpand(node.id);
				}}
			>
				<Icon name={row.isExpanded ? 'chevron-down' : 'chevron-right'} size={13} />
			</button>
		{:else}
			<span class="size-5 shrink-0"></span>
		{/if}
		<a
			href={href}
			data-sveltekit-noscroll
			data-sveltekit-keepfocus
			class="flex min-w-0 flex-1 items-center gap-2 self-stretch text-left no-underline"
		>
			<KindBadge kind={node.kind} size={14} />
			<span
				class="mono min-w-0 flex-1 truncate text-[12px]"
				class:line-through={node.is_deprecated}
				style={`color: ${
					isSelected
						? 'var(--accent-strong)'
						: isAncestor
							? 'var(--ink)'
							: 'var(--ink-soft)'
				}; font-weight: ${isSelected ? 700 : isAncestor ? 600 : 500}`}
			>
				{node.name}
			</span>
			{#if node.visibility.kind === 'Public'}
				<span class="mono shrink-0 text-[9.5px] font-semibold text-(--accent-strong)">pub</span>
			{/if}
		</a>
	</div>
{/snippet}

{#snippet relationshipList(title: string, count: number, groups: RelationshipGroup[])}
	<div>
		<div class="mb-2 flex items-center justify-between px-1.5">
			<span class="text-[11px] font-semibold tracking-[0.16em] text-(--muted-soft) uppercase">
				{title}
			</span>
			<span class="mono text-[10.5px] text-(--muted-soft)">{count}</span>
		</div>
		{#if groups.length}
			<div class="space-y-3">
				{#each groups as group (group.rel)}
					<div>
						<div class="mb-1 flex items-center gap-2 px-1.5">
							<span class="mono text-[10px] font-semibold tracking-[0.16em] uppercase" style={`color: ${group.color}`}>
								{group.label}
							</span>
							<span class="h-px flex-1 bg-(--panel-border-soft)"></span>
						</div>
						<div class="space-y-px">
							{#each group.items.slice(0, 8) as item (item.node.id)}
								<a
									href={resolveAppPath(getNodeUrl(item.node.id))}
									data-sveltekit-noscroll
									class="flex items-center gap-2 rounded-md px-1.5 py-1.5 transition-colors hover:bg-(--panel-muted)"
								>
									<KindBadge kind={item.node.kind} size={13} />
									<span class="mono min-w-0 flex-1 truncate text-[11.5px] font-semibold text-(--ink-soft)">
										{item.node.name}
									</span>
									{#if item.count > 1}
										<span class="mono text-[10px] text-(--muted-soft)">{item.count}</span>
									{/if}
								</a>
							{/each}
							{#if group.items.length > 8}
								<div class="mono px-1.5 py-1 text-[10.5px] text-(--muted-soft)">
									+{group.items.length - 8} more
								</div>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		{:else}
			<p class="mono px-1.5 py-2 text-[11.5px] text-(--muted-soft)">None recorded.</p>
		{/if}
	</div>
{/snippet}

<div class="live-explorer flex min-h-0 flex-1 flex-col overflow-hidden bg-(--bg)">
	<div
		class="flex min-h-12 items-center gap-3 border-b border-(--panel-border-soft) bg-(--panel) px-4"
	>
		<div class="flex min-w-0 items-center gap-2">
			{#if selected}
				<KindBadge kind={selected.kind} size={16} />
			{/if}
			<nav aria-label="Node path" class="mono flex min-w-0 flex-wrap items-baseline gap-1 text-[13px]">
				{#each ancestors as ancestor, index (ancestor.id)}
					<a
						href={resolveAppPath(getNodeUrl(ancestor.id))}
						data-sveltekit-noscroll
						class="truncate text-(--link) underline decoration-(--panel-border-strong) underline-offset-2"
					>
						{ancestor.name}
					</a>
					<span class="text-(--muted-soft)">::</span>
				{/each}
				{#if selected}
					<span class="truncate font-bold text-(--ink)" aria-current="page">{selected.name}</span>
				{:else}
					<span class="text-(--muted)">Loading...</span>
				{/if}
			</nav>
		</div>
		<div class="ml-auto flex items-center gap-2">
			<span class="mono hidden text-[11px] text-(--muted-soft) sm:inline">
				{relationshipTotal} relationships
			</span>
			<div
				class="flex items-center rounded-md border border-(--panel-border-soft) bg-(--panel-muted) p-0.5"
				aria-label="Explorer mode"
			>
				{@render modeButton('graph', 'Graph', 'link')}
				{@render modeButton('docs', 'Docs', 'hash')}
			</div>
		</div>
	</div>

	<div class="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)_344px]">
		<aside
			class="flex min-h-0 flex-col overflow-hidden border-b border-(--panel-border-soft) bg-(--panel) lg:border-r lg:border-b-0"
			aria-label="Module tree"
		>
			<div class="border-b border-(--panel-border-soft) px-4 pt-4 pb-3">
				<div class="mb-1 text-[10px] font-semibold tracking-[0.22em] text-(--muted-soft) uppercase">
					Module tree
				</div>
				<div class="flex min-w-0 items-center gap-2">
					<a
						href={canonicalCrateName && version ? resolveAppPath(`/${canonicalCrateName}/${version}`) : '#'}
						class="font-display min-w-0 truncate text-[15px] font-semibold text-(--ink)"
					>
						{canonicalCrateName ?? crateName ?? 'crate'}
					</a>
					{#if crateVersionOptions.length > 0}
						<select
							class="mono corner-squircle max-w-28 rounded-(--radius-control) border border-(--panel-border) bg-(--panel-solid) px-1.5 py-0.5 text-[10.5px] text-(--muted)"
							aria-label="Crate version"
							value={version}
							onchange={onVersionChange}
						>
							{#each crateVersionOptions as option (option)}
								<option value={option}>v{option}</option>
							{/each}
						</select>
					{/if}
				</div>
				<div class="mono mt-0.5 text-[10.5px] text-(--muted-soft)">
					{#if totalItems > 0}
						{totalItems.toLocaleString()} items
					{:else if workspaceCrateCount != null}
						{workspaceCrateCount.toLocaleString()} workspace crates
					{:else if status === 'processing'}
						{progressNodeCount.toLocaleString()} items discovered
					{:else}
						Index pending
					{/if}
				</div>
				<form
					method="get"
					class="relative mt-3"
					data-sveltekit-replacestate
					data-sveltekit-keepfocus
					data-sveltekit-noscroll
					onsubmit={submitFilter}
				>
					<input
						type="search"
						name="q"
						placeholder="Filter items..."
						value={filter}
						class="mono w-full rounded-md border border-(--panel-border) bg-(--panel-solid) py-1.5 pr-2 pl-7 text-[11.5px] text-(--ink) outline-none focus:border-(--accent) focus:ring-1 focus:ring-(--accent)"
					/>
					<span class="absolute top-1/2 left-2 -translate-y-1/2 text-(--muted-soft)">
						<Icon name="search" size={12} />
					</span>
					{#each kindParams as kind (kind)}
						<input type="hidden" name="k" value={kind} />
					{/each}
					{#if showGraphBlanketImpls}
						<input type="hidden" name="gbi" value="1" />
					{/if}
				</form>
				{#if populatedKinds.length > 0}
					<div class="mt-2 flex flex-wrap gap-1">
						{#each populatedKinds as facet (facet.kind)}
							{@const isActive = activeKinds.has(facet.kind)}
							<button
								type="button"
								class="badge badge-sm transition-colors hover:bg-(--panel-strong) hover:text-(--ink)"
								class:badge-accent={isActive}
								aria-pressed={isActive}
								onclick={() => onToggleKind(facet.kind)}
							>
								{facet.label}
							</button>
						{/each}
					</div>
				{/if}
				{#if debugInfo}
					<div class="mono mt-2 rounded-sm border border-(--panel-border) bg-(--panel-solid) px-2 py-1 text-[10px] text-(--muted)">
						<div>{debugInfo.statusDebugKey}</div>
						<div>{debugInfo.progressDebugKey}</div>
					</div>
				{/if}
			</div>

			<div class="flex min-h-0 flex-1 flex-col">
				{#if filter && searchQuery}
					<svelte:boundary>
						{@const results = await searchQuery}
						<div class="min-h-0 flex-1 overflow-y-auto px-2.5 py-3">
							<div class="mono mb-1 px-2 text-[10.5px] text-(--muted-soft)">
								{results.length} result{results.length === 1 ? '' : 's'}
							</div>
							{#each results as node (node.id)}
								{@render searchResultRow(node)}
							{:else}
								<p class="px-2 py-3 text-sm text-(--muted)">No results for "{filter}"</p>
							{/each}
						</div>
						{#snippet pending()}
							<SkeletonTree count={8} showKindBadges={true} />
						{/snippet}
						{#snippet failed(_error, reset)}
							<div class="p-4 text-sm text-(--danger)">
								<p class="font-medium">Search failed</p>
								<button type="button" class="mt-2 text-(--accent) hover:underline" onclick={reset}>
									Try again
								</button>
							</div>
						{/snippet}
					</svelte:boundary>
				{:else if treeRoots && treeRoots.length > 0}
					<div
						class="flex items-center gap-2 border-b border-(--panel-border-soft) px-3 py-2"
						aria-label="Tree actions"
					>
						<button
							type="button"
							class="badge badge-sm transition-colors hover:bg-(--panel-strong)"
							onclick={collapseAll}
						>
							Collapse
						</button>
						<button
							type="button"
							class="badge badge-sm transition-colors hover:bg-(--panel-strong)"
							onclick={expandLoaded}
						>
							Expand loaded
						</button>
					</div>
					<div class="min-h-0 flex-1 overflow-y-auto px-2.5 py-3" role="tree" aria-label="Crate modules">
						{#each flatTree as row (`${row.parentId ?? 'root'}::${row.treeNode.node.id}`)}
							{@render treeRow(row)}
						{:else}
							<p class="p-4 text-center text-sm text-(--muted)">
								{filter || kindFilter.size > 0 ? 'No matching items' : 'No items to display'}
							</p>
						{/each}
					</div>
				{:else if status === 'processing' || status === 'unknown'}
					<SkeletonTree count={progressNodeCount || 24} showKindBadges={false} />
				{:else}
					<div class="p-8 text-center">
						<div class="text-sm font-medium text-(--ink)">No data available</div>
						<div class="mt-1 text-xs text-(--muted)">This crate's tree has not loaded yet.</div>
						{#if onRetryTree}
							<button type="button" class="mt-3 text-sm text-(--accent) hover:underline" onclick={() => onRetryTree?.(() => {})}>
								Try again
							</button>
						{/if}
					</div>
				{/if}
			</div>

			{#if workspaceCrates.length > 0 || loadingWorkspaceCrates}
				<div class="border-t border-(--panel-border-soft) px-4 py-3">
					<div class="mb-2 flex items-center gap-2">
						<span class="text-[9.5px] font-semibold tracking-[0.18em] text-(--muted-soft) uppercase">
							Workspace
						</span>
						<span class="h-px flex-1 bg-(--panel-border-soft)"></span>
					</div>
					{#if loadingWorkspaceCrates}
						<p class="mono text-[11px] text-(--muted-soft)">Loading crates...</p>
					{:else}
						<div class="max-h-24 overflow-y-auto">
							{#each workspaceCrates.slice(0, 6) as item (item.id)}
								<a
									href={resolveAppPath(`/${item.id}/${item.version}`)}
									class="mono block truncate rounded px-1.5 py-1 text-[11px] text-(--muted) hover:bg-(--panel-muted) hover:text-(--ink)"
								>
									{item.name ?? item.id}@{item.version}
								</a>
							{/each}
						</div>
					{/if}
				</div>
			{/if}
		</aside>

		<section class="relative min-h-0 overflow-auto bg-(--bg)" aria-label="Node content">
			{#if mode === 'graph' && detail}
				<FocusGraphFlow
					{detail}
					{ancestors}
					crateName={canonicalCrateName ?? crateName ?? ''}
					crateVersion={version ?? ''}
					{getNodeUrl}
					height={620}
				/>
			{:else if detail && selected && selected.kind !== 'Crate'}
				{#if docLayout === 'reading'}
					<DocReading
						{detail}
						{ancestors}
						model={detailModel}
						{theme}
						{getNodeUrl}
						crateName={canonicalCrateName ?? crateName}
						crateVersion={version}
						{crateVersions}
					/>
				{:else if docLayout === 'split'}
					<DocSplit
						{detail}
						{ancestors}
						model={detailModel}
						{theme}
						{getNodeUrl}
						crateName={canonicalCrateName ?? crateName}
						crateVersion={version}
						{crateVersions}
					/>
				{:else}
					<DocClassic
						{detail}
						{ancestors}
						model={detailModel}
						{theme}
						{getNodeUrl}
						crateName={canonicalCrateName ?? crateName}
						crateVersion={version}
						{crateVersions}
					/>
				{/if}
			{:else}
				<DetailView {nodeId} embedded />
			{/if}
		</section>

		<aside
			class="hidden min-h-0 flex-col overflow-hidden border-l border-(--panel-border-soft) bg-(--panel) lg:flex"
			aria-label="Selected item details"
		>
			{#if selected && selectedDesign}
				<div class="border-b border-(--panel-border-soft) px-5 pt-5 pb-4">
					<div class="mb-2 flex items-center gap-2">
						<span
							class="mono rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.14em] uppercase"
							style="background: var(--accent-soft); color: var(--accent-strong)"
						>
							{selectedDesign.kindLabel}
						</span>
						{#if selectedDesign.external}
							<span class="mono rounded bg-(--panel-muted) px-1.5 py-0.5 text-[10px] text-(--muted)">
								external
							</span>
						{/if}
						<span class="mono ml-auto text-[10.5px] text-(--muted-soft)">
							{visibilityLabel(selected.visibility)}
						</span>
					</div>
					<h2
						class="font-display truncate text-[26px] leading-none font-semibold tracking-tight text-(--ink)"
						title={selected.name}
					>
						{selected.name}
					</h2>
					<div class="mono mt-2 truncate text-[11px] text-(--muted-soft)" title={selectedPath}>
						{selectedPath}
					</div>
					{#if docSummary}
						<p class="mt-3 line-clamp-4 text-[13px] leading-relaxed text-(--muted)">
							{docSummary}
						</p>
					{/if}
					{#if selected.signature}
						<div class="mt-3 overflow-hidden rounded-md border border-(--panel-border-soft)">
							<Signature node={selected} form="multiline" variant="flat" />
						</div>
					{/if}
					<div class="mt-4 grid grid-cols-2 gap-2">
						<div class="rounded-md border border-(--panel-border-soft) bg-(--panel-solid) px-3 py-2">
							<div class="mono text-[10px] text-(--muted-soft)">outgoing</div>
							<div class="mono text-[18px] font-semibold text-(--ink)">
								{selectedEdges.outgoing.length}
							</div>
						</div>
						<div class="rounded-md border border-(--panel-border-soft) bg-(--panel-solid) px-3 py-2">
							<div class="mono text-[10px] text-(--muted-soft)">incoming</div>
							<div class="mono text-[18px] font-semibold text-(--ink)">
								{selectedEdges.incoming.length}
							</div>
						</div>
					</div>
				</div>
				<div class="min-h-0 flex-1 overflow-y-auto px-3.5 py-4">
					{@render relationshipList('Outgoing', selectedEdges.outgoing.length, relationshipGroups.outgoing)}
					<div class="mt-5">
						{@render relationshipList('Incoming', selectedEdges.incoming.length, relationshipGroups.incoming)}
					</div>
				</div>
				<div class="flex items-center gap-2 border-t border-(--panel-border-soft) px-5 py-3">
					<button
						type="button"
						class="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-(--accent) py-1.5 text-[12px] font-medium text-(--on-accent)"
						onclick={() => updateExplorerState({ view: 'docs' })}
					>
						Open docs
						<Icon name="arrow-right" size={11} />
					</button>
					<a
						href={resolveAppPath(getNodeUrl(selected.id))}
						data-sveltekit-noscroll
						class="rounded-md border border-(--panel-border) bg-(--panel-solid) px-3 py-1.5 text-[12px] text-(--ink-soft)"
					>
						Permalink
					</a>
				</div>
			{:else}
				<div class="flex h-full items-center justify-center p-6 text-center text-sm text-(--muted)">
					Selected item details are unavailable.
				</div>
			{/if}
		</aside>
	</div>
</div>
