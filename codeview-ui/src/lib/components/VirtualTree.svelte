<script lang="ts">
	import type { NodeKind } from '$lib/graph';
	import type { Attachment } from 'svelte/attachments';
	import { CHILDREN_PLACEHOLDER, compareTreeNodes, matchesFilter, type TreeNode } from '$lib/tree';
	import { KeyedMemo, Memo, arrayEqual, keyEqual, keyOf } from '$lib/reactivity.svelte';
	import TreeItem from './TreeItem.svelte';
	import { perf } from '$lib/perf';
	import { getLogger } from '$lib/log';

	interface FlatNode {
		treeNode: TreeNode;
		depth: number;
		isExpanded: boolean;
		hasChildren: boolean;
		parentId: string | undefined;
	}

	let {
		tree,
		treeVersion,
		selectedId = null,
		getNodeUrl,
		expandedIds,
		onToggleExpand,
		filter,
		kindFilter,
		resolveChildren,
	} = $props<{
		tree: TreeNode[];
		treeVersion: number;
		selectedId?: string | null;
		getNodeUrl: (id: string) => string;
		expandedIds: Set<string>;
		onToggleExpand: (id: string) => void;
		filter: string;
		kindFilter: Set<NodeKind>;
		/** Read children from cache (pure, no side effects). */
		resolveChildren: (parentId: string) => TreeNode[];
	}>();
	const log = getLogger('virtual-tree');

	const ITEM_HEIGHT = 32;
	const OVERSCAN = 5;

	let scrollTop = $state(0);
	let containerHeight = $state(400);

	// Track the exact child array sorted for each TreeNode. Navigation can replace
	// cached children for the same parent, so the array reference matters.
	const lazySorted = new WeakMap<TreeNode, TreeNode[]>();

	// Fast path: when nothing is expanded, the flat list is just roots at depth 0.
	// We can skip the O(n) flatten entirely and compute visible items directly.
	const fastPath = $derived(expandedIds.size === 0);

	// Full flatten — only computed when nodes are expanded.
	const flatNodesMemo = new KeyedMemo(
		() => (fastPath ? keyOf('skip') : keyOf(treeVersion, expandedIds, tree)),
		() => {
			if (fastPath) return [] as FlatNode[];
			const t0 = performance.now();
			const flattened = perf.time(
				'derived',
				'flatNodes',
				() => {
					const result: FlatNode[] = [];
					const sorted = lazySorted;
					const resolve = resolveChildren;
					function flatten(nodes: TreeNode[], depth: number, parentId: string | undefined) {
						for (const treeNode of nodes) {
							const hasChildren = treeNode.children.length > 0;
							const isExpanded = expandedIds.has(treeNode.node.id);

							result.push({
								treeNode,
								depth,
								isExpanded,
								hasChildren,
								parentId,
							});

							if (hasChildren && isExpanded) {
								// Resolve children from cache (pure reader, no side effects)
								const children =
									treeNode.children === CHILDREN_PLACEHOLDER
										? resolve(treeNode.node.id)
										: treeNode.children;
								// Lazy sort: sort children on first access when expanding
								if (children.length > 1 && sorted.get(treeNode) !== children) {
									children.sort(compareTreeNodes);
									sorted.set(treeNode, children);
								}
								flatten(children, depth + 1, treeNode.node.id);
							}
						}
					}

					flatten(tree, 0, undefined);
					return result;
				},
				{
					detail: (r) => `${r.length} items`,
				},
			);
			const ms = performance.now() - t0;
			if (ms > 120) {
				log.warn`flatNodes slow ${Math.round(ms)}ms items=${flattened.length} treeVersion=${treeVersion} expandedIds=${expandedIds.size}`;
			}
			return flattened;
		},
		{
			equalsKey: keyEqual,
			equalsValue: (a, b) =>
				arrayEqual(a, b, (x, y) => x.treeNode === y.treeNode && x.isExpanded === y.isExpanded),
		},
	);
	const flatNodesFull = $derived(flatNodesMemo.current);

	// Total item count — fast path uses tree length directly (O(1))
	const totalCount = $derived(fastPath ? tree.length : flatNodesFull.length);

	// Calculate visible range
	const visibleRangeMemo = new Memo(() => {
		const start = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - OVERSCAN);
		const visibleCount = Math.ceil(containerHeight / ITEM_HEIGHT) + OVERSCAN * 2;
		const end = Math.min(totalCount, start + visibleCount);
		return { start, end };
	});
	const visibleRange = $derived(visibleRangeMemo.current);

	// Visible nodes — fast path builds only ~30 FlatNode objects directly from tree
	const visibleNodes = $derived.by(() => {
		const { start, end } = visibleRange;
		if (fastPath) {
			const result: FlatNode[] = [];
			for (let i = start; i < end && i < tree.length; i++) {
				const treeNode = tree[i];
				result.push({
					treeNode,
					depth: 0,
					isExpanded: false,
					hasChildren: treeNode.children.length > 0,
					parentId: undefined,
				});
			}
			return result;
		}
		return flatNodesFull.slice(start, end);
	});

	// Total height for scroll
	const totalHeight = $derived(totalCount * ITEM_HEIGHT);

	// Offset for positioning visible items
	const offsetY = $derived(visibleRange.start * ITEM_HEIGHT);

	const attachScrollListener: Attachment<HTMLDivElement> = (node) => {
		const handleScroll = () => {
			scrollTop = node.scrollTop;
		};
		handleScroll();
		node.addEventListener('scroll', handleScroll, { passive: true });
		return () => {
			node.removeEventListener('scroll', handleScroll);
		};
	};

	// Track last scrolled-to selection to avoid re-scrolling
	let lastScrolledToId: string | null = null;

	const attachAutoScroll = (
		selectedId: string | null,
		count: number,
		height: number,
		visibleStart: number,
		visibleEnd: number,
	): Attachment<HTMLDivElement> => {
		return (node) => {
			// Only scroll if selection changed
			if (selectedId === lastScrolledToId) return;
			lastScrolledToId = selectedId;

			if (!selectedId) return;

			// Find the selected index — fast path searches tree directly
			let selectedIndex = -1;
			if (fastPath) {
				selectedIndex = tree.findIndex((t: TreeNode) => t.node.id === selectedId);
			} else {
				selectedIndex = flatNodesFull.findIndex((item) => item.treeNode.node.id === selectedId);
			}

			if (selectedIndex === -1) return;
			if (selectedIndex >= visibleStart && selectedIndex < visibleEnd) return;

			const itemTop = selectedIndex * ITEM_HEIGHT;
			const itemBottom = itemTop + ITEM_HEIGHT;
			const viewTop = node.scrollTop;
			const viewBottom = viewTop + height;

			// Only scroll if item is not fully visible
			if (itemTop < viewTop) {
				node.scrollTo({ top: itemTop - ITEM_HEIGHT, behavior: 'instant' });
			} else if (itemBottom > viewBottom) {
				node.scrollTo({ top: itemBottom - height + ITEM_HEIGHT, behavior: 'instant' });
			}
		};
	};
</script>

<svelte:boundary>
	<div
		{@attach attachScrollListener}
		{@attach attachAutoScroll(
			selectedId,
			totalCount,
			containerHeight,
			visibleRange.start,
			visibleRange.end,
		)}
		class="flex-1 overflow-auto p-2"
		style="scrollbar-gutter: stable;"
		bind:clientHeight={containerHeight}
	>
		<div style="height: {totalHeight}px; position: relative;">
			<div style="transform: translateY({offsetY}px);">
				{#each visibleNodes as { treeNode, depth, isExpanded, hasChildren, parentId } (`${parentId ?? 'root'}::${treeNode.node.id}`)}
					{@const isSel = treeNode.selectable && selectedId === treeNode.node.id}
					<TreeItem
						node={treeNode.node}
						{depth}
						{hasChildren}
						{isExpanded}
						isSelected={isSel}
						dimmed={!matchesFilter(treeNode.node, filter, kindFilter)}
						selectable={treeNode.selectable}
						href={getNodeUrl(treeNode.node.id)}
						onToggle={() => {
							if (hasChildren) onToggleExpand(treeNode.node.id);
						}}
						onSelect={() => {
							if (!treeNode.selectable && hasChildren) onToggleExpand(treeNode.node.id);
						}}
						itemHeight={ITEM_HEIGHT}
					/>
				{/each}
			</div>
		</div>
	</div>
	{#snippet failed(error, reset)}
		<div class="flex-1 p-4 text-sm text-(--danger)">
			<p>Tree render error</p>
			<button type="button" class="mt-1 text-(--accent) hover:underline" onclick={reset}>
				Retry
			</button>
		</div>
	{/snippet}
</svelte:boundary>
