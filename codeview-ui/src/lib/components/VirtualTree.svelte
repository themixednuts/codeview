<script lang="ts">
  import type { Node, NodeKind } from '$lib/graph';
  import type { Attachment } from 'svelte/attachments';
  import { matchesFilter, type TreeNode } from '$lib/tree-constants';
  import { Memo, arrayEqual } from '$lib/reactivity.svelte';
  import TreeItem from './TreeItem.svelte';
  import { perf } from '$lib/perf';

  interface FlatNode {
    treeNode: TreeNode;
    depth: number;
    isExpanded: boolean;
    hasChildren: boolean;
    parentId: string | undefined;
  }

  let {
    tree,
    selected,
    getNodeUrl,
    expandedIds,
    onToggleExpand,
    onSelectExpand,
    filter,
    kindFilter
  } = $props<{
    tree: TreeNode[];
    selected: Node | null;
    getNodeUrl: (id: string, parent?: string) => string;
    expandedIds: Set<string>;
    onToggleExpand: (id: string) => void;
    /** Row-click expand logic: toggle for non-selectable nodes */
    onSelectExpand: (id: string, isSelected: boolean, isExpanded: boolean, hasChildren: boolean, selectable: boolean) => void;
    filter: string;
    kindFilter: Set<NodeKind>;
  }>();

  const ITEM_HEIGHT = 32;
  const OVERSCAN = 5;

  let scrollTop = $state(0);
  let containerHeight = $state(400);

  // Flatten visible tree nodes.
  // Wrapped in Memo to stabilize the reference — prevents downstream rerenders
  // when the tree/expandedIds signals fire but produce the same flat list.
  // Snapshot expandedIds into a plain Set once per change to avoid
  // repeated reactive proxy overhead from SvelteSet.has() inside the loop.
  const expandedSnapshot = $derived(new Set(expandedIds));

  const flatNodesMemo = new Memo(() => {
    return perf.time('derived', 'flatNodes', () => {
      const expanded = expandedSnapshot;
      const result: FlatNode[] = [];
      function flatten(nodes: TreeNode[], depth: number, parentId: string | undefined) {
        for (const treeNode of nodes) {
          const hasChildren = treeNode.children.length > 0;
          const isExpanded = expanded.has(treeNode.node.id);

          result.push({
            treeNode,
            depth,
            isExpanded,
            hasChildren,
            parentId
          });

          if (hasChildren && isExpanded) {
            flatten(treeNode.children, depth + 1, treeNode.node.id);
          }
        }
      }

      flatten(tree, 0, undefined);
      return result;
    }, {
      detail: (r) => `${r.length} items`
    });
  }, (a, b) => arrayEqual(a, b, (x, y) => x.treeNode === y.treeNode && x.isExpanded === y.isExpanded));
  const flatNodes = $derived(flatNodesMemo.current);

  // Calculate visible range — Memo stabilizes the reference when values unchanged.
  const visibleRangeMemo = new Memo(() => {
    const start = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - OVERSCAN);
    const visibleCount = Math.ceil(containerHeight / ITEM_HEIGHT) + OVERSCAN * 2;
    const end = Math.min(flatNodes.length, start + visibleCount);
    return { start, end };
  });
  const visibleRange = $derived(visibleRangeMemo.current);

  // Get visible nodes
  const visibleNodes = $derived(flatNodes.slice(visibleRange.start, visibleRange.end));

  // Total height for scroll
  const totalHeight = $derived(flatNodes.length * ITEM_HEIGHT);

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
    nodes: FlatNode[],
    height: number
  ): Attachment<HTMLDivElement> => {
    return (node) => {
      // Only scroll if selection changed
      if (selectedId === lastScrolledToId) return;
      lastScrolledToId = selectedId;

      if (!selectedId) return;

      const selectedIndex = nodes.findIndex(
        (item) => item.treeNode.node.id === selectedId
      );

      if (selectedIndex === -1) return;

      const itemTop = selectedIndex * ITEM_HEIGHT;
      const itemBottom = itemTop + ITEM_HEIGHT;
      const viewTop = node.scrollTop;
      const viewBottom = viewTop + height;

      // Only scroll if item is not fully visible
      if (itemTop < viewTop) {
        node.scrollTo({ top: itemTop - ITEM_HEIGHT, behavior: 'smooth' });
      } else if (itemBottom > viewBottom) {
        node.scrollTo({ top: itemBottom - height + ITEM_HEIGHT, behavior: 'smooth' });
      }
    };
  };

</script>

<svelte:boundary>
  <div
    {@attach attachScrollListener}
    {@attach attachAutoScroll(selected?.id ?? null, flatNodes, containerHeight)}
    class="flex-1 overflow-auto p-2"
    style="scrollbar-gutter: stable;"
    bind:clientHeight={containerHeight}
  >
    <div style="height: {totalHeight}px; position: relative;">
      <div style="transform: translateY({offsetY}px);">
        {#each visibleNodes as { treeNode, depth, isExpanded, hasChildren, parentId } (`${parentId ?? 'root'}::${treeNode.node.id}`)}
          {@const isSel = treeNode.selectable && selected?.id === treeNode.node.id}
          <TreeItem
            node={treeNode.node}
            {depth}
            {hasChildren}
            {isExpanded}
            isSelected={isSel}
            dimmed={!matchesFilter(treeNode.node, filter, kindFilter)}
            selectable={treeNode.selectable}
            href={getNodeUrl(treeNode.node.id, parentId)}
            onToggle={() => { if (hasChildren) onToggleExpand(treeNode.node.id); }}
            onSelect={() => onSelectExpand(treeNode.node.id, isSel, isExpanded, hasChildren, treeNode.selectable)}
            itemHeight={ITEM_HEIGHT}
          />
        {/each}
      </div>
    </div>
  </div>
  {#snippet failed(error, reset)}
    <div class="flex-1 p-4 text-sm text-[var(--danger)]">
      <p>Tree render error</p>
      <button type="button" class="mt-1 text-[var(--accent)] hover:underline" onclick={reset}>Retry</button>
    </div>
  {/snippet}
</svelte:boundary>
