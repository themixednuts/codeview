<script lang="ts">
  import type { Node, NodeKind } from '$lib/graph';

  type TreeNode = {
    node: Node;
    children: TreeNode[];
    selectable: boolean;
  };

  type FlatNode = {
    treeNode: TreeNode;
    depth: number;
    isExpanded: boolean;
    hasChildren: boolean;
  };

  let {
    tree,
    selected,
    onSelect,
    expandedIds,
    onToggleExpand,
    filter,
    kindFilter
  } = $props<{
    tree: TreeNode[];
    selected: Node | null;
    onSelect: (node: Node) => void;
    expandedIds: Set<string>;
    onToggleExpand: (id: string) => void;
    filter: string;
    kindFilter: Set<NodeKind>;
  }>();

  const ITEM_HEIGHT = 32;
  const OVERSCAN = 5;

  let containerRef = $state<HTMLDivElement | null>(null);
  let scrollTop = $state(0);
  let containerHeight = $state(400);

  // Flatten visible tree nodes
  const flatNodes = $derived.by(() => {
    const result: FlatNode[] = [];

    function flatten(nodes: TreeNode[], depth: number) {
      for (const treeNode of nodes) {
        const hasChildren = treeNode.children.length > 0;
        const isExpanded = expandedIds.has(treeNode.node.id);

        result.push({
          treeNode,
          depth,
          isExpanded,
          hasChildren
        });

        if (hasChildren && isExpanded) {
          flatten(treeNode.children, depth + 1);
        }
      }
    }

    flatten(tree, 0);
    return result;
  });

  // Calculate visible range
  const visibleRange = $derived.by(() => {
    const start = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - OVERSCAN);
    const visibleCount = Math.ceil(containerHeight / ITEM_HEIGHT) + OVERSCAN * 2;
    const end = Math.min(flatNodes.length, start + visibleCount);
    return { start, end };
  });

  // Get visible nodes
  const visibleNodes = $derived(flatNodes.slice(visibleRange.start, visibleRange.end));

  // Total height for scroll
  const totalHeight = $derived(flatNodes.length * ITEM_HEIGHT);

  // Offset for positioning visible items
  const offsetY = $derived(visibleRange.start * ITEM_HEIGHT);

  function handleScroll(e: Event) {
    scrollTop = (e.currentTarget as HTMLDivElement).scrollTop;
  }

  function matchesFilter(node: Node): boolean {
    if (kindFilter.size > 0 && !kindFilter.has(node.kind)) {
      return false;
    }
    if (!filter) return true;
    const lowerFilter = filter.toLowerCase();
    return (
      node.name.toLowerCase().includes(lowerFilter) ||
      node.id.toLowerCase().includes(lowerFilter)
    );
  }

  const kindColors: Record<NodeKind, string> = {
    Crate: '#e85d04',
    Module: '#2d6a4f',
    Struct: '#9d4edd',
    Union: '#7b2cbf',
    Enum: '#3a86ff',
    Trait: '#06d6a0',
    TraitAlias: '#0db39e',
    Impl: '#8d99ae',
    Function: '#f72585',
    Method: '#b5179e',
    TypeAlias: '#ff6d00'
  };

  const kindIcons: Record<NodeKind, string> = {
    Crate: '📦',
    Module: '📁',
    Struct: 'S',
    Union: 'U',
    Enum: 'E',
    Trait: 'T',
    TraitAlias: 'T',
    Impl: 'I',
    Function: 'fn',
    Method: 'fn',
    TypeAlias: '='
  };

  // Observe container size
  $effect(() => {
    if (!containerRef) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        containerHeight = entry.contentRect.height;
      }
    });

    observer.observe(containerRef);
    return () => observer.disconnect();
  });

</script>

<div
  bind:this={containerRef}
  class="flex-1 overflow-auto"
  onscroll={handleScroll}
>
  <div style="height: {totalHeight}px; position: relative;">
    <div style="transform: translateY({offsetY}px);">
      {#each visibleNodes as { treeNode, depth, isExpanded, hasChildren } (treeNode.node.id)}
        {@const isSelected = treeNode.selectable && selected?.id === treeNode.node.id}
        {@const matches = matchesFilter(treeNode.node)}
        <button
          type="button"
          class="flex w-full items-center gap-1 rounded px-2 text-left text-sm hover:bg-[var(--panel-strong)] {isSelected
            ? 'bg-[var(--accent)]/10 ring-1 ring-[var(--accent)]'
            : ''} {!matches ? 'opacity-50' : ''}"
          style="height: {ITEM_HEIGHT}px; padding-left: {depth * 16 + 8}px"
          onclick={() => {
            if (hasChildren) onToggleExpand(treeNode.node.id);
            if (treeNode.selectable) onSelect(treeNode.node);
          }}
        >
          <span class="w-4 text-center text-[var(--muted)]">
            {#if hasChildren}
              {isExpanded ? '▼' : '▶'}
            {/if}
          </span>
          <span
            class="flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold text-white"
            style="background-color: {kindColors[treeNode.node.kind]}"
          >
            {kindIcons[treeNode.node.kind]}
          </span>
          <span class="truncate font-medium text-[var(--ink)]">{treeNode.node.name}</span>
          {#if treeNode.node.visibility === 'Public'}
            <span class="text-[10px] text-green-600">pub</span>
          {/if}
        </button>
      {/each}
    </div>
  </div>
</div>
