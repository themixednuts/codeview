<script lang="ts" module>
  import type { Node, NodeKind } from '$lib/graph';

  export interface TreeNode {
    node: Node;
    children: TreeNode[];
    selectable: boolean;
  }

  export interface FlatNode {
    treeNode: TreeNode;
    depth: number;
    isExpanded: boolean;
    hasChildren: boolean;
  }
</script>

<script lang="ts">
  import type { Attachment } from 'svelte/attachments';
  let {
    tree,
    selected,
    getNodeUrl,
    expandedIds,
    onToggleExpand,
    filter,
    kindFilter
  } = $props<{
    tree: TreeNode[];
    selected: Node | null;
    getNodeUrl: (id: string) => string;
    expandedIds: Set<string>;
    onToggleExpand: (id: string) => void;
    filter: string;
    kindFilter: Set<NodeKind>;
  }>();

  const ITEM_HEIGHT = 32;
  const OVERSCAN = 5;

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

<div
  {@attach attachScrollListener}
  {@attach attachAutoScroll(selected?.id ?? null, flatNodes, containerHeight)}
  class="flex-1 overflow-auto p-2"
  style="scrollbar-gutter: stable;"
  bind:clientHeight={containerHeight}
>
  <div style="height: {totalHeight}px; position: relative;">
    <div style="transform: translateY({offsetY}px);">
      {#each visibleNodes as { treeNode, depth, isExpanded, hasChildren } (treeNode.node.id)}
        {@const isSelected = treeNode.selectable && selected?.id === treeNode.node.id}
        {@const matches = matchesFilter(treeNode.node)}
        <div
          class="flex w-full items-center gap-2 rounded-[var(--radius-chip)] corner-squircle box-border px-2 py-1 text-sm leading-none hover:bg-[var(--panel-strong)] {isSelected
            ? 'bg-[var(--accent)]/10 ring-1 ring-inset ring-[var(--accent)]'
            : ''} {!matches ? 'opacity-50' : ''}"
          style="height: {ITEM_HEIGHT}px; padding-left: {depth * 16 + 8}px"
        >
          {#if hasChildren}
            <button
              type="button"
              class="flex h-4 w-4 items-center justify-center text-[var(--muted)] cursor-pointer"
              onclick={() => onToggleExpand(treeNode.node.id)}
              aria-label="{isExpanded ? 'Collapse' : 'Expand'} {treeNode.node.name}"
              aria-expanded={isExpanded}
            >
              {isExpanded ? '▼' : '▶'}
            </button>
          {:else}
            <span class="flex h-4 w-4"></span>
          {/if}
          <span
            class="flex h-5 w-5 items-center justify-center rounded-[var(--radius-chip)] corner-squircle text-[10px] font-bold leading-none text-white"
            style="background-color: {kindColors[treeNode.node.kind]}"
          >
            {kindIcons[treeNode.node.kind]}
          </span>
          {#if treeNode.selectable}
            <a
              href={getNodeUrl(treeNode.node.id)}
              data-sveltekit-noscroll
              class="min-w-0 flex-1 truncate font-medium text-[var(--ink)]"
              onclick={() => { if (hasChildren) onToggleExpand(treeNode.node.id); }}
            >
              {treeNode.node.name}
            </a>
          {:else}
            <button
              type="button"
              class="min-w-0 flex-1 truncate text-left font-medium text-[var(--ink)] cursor-pointer"
              onclick={() => { if (hasChildren) onToggleExpand(treeNode.node.id); }}
            >
              {treeNode.node.name}
            </button>
          {/if}
          {#if treeNode.node.visibility === 'Public'}
            <span class="ml-auto text-[10px] leading-none text-[var(--accent)] font-medium">pub</span>
          {/if}
        </div>
      {/each}
    </div>
  </div>
</div>
