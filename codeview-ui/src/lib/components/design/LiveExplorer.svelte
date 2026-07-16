<script lang="ts">
	import { browser } from '$app/environment';
	import { afterNavigate, goto, invalidateAll, replaceState } from '$app/navigation';
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
	import { onDestroy, onMount } from 'svelte';
	import type { Attachment } from 'svelte/attachments';
	import { resolveAppPath } from '$lib/app-paths';
	import { crateVersionsCtx, docLayoutCtx, expandPathCtx, resolvedThemeCtx } from '$lib/context';
	import { nodeKindOrder, visibilityLabel } from '$lib/display-names';
	import { toDesignNode } from '$lib/design/live-node';
	import { buildNodeRelationshipGroups } from '$lib/design/relationship-groups';
	import { materializeDetailDocModel } from '$lib/detail-model';
	import { getStaticTreeChildren, getTreeChildren } from '$lib/rpc/children.remote';
	import { searchNodes } from '$lib/rpc/search.remote';
	import { isHosted } from '$lib/platform';
	import { CHILDREN_PLACEHOLDER, compareTreeNodes, matchesFilter, type TreeNode } from '$lib/tree';
	import {
		parseExplorerState,
		serializeExplorerState,
		type ExplorerDocLayout,
		type ExplorerViewState,
		type ExplorerViewMode,
	} from '$lib/url-state';
	import SkeletonTree from '$lib/components/SkeletonTree.svelte';
	import * as Resizable from '$lib/shadcn/ui/resizable/index.js';
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
		crateListCount,
		crateVersionOptions,
		crateList,
		crateSwitcherLabel,
		loadingCrateSwitcher,
		onVersionChange,
		debugInfo = null,
		filter,
		kindParams,
		selectedNodeId,
		treeRoots,
		canonicalCrateName,
		kindFacets,
		rootChildren = null,
		prefetchedTreeChildren = [],
		status,
		progressNodeCount,
		showGraphBlanketImpls,
		getNodeUrl,
		onRetryTree,
		nodeView,
		nodeId,
	}: {
		crateName: string | undefined;
		version: string | undefined;
		crateListCount: number | null;
		crateVersionOptions: string[];
		crateList: Array<{ id: string; name?: string; version: string }>;
		crateSwitcherLabel: string;
		loadingCrateSwitcher: boolean;
		onVersionChange: (e: Event) => void;
		debugInfo?: {
			statusDebugKey: string;
			progressDebugKey: string;
		} | null;
		filter: string;
		kindParams: NodeKind[];
		selectedNodeId: string;
		treeRoots: TreeNodeDTO[] | null;
		canonicalCrateName: string | undefined;
		kindFacets: KindFacet[];
		rootChildren?: { id: string; children: TreeNodeDTO[] } | null;
		prefetchedTreeChildren?: Array<{ id: string; children: TreeNodeDTO[] }>;
		status: CrateStatusValue;
		progressNodeCount: number;
		showGraphBlanketImpls: boolean;
		getNodeUrl: (id: string) => string;
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
	let treeFilterInput = $state<HTMLInputElement | null>(null);
	let localViewOverride = $state<ExplorerViewMode | null>(null);
	let localDocLayoutOverride = $state<ExplorerDocLayout | null>(null);
	let localOverrideRouteKey = $state<string | null>(null);
	let treeNavigationTimer: ReturnType<typeof setTimeout> | null = null;
	let filterInputTimer: ReturnType<typeof setTimeout> | null = null;
	let filterDraftOverride = $state<string | null>(null);
	let filterOverride = $state<string | null>(null);
	let kindOverride = $state.raw<NodeKind[] | null>(null);

	const attachTreeFilterInput: Attachment<HTMLInputElement> = (node) => {
		treeFilterInput = node;
		return () => {
			if (treeFilterInput === node) treeFilterInput = null;
		};
	};

	function handleDocLayoutPreferenceEvent(event: Event) {
		const nextLayout = (event as CustomEvent<ExplorerDocLayout>).detail;
		if (!nextLayout) return;
		localViewOverride = 'docs';
		localDocLayoutOverride = nextLayout;
	}

	// A real navigation has authoritative URL state. replaceState updates stay
	// immediate through the local overrides below and do not trigger this hook.
	afterNavigate(() => {
		filterOverride = null;
		kindOverride = null;
		filterDraftOverride = null;
	});

	onMount(() => {
		hydrated = true;
		window.addEventListener('keydown', handleExplorerKeydown);
		window.addEventListener('codeview-doc-layout-change', handleDocLayoutPreferenceEvent);
		return () => {
			window.removeEventListener('keydown', handleExplorerKeydown);
			window.removeEventListener('codeview-doc-layout-change', handleDocLayoutPreferenceEvent);
		};
	});

	onDestroy(() => {
		clearTreeNavigationTimer();
		clearFilterInputTimer();
	});

	const viewState = $derived(parseExplorerState(page.url));
	const mode = $derived(localViewOverride ?? viewState.view);
	const graphHref = $derived.by(() => {
		const url = serializeExplorerState(page.url, { view: 'graph' });
		url.hash = '';
		return `${url.pathname}${url.search}`;
	});
	const docsHref = $derived.by(() => {
		const url = serializeExplorerState(page.url, { view: 'docs' });
		url.hash = '';
		return `${url.pathname}${url.search}`;
	});
	const expandPath = $derived(expandPathCtx.getOr(null));
	const preferredDocLayout = $derived(docLayoutCtx.getOr('classic'));
	const docLayout = $derived(localDocLayoutOverride ?? viewState.layout ?? preferredDocLayout);
	const theme = $derived(resolvedThemeCtx.getOr('light'));
	const crateVersions = $derived(crateVersionsCtx.getOr({}));

	const detail = $derived(nodeView?.detail ?? null);
	const selected = $derived(detail?.node ?? null);
	const ancestors = $derived(nodeView?.ancestors ?? []);
	const detailModel = $derived(materializeDetailDocModel(detail));
	const selectedDesign = $derived(
		selected ? toDesignNode(selected, { ancestors, getNodeUrl }) : null,
	);
	const selectedPath = $derived(selectedDesign?.path ?? selected?.id ?? selectedNodeId);
	const filterDraft = $derived(filterDraftOverride ?? filter);
	const activeFilter = $derived(filterOverride ?? filter);
	const effectiveKindParams = $derived(
		(kindOverride ?? kindParams).filter((kind) => kind !== 'Impl'),
	);
	const kindFilter = $derived.by(() => new Set<NodeKind>(effectiveKindParams));
	const totalItems = $derived.by(() => {
		return kindFacets.reduce((total, facet) => total + facet.count, 0);
	});
	const populatedKinds = $derived(
		kindFacets.filter(
			(facet) => facet.kind !== 'Impl' && (facet.count > 0 || kindFilter.has(facet.kind)),
		),
	);
	const selectedEdges = $derived(detailModel.selectedEdges);
	const relationshipGroups = $derived(buildNodeRelationshipGroups(detail, selectedEdges));
	const relationshipTotal = $derived.by(() =>
		[...relationshipGroups.incoming, ...relationshipGroups.outgoing].reduce(
			(total, group) =>
				total + group.items.reduce((groupTotal, item) => groupTotal + item.count, 0),
			0,
		),
	);
	const docSummary = $derived(docsSummary(selected?.docs));
	const searchQuery = $derived(
		activeFilter.trim() || effectiveKindParams.length > 0
			? searchNodes({
					crate: canonicalCrateName ?? crateName,
					version,
					q: activeFilter,
					kinds: effectiveKindParams,
				})
			: null,
	);
	const searchResults = $derived(searchQuery?.current ?? []);
	const searchLoading = $derived(searchQuery?.loading ?? false);
	const searchError = $derived.by(() => {
		const error = searchQuery?.error;
		return error ? (error instanceof Error ? error.message : String(error)) : null;
	});
	const hasActiveTreeFilter = $derived(Boolean(activeFilter.trim()) || kindFilter.size > 0);
	const emptySearchMessage = $derived(
		activeFilter ? `No results for "${activeFilter}"` : 'No items match these filters',
	);
	$effect(() => {
		const key = `${canonicalCrateName ?? crateName ?? ''}:${version ?? ''}:${selectedNodeId}`;
		if (localOverrideRouteKey === null) {
			localOverrideRouteKey = key;
			return;
		}
		if (key === localOverrideRouteKey) return;
		localOverrideRouteKey = key;
		localViewOverride = null;
		localDocLayoutOverride = null;
		filterOverride = null;
		kindOverride = null;
		filterDraftOverride = null;
	});

	function loadTreeChildren(input: { name: string; version?: string; nodeId: string }) {
		return isHosted ? getStaticTreeChildren(input) : getTreeChildren(input);
	}

	type TreeChildrenResource =
		| Promise<unknown>
		| {
				run?: () => Promise<unknown>;
				current?: unknown;
		  };

	function isTreeNodeDto(value: unknown): value is TreeNodeDTO {
		if (!value || typeof value !== 'object') return false;
		const node = (value as { node?: unknown }).node;
		return Boolean(
			node && typeof node === 'object' && typeof (node as { id?: unknown }).id === 'string',
		);
	}

	function treeNodeDtos(value: unknown): TreeNodeDTO[] {
		return Array.isArray(value) ? value.filter(isTreeNodeDto) : [];
	}

	async function resolveTreeChildren(input: {
		name: string;
		version?: string;
		nodeId: string;
	}): Promise<TreeNodeDTO[]> {
		const resource = loadTreeChildren(input) as TreeChildrenResource;
		const value =
			resource && typeof (resource as { run?: unknown }).run === 'function'
				? await (resource as { run: () => Promise<unknown> }).run()
				: await resource;
		return treeNodeDtos(value);
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
				children: await resolveTreeChildren({ name: crate, version: ver, nodeId: id }),
			})),
		);
	}

	function seedServerChildren(bumpVersion: boolean) {
		let changed = false;
		if (rootChildren?.id) {
			const children = treeNodeDtos(rootChildren.children);
			const cached = childrenCache.get(rootChildren.id);
			const shouldRefresh =
				!cached ||
				children.length > cached.length ||
				(status === 'ready' && cached.length === 0 && children.length > 0);
			if (shouldRefresh) {
				childrenCache.set(rootChildren.id, children);
				changed = true;
			}
			if (!collapsedIds.has(rootChildren.id) && !expandedIds.has(rootChildren.id)) {
				expandedIds.add(rootChildren.id);
				changed = true;
			}
		}

		for (const seed of prefetchedTreeChildren ?? []) {
			if (!seed.id) continue;
			const children = treeNodeDtos(seed.children);
			const cached = childrenCache.get(seed.id);
			const shouldRefresh =
				!cached ||
				children.length > cached.length ||
				(status === 'ready' && cached.length === 0 && children.length > 0);
			if (shouldRefresh) {
				childrenCache.set(seed.id, children);
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
		if (node.kind === 'Impl') return false;
		if (showGraphBlanketImpls) return true;
		if (node.id === selectedNodeId) return true;
		return !isBlanketImplNode(node);
	}

	function visibleTreeDtos(items: unknown): TreeNodeDTO[] {
		const dtos = treeNodeDtos(items);
		if (showGraphBlanketImpls) return dtos;
		return dtos.filter((dto) => shouldIncludeTreeNode(dto.node));
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
			for (const child of treeNodeDtos(children)) map.set(child.node.id, parentId);
		}
		return map;
	});

	const baseTree = $derived(
		treeRoots?.length ? visibleTreeDtos(treeRoots).map(dtoToTreeNode).sort(compareTreeNodes) : [],
	);
	const normalizedFilter = $derived(activeFilter.trim().toLowerCase());
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
		const pathIds =
			expandPath?.ancestors.map((ancestor) => ancestor.id) ?? ancestors.map((a) => a.id);
		const key = `${selectedNodeId}:${pathIds.join('/')}`;
		if (key === lastExpandKey) return;
		lastExpandKey = key;
		if (pathIds.length > 0) {
			void fetchAndExpand(pathIds, canonicalCrateName, version);
		} else if (hydrated && selectedNodeId === baseTree[0]?.node.id) {
			void expandAndFetch(selectedNodeId);
		}
	});

	function filterTree(
		trees: TreeNode[],
		currentFilter: string,
		currentKinds: Set<NodeKind>,
	): TreeNode[] {
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
			treeNode.children === CHILDREN_PLACEHOLDER
				? getChildren(treeNode.node.id)
				: treeNode.children;
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
					treeNode.children === CHILDREN_PLACEHOLDER
						? getChildren(treeNode.node.id)
						: treeNode.children;
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
				for (const { id, children } of results) childrenCache.set(id, treeNodeDtos(children));
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
				const children = await resolveTreeChildren({
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

	function toggleTreeRowFromDoubleClick(row: FlatTreeNode, event: MouseEvent) {
		if (!row.hasChildren) return;
		event.preventDefault();
		event.stopPropagation();
		clearTreeNavigationTimer();
		toggleExpand(row.treeNode.node.id);
	}

	function clearTreeNavigationTimer() {
		if (!treeNavigationTimer) return;
		clearTimeout(treeNavigationTimer);
		treeNavigationTimer = null;
	}

	function clearFilterInputTimer() {
		if (!filterInputTimer) return;
		clearTimeout(filterInputTimer);
		filterInputTimer = null;
	}

	function handleTreeRowLinkClick(row: FlatTreeNode, href: string, event: MouseEvent) {
		if (!row.hasChildren) return;
		if (event.defaultPrevented || event.button !== 0) return;
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		event.preventDefault();
		clearTreeNavigationTimer();
		treeNavigationTimer = setTimeout(() => {
			treeNavigationTimer = null;
			void goto(href, {
				noScroll: true,
				keepFocus: true,
			});
		}, 120);
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

	function updateExplorerState(patch: Partial<ExplorerViewState>): Promise<void> | void {
		const baseUrl = browser ? new URL(window.location.href) : page.url;
		const nextUrl = serializeExplorerState(baseUrl, patch);
		if (browser) {
			if (patch.view !== undefined) localViewOverride = patch.view;
			if (patch.layout !== undefined) localDocLayoutOverride = patch.layout;
			replaceState(nextUrl, page.state);
			if (patch.layout) document.documentElement.dataset.docLayout = patch.layout;
			return;
		}
		return goto(nextUrl, {
			replaceState: true,
			noScroll: true,
			keepFocus: true,
		});
	}

	function replaceExplorerState(patch: Partial<ExplorerViewState>) {
		if (!browser) return;
		replaceState(serializeExplorerState(new URL(window.location.href), patch), page.state);
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

	function commitFilter(nextFilter: string) {
		clearFilterInputTimer();
		if (nextFilter === activeFilter) {
			return;
		}
		filterOverride = nextFilter;
		updateExplorerState({ q: nextFilter });
	}

	function scheduleFilterUpdate(nextFilter: string) {
		clearFilterInputTimer();
		filterInputTimer = setTimeout(() => {
			filterInputTimer = null;
			commitFilter(nextFilter);
		}, 100);
	}

	function handleFilterInput(event: Event) {
		const input = event.currentTarget;
		if (!(input instanceof HTMLInputElement)) return;
		filterDraftOverride = input.value;
		scheduleFilterUpdate(input.value);
	}

	function submitFilter(event: SubmitEvent) {
		event.preventDefault();
		const form = event.currentTarget;
		if (!(form instanceof HTMLFormElement)) return;
		const raw = new FormData(form).get('q');
		const nextFilter = typeof raw === 'string' ? raw : '';
		filterDraftOverride = nextFilter;
		commitFilter(nextFilter);
	}

	function retrySearch() {
		if (searchQuery) void searchQuery.refresh();
		else void invalidateAll();
	}

	function toggleKind(kind: NodeKind) {
		const next = new Set<NodeKind>(effectiveKindParams);
		if (next.has(kind)) next.delete(kind);
		else next.add(kind);
		kindOverride = nodeKindOrder.filter((candidate) => next.has(candidate));
		updateExplorerState({ k: kindOverride });
	}

	function kindHref(kind: NodeKind): string {
		const next = new Set<NodeKind>(effectiveKindParams);
		if (next.has(kind)) next.delete(kind);
		else next.add(kind);
		const url = serializeExplorerState(browser ? new URL(window.location.href) : page.url, {
			k: nodeKindOrder.filter((candidate) => next.has(candidate)),
		});
		return `${url.pathname}${url.search}`;
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

	function isEditableTarget(target: EventTarget | null): boolean {
		if (!(target instanceof HTMLElement)) return false;
		const tag = target.tagName.toLowerCase();
		return (
			target.isContentEditable ||
			tag === 'input' ||
			tag === 'textarea' ||
			tag === 'select' ||
			target.closest('[role="textbox"]') !== null
		);
	}

	function focusTreeFilter() {
		treeFilterInput?.focus();
		treeFilterInput?.select();
	}

	function setDocLayout(nextLayout: ExplorerDocLayout) {
		updateExplorerState({ view: 'docs', layout: nextLayout });
	}

	function openGraphView() {
		updateExplorerState({ view: 'graph' });
	}

	function handleExplorerKeydown(event: KeyboardEvent) {
		if (event.defaultPrevented || event.metaKey || event.ctrlKey) return;
		if (isEditableTarget(event.target)) return;

		const key = event.key.toLowerCase();
		if (key === 's' || key === '/') {
			event.preventDefault();
			focusTreeFilter();
			return;
		}
		if (key === 'g') {
			event.preventDefault();
			updateExplorerState({ view: 'graph' });
			return;
		}
		if (key === 'd') {
			event.preventDefault();
			updateExplorerState({ view: 'docs' });
			return;
		}
		if (event.key === '[') {
			event.preventDefault();
			window.history.back();
			return;
		}
		if (event.key === ']') {
			event.preventDefault();
			window.history.forward();
			return;
		}
		if (event.key === '1') {
			event.preventDefault();
			setDocLayout('classic');
		} else if (event.key === '2') {
			event.preventDefault();
			setDocLayout('reading');
		} else if (event.key === '3') {
			event.preventDefault();
			setDocLayout('split');
		}
	}
</script>

{#snippet modeButton(nextMode: 'graph' | 'docs', label: string, icon: 'link' | 'hash')}
	{@const href = serializeExplorerState(page.url, { view: nextMode })}
	{@const modeHref = `${href.pathname}${href.search}`}
	<a
		href={resolveAppPath(modeHref)}
		data-sveltekit-noscroll
		data-sveltekit-keepfocus
		class="flex items-center gap-1 rounded px-2.5 py-0.5 text-[11.5px] no-underline transition-colors {mode ===
		nextMode
			? 'bg-(--panel-solid) text-(--ink) shadow-(--shadow-soft)'
			: 'text-(--muted)'}"
		aria-current={mode === nextMode ? 'page' : undefined}
		aria-label={`${label} view`}
		title={`${label} view`}
		onclick={(event) => {
			// Progressive enhancement: real URL works without JS.
			// With JS, keep focus/scroll and use replaceState path from updateExplorerState.
			if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
				return;
			}
			event.preventDefault();
			void updateExplorerState({ view: nextMode });
		}}
	>
		<Icon name={icon} size={11} />
		<span class="mode-label">{label}</span>
	</a>
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
		data-tree-node-id={node.id}
		tabindex="-1"
		class="group relative flex min-h-8 items-center gap-1.5 rounded-md pr-2 transition-colors hover:bg-(--panel-muted) {isSelected
			? 'bg-(--accent-soft)'
			: ''}"
		style={`padding-left: ${8 + row.depth * 14}px`}
		ondblclick={(event) => toggleTreeRowFromDoubleClick(row, event)}
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
				class="js-only grid size-5 shrink-0 place-items-center rounded text-(--muted-soft) hover:bg-(--panel-solid) hover:text-(--ink)"
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
		{#if row.hasChildren}
			<span class="no-js-only size-5 shrink-0" aria-hidden="true"></span>
		{/if}
		<a
			{href}
			data-sveltekit-noscroll
			data-sveltekit-keepfocus
			class="flex min-w-0 flex-1 items-center gap-2 self-stretch text-left no-underline"
			onclick={(event) => handleTreeRowLinkClick(row, href, event)}
			ondblclick={(event) => toggleTreeRowFromDoubleClick(row, event)}
		>
			<KindBadge kind={node.kind} size={14} />
			<span
				class="mono min-w-0 flex-1 truncate text-[12px]"
				class:line-through={node.is_deprecated}
				style={`color: ${
					isSelected ? 'var(--accent-strong)' : isAncestor ? 'var(--ink)' : 'var(--ink-soft)'
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
							<span
								class="mono text-[10px] font-semibold tracking-[0.16em] uppercase"
								style={`color: ${group.color}`}
							>
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
									<span
										class="mono min-w-0 flex-1 truncate text-[11.5px] font-semibold text-(--ink-soft)"
									>
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

{#snippet treePane(frameClass: string)}
	<aside
		class={`flex h-full min-h-0 flex-col overflow-hidden bg-(--panel) ${frameClass}`}
		aria-label="Module tree"
	>
		<div class="border-b border-(--panel-border-soft) px-4 pt-4 pb-3">
			<div class="mb-1 text-[10px] font-semibold tracking-[0.22em] text-(--muted-soft) uppercase">
				Module tree
			</div>
			<div class="flex min-w-0 items-center gap-2">
				<a
					href={canonicalCrateName && version
						? resolveAppPath(`/${canonicalCrateName}/${version}`)
						: '#'}
					class="font-display min-w-0 truncate text-[15px] font-semibold text-(--ink)"
				>
					{canonicalCrateName ?? crateName ?? 'crate'}
				</a>
				{#if crateVersionOptions.length > 0}
					<form method="GET" action="/go/crate-version" class="flex min-w-0 items-center gap-1">
						<input type="hidden" name="crate" value={canonicalCrateName ?? crateName ?? ''} />
						<input type="hidden" name="path" value={page.params.path ?? ''} />
						<input type="hidden" name="query" value={page.url.search} />
						<select
							name="version"
							class="mono corner-squircle max-w-28 rounded-(--radius-control) border border-(--panel-border) bg-(--panel-solid) px-1.5 py-0.5 text-[10.5px] text-(--muted)"
							aria-label="Crate version"
							value={version}
							onchange={onVersionChange}
						>
							{#each crateVersionOptions as option (option)}
								<option value={option}>v{option}</option>
							{/each}
						</select>
						<button type="submit" class="no-js-only text-[10px] font-semibold text-(--accent)">
							Go
						</button>
					</form>
				{/if}
			</div>
			<div class="mono mt-0.5 text-[10.5px] text-(--muted-soft)">
				{#if totalItems > 0}
					{totalItems.toLocaleString()} items
				{:else if crateListCount != null}
					{crateListCount.toLocaleString()} crates
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
					{@attach attachTreeFilterInput}
					type="search"
					name="q"
					placeholder="Filter items..."
					value={filterDraft}
					class="mono w-full rounded-md border border-(--panel-border) bg-(--panel-solid) py-1.5 pr-12 pl-7 text-[11.5px] text-(--ink) outline-none focus:border-(--accent) focus:ring-1 focus:ring-(--accent)"
					oninput={handleFilterInput}
				/>
				<span class="absolute top-1/2 left-2 -translate-y-1/2 text-(--muted-soft)">
					<Icon name="search" size={12} />
				</span>
				<span class="kbd js-only absolute top-1/2 right-2 -translate-y-1/2" aria-hidden="true">
					S
				</span>
				<button
					type="submit"
					class="no-js-only absolute inset-y-1 right-1 rounded px-2 text-[10px] font-semibold text-(--accent)"
				>
					Filter
				</button>
				{#each effectiveKindParams as kind (kind)}
					<input type="hidden" name="k" value={kind} />
				{/each}
				{#if showGraphBlanketImpls}
					<input type="hidden" name="gbi" value="1" />
				{/if}
			</form>
			{#if populatedKinds.length > 0}
				<div class="mt-2 flex flex-wrap gap-1">
					{#each populatedKinds as facet (facet.kind)}
						{@const isActive = kindFilter.has(facet.kind)}
						<a
							href={resolveAppPath(kindHref(facet.kind))}
							data-sveltekit-preload-data="off"
							data-sveltekit-noscroll
							data-sveltekit-keepfocus
							class="badge badge-sm no-underline transition-colors hover:bg-(--panel-strong) hover:text-(--ink)"
							class:badge-accent={isActive}
							aria-current={isActive ? 'true' : undefined}
							onclick={(event) => {
								if (
									event.metaKey ||
									event.ctrlKey ||
									event.shiftKey ||
									event.altKey ||
									event.button !== 0
								) {
									return;
								}
								event.preventDefault();
								toggleKind(facet.kind);
							}}
						>
							{facet.label}
						</a>
					{/each}
				</div>
			{/if}
			{#if debugInfo}
				<div
					class="mono mt-2 rounded-sm border border-(--panel-border) bg-(--panel-solid) px-2 py-1 text-[10px] text-(--muted)"
				>
					<div>{debugInfo.statusDebugKey}</div>
					<div>{debugInfo.progressDebugKey}</div>
				</div>
			{/if}
		</div>

		<div class="flex min-h-0 flex-1 flex-col">
			{#if hasActiveTreeFilter}
				{#if searchLoading}
					<SkeletonTree count={8} showKindBadges={true} />
				{:else if searchError}
					<div class="p-4 text-sm text-(--danger)">
						<p class="font-medium">Search failed</p>
						<a
							href={resolveAppPath(`${page.url.pathname}${page.url.search}`)}
							class="mt-2 text-(--accent) hover:underline"
							onclick={(event) => {
								event.preventDefault();
								retrySearch();
							}}
						>
							Try again
						</a>
					</div>
				{:else}
					<div class="min-h-0 flex-1 overflow-y-auto px-2.5 py-3">
						<div class="mono mb-1 px-2 text-[10.5px] text-(--muted-soft)">
							{searchResults.length} result{searchResults.length === 1 ? '' : 's'}
						</div>
						{#each searchResults as node (node.id)}
							{@render searchResultRow(node)}
						{:else}
							<p class="px-2 py-3 text-sm text-(--muted)">{emptySearchMessage}</p>
						{/each}
					</div>
				{/if}
			{:else if treeRoots && treeRoots.length > 0}
				<div
					class="js-only flex items-center gap-2 border-b border-(--panel-border-soft) px-3 py-2"
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
						Expand
					</button>
				</div>
				<div
					class="min-h-0 flex-1 overflow-y-auto px-2.5 py-3"
					role="tree"
					aria-label="Crate modules"
				>
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
						<a
							href={resolveAppPath(`${page.url.pathname}${page.url.search}`)}
							class="mt-3 text-sm text-(--accent) hover:underline"
							onclick={(event) => {
								event.preventDefault();
								onRetryTree?.(() => {});
							}}
						>
							Try again
						</a>
					{/if}
				</div>
			{/if}
		</div>

		{#if crateList.length > 0 || loadingCrateSwitcher}
			<div class="border-t border-(--panel-border-soft) px-4 py-3">
				<div class="mb-2 flex items-center gap-2">
					<span class="text-[9.5px] font-semibold tracking-[0.18em] text-(--muted-soft) uppercase">
						{crateSwitcherLabel}
					</span>
					<span class="h-px flex-1 bg-(--panel-border-soft)"></span>
				</div>
				{#if loadingCrateSwitcher}
					<p class="mono text-[11px] text-(--muted-soft)">Loading crates...</p>
				{:else}
					<div class="max-h-24 overflow-y-auto">
						{#each crateList.slice(0, 6) as item (item.id)}
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
{/snippet}

{#snippet nodeContentPane(frameClass: string)}
	<section
		class={`relative h-full min-h-0 overflow-auto bg-(--bg) ${frameClass}`}
		aria-label="Node content"
	>
		{#if mode === 'graph' && detail}
			{@const FocusGraphFlow = (await import('$lib/components/design/graph/FocusGraphFlow.svelte'))
				.default}
			<div class="js-only h-full">
				<FocusGraphFlow
					{detail}
					{ancestors}
					crateName={canonicalCrateName ?? crateName ?? ''}
					crateVersion={version ?? ''}
					{getNodeUrl}
					height={620}
				/>
			</div>
			<div class="no-js-only flex min-h-80 items-center justify-center p-6 text-center">
				<div>
					<p class="font-medium text-(--ink)">The interactive graph requires JavaScript.</p>
					<a href={docsHref} class="mt-2 inline-block text-sm text-(--link) underline">
						Open documentation
					</a>
				</div>
			</div>
		{:else if detail && selected && selected.kind !== 'Crate'}
			{#if docLayout === 'reading'}
				{@const DocReading = (await import('$lib/components/design/docs/DocReading.svelte'))
					.default}
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
				{@const DocSplit = (await import('$lib/components/design/docs/DocSplit.svelte')).default}
				<DocSplit
					{detail}
					{ancestors}
					model={detailModel}
					{theme}
					{getNodeUrl}
					openGraphHref={graphHref}
					onOpenGraph={openGraphView}
					crateName={canonicalCrateName ?? crateName}
					crateVersion={version}
					{crateVersions}
				/>
			{:else}
				{@const DocClassic = (await import('$lib/components/design/docs/DocClassic.svelte'))
					.default}
				<DocClassic
					{detail}
					{ancestors}
					model={detailModel}
					{theme}
					{getNodeUrl}
					openGraphHref={graphHref}
					onOpenGraph={openGraphView}
					crateName={canonicalCrateName ?? crateName}
					crateVersion={version}
					{crateVersions}
				/>
			{/if}
		{:else}
			{@const DetailView = (await import('$lib/components/DetailView.svelte')).default}
			<DetailView {nodeId} embedded />
		{/if}
	</section>
{/snippet}

{#snippet detailPane(frameClass: string)}
	<aside
		class={`flex h-full min-h-0 flex-col overflow-hidden bg-(--panel) ${frameClass}`}
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
				{@render relationshipList(
					'Outgoing',
					selectedEdges.outgoing.length,
					relationshipGroups.outgoing,
				)}
				<div class="mt-5">
					{@render relationshipList(
						'Incoming',
						selectedEdges.incoming.length,
						relationshipGroups.incoming,
					)}
				</div>
			</div>
			<div class="flex items-center gap-2 border-t border-(--panel-border-soft) px-5 py-3">
				<a
					href={docsHref}
					class="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-(--accent) py-1.5 text-[12px] font-medium text-(--on-accent)"
					onclick={(event) => {
						if (
							event.metaKey ||
							event.ctrlKey ||
							event.shiftKey ||
							event.altKey ||
							event.button !== 0
						) {
							return;
						}
						event.preventDefault();
						updateExplorerState({ view: 'docs' });
					}}
				>
					Open docs
					<Icon name="arrow-right" size={11} />
				</a>
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
{/snippet}

<div class="live-explorer flex min-h-0 flex-1 flex-col overflow-hidden bg-(--bg)">
	<div
		class="flex min-h-12 items-center gap-3 border-b border-(--panel-border-soft) bg-(--panel) px-4"
	>
		<div class="flex min-w-0 flex-1 items-center gap-2">
			{#if selected}
				<KindBadge kind={selected.kind} size={16} />
			{/if}
			<nav
				aria-label="Node path"
				class="mono flex min-w-0 flex-nowrap items-baseline gap-1 overflow-hidden text-[13px]"
			>
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
		<div class="ml-auto flex shrink-0 items-center gap-2">
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

	<div class="min-h-0 flex-1 overflow-auto lg:overflow-hidden">
		{#if mode === 'graph'}
			<Resizable.PaneGroup
				direction="horizontal"
				autoSaveId="codeview-explorer-graph"
				class="codeview-resizable-group"
			>
				<Resizable.Pane defaultSize={20} minSize={15} maxSize={34} order={1}>
					{@render treePane('border-r border-(--panel-border-soft)')}
				</Resizable.Pane>
				<Resizable.Handle
					withHandle
					class="z-5 w-2 shrink-0 bg-(--bg) hover:bg-(--accent-soft) focus-visible:bg-(--accent-soft)"
				/>
				<Resizable.Pane defaultSize={55} minSize={34} order={2}>
					{@render nodeContentPane('')}
				</Resizable.Pane>
				<Resizable.Handle
					withHandle
					class="z-5 w-2 shrink-0 bg-(--bg) hover:bg-(--accent-soft) focus-visible:bg-(--accent-soft)"
				/>
				<Resizable.Pane defaultSize={25} minSize={18} maxSize={38} order={3}>
					{@render detailPane('border-l border-(--panel-border-soft)')}
				</Resizable.Pane>
			</Resizable.PaneGroup>
		{:else if docLayout === 'classic'}
			<Resizable.PaneGroup
				direction="horizontal"
				autoSaveId="codeview-doc-classic"
				class="codeview-resizable-group"
			>
				<Resizable.Pane defaultSize={21} minSize={15} maxSize={32} order={1}>
					{@render treePane('border-r border-(--panel-border-soft)')}
				</Resizable.Pane>
				<Resizable.Handle
					withHandle
					class="z-5 w-2 shrink-0 bg-(--bg) hover:bg-(--accent-soft) focus-visible:bg-(--accent-soft)"
				/>
				<Resizable.Pane defaultSize={79} minSize={58} order={2}>
					{@render nodeContentPane('')}
				</Resizable.Pane>
			</Resizable.PaneGroup>
		{:else}
			{@render nodeContentPane('')}
		{/if}
	</div>
</div>

<style>
	@media (max-width: 379.98px) {
		.live-explorer :global(.mode-label) {
			display: none;
		}
	}
</style>
