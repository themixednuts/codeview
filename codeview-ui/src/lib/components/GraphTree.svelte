<script lang="ts">
  import type { Graph, Node, NodeKind } from '$lib/graph';
  import { SvelteSet } from 'svelte/reactivity';
  import VirtualTree from './VirtualTree.svelte';

  // Constants moved to module level to avoid recreation
  const kindOrder: Record<NodeKind, number> = {
    Crate: 0,
    Module: 1,
    Trait: 2,
    Struct: 3,
    Enum: 4,
    Union: 5,
    TypeAlias: 6,
    Function: 7,
    Impl: 8,
    Method: 9,
    TraitAlias: 10
  };

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

  let {
    graph,
    selected,
    onSelect,
    filter,
    kindFilter
  } = $props<{
    graph: Graph | null;
    selected: Node | null;
    onSelect: (node: Node) => void;
    filter: string;
    kindFilter: Set<NodeKind>;
  }>();

  type TreeNode = {
    node: Node;
    children: TreeNode[];
    selectable: boolean;
  };

  const expandedIds = new SvelteSet<string>();

  // Memoization cache for tree building
  let cachedGraphId: string | null = null;
  let cachedTree: TreeNode[] = [];

  function getGraphId(graph: Graph): string {
    return `${graph.nodes.length}-${graph.edges.length}`;
  }

  function buildTree(graph: Graph): TreeNode[] {
    const graphId = getGraphId(graph);

    // Return cached if same graph
    if (cachedGraphId === graphId && cachedTree.length > 0) {
      return cachedTree;
    }

    // Use plain Map/Set for computation (no reactivity overhead)
    const nodeMap = new Map<string, Node>();
    const childrenMap = new Map<string, string[]>();

    for (const node of graph.nodes) {
      nodeMap.set(node.id, node);
    }

    // Build parent-child relationships from Contains/Defines edges
    for (const edge of graph.edges) {
      if (edge.kind === 'Contains' || edge.kind === 'Defines') {
        if (!childrenMap.has(edge.from)) {
          childrenMap.set(edge.from, []);
        }
        childrenMap.get(edge.from)!.push(edge.to);
      }
    }

    // Find root nodes (nodes that are not children of any other node)
    const childIds = new Set<string>();
    for (const children of childrenMap.values()) {
      for (const id of children) {
        childIds.add(id);
      }
    }

    const rootIds = graph.nodes
      .filter((n) => !childIds.has(n.id))
      .map((n) => n.id);

    function buildSubtree(id: string): TreeNode | null {
      const node = nodeMap.get(id);
      if (!node) return null;

      const childNodeIds = childrenMap.get(id) || [];
      const children = childNodeIds
        .map(buildSubtree)
        .filter((c): c is TreeNode => c !== null)
        .sort((a, b) => {
          const kindDiff = (kindOrder[a.node.kind] ?? 99) - (kindOrder[b.node.kind] ?? 99);
          if (kindDiff !== 0) return kindDiff;
          return a.node.name.localeCompare(b.node.name);
        });

      return {
        node,
        children,
        selectable: true
      };
    }

    const roots = rootIds
      .map(buildSubtree)
      .filter((t): t is TreeNode => t !== null);

    const crateRoots = roots
      .filter((root) => root.node.kind === 'Crate')
      .sort((a, b) => a.node.name.localeCompare(b.node.name));
    const otherRoots = roots
      .filter((root) => root.node.kind !== 'Crate')
      .sort((a, b) => a.node.name.localeCompare(b.node.name));

    let result: TreeNode[];
    if (otherRoots.length === 0) {
      result = crateRoots;
    } else {
      const syntheticNode: Node = {
        id: '__codeview_orphans__',
        name: 'Loose items',
        kind: 'Module',
        visibility: 'Unknown',
        attrs: [],
        is_external: false
      };

      const syntheticTree: TreeNode = {
        node: syntheticNode,
        children: otherRoots,
        selectable: false
      };

      result = [...crateRoots, syntheticTree];
    }

    // Cache the result
    cachedGraphId = graphId;
    cachedTree = result;

    return result;
  }

  function matchesFilter(node: Node, filter: string, kindFilter: Set<NodeKind>): boolean {
    if (kindFilter.size > 0 && !kindFilter.has(node.kind)) {
      return false;
    }
    if (!filter) return true;
    return (
      node.name.toLowerCase().includes(filter) ||
      node.id.toLowerCase().includes(filter)
    );
  }

  function hasMatchingDescendant(tree: TreeNode, filter: string, kindFilter: Set<NodeKind>): boolean {
    if (matchesFilter(tree.node, filter, kindFilter)) return true;
    return tree.children.some((c) => hasMatchingDescendant(c, filter, kindFilter));
  }

  // Memoization for filtered tree
  let filterCacheKey = '';
  let filterCacheResult: TreeNode[] = [];

  function filterTree(trees: TreeNode[], filter: string, kindFilter: Set<NodeKind>): TreeNode[] {
    return trees
      .filter((t) => hasMatchingDescendant(t, filter, kindFilter))
      .map((t) => ({
        ...t,
        children: filterTree(t.children, filter, kindFilter)
      }));
  }

  const normalizedFilter = $derived(filter.trim().toLowerCase());
  const baseTree = $derived.by(() => (graph ? buildTree(graph) : []));

  const tree = $derived.by(() => {
    if (!graph) return [];
    if (!normalizedFilter && kindFilter.size === 0) {
      return baseTree;
    }

    // Check filter cache
    const cacheKey = `${getGraphId(graph)}-${normalizedFilter}-${Array.from(kindFilter).sort().join(',')}`;
    if (cacheKey === filterCacheKey && filterCacheResult.length > 0) {
      return filterCacheResult;
    }

    const result = filterTree(baseTree, normalizedFilter, kindFilter);

    // Cache the result
    filterCacheKey = cacheKey;
    filterCacheResult = result;

    return result;
  });

  function toggleExpand(id: string) {
    if (expandedIds.has(id)) {
      expandedIds.delete(id);
    } else {
      expandedIds.add(id);
    }
  }

  function expandAll() {
    if (!graph) return;
    expandedIds.clear();
    for (const node of graph.nodes) {
      expandedIds.add(node.id);
    }
  }

  function collapseAll() {
    expandedIds.clear();
  }

  // Use virtualization for large trees
  const useVirtualization = $derived(graph ? graph.nodes.length > 500 : false);
</script>

<div class="flex h-full flex-col">
  <div class="flex items-center gap-2 border-b border-[var(--panel-border)] px-3 py-2">
    <button
      type="button"
      class="rounded px-2 py-1 text-xs text-[var(--muted)] hover:bg-[var(--panel-strong)]"
      onclick={expandAll}
    >
      Expand all
    </button>
    <button
      type="button"
      class="rounded px-2 py-1 text-xs text-[var(--muted)] hover:bg-[var(--panel-strong)]"
      onclick={collapseAll}
    >
      Collapse all
    </button>
  </div>

  {#if tree.length === 0}
    <div class="flex-1 p-2">
      <p class="p-4 text-center text-sm text-[var(--muted)]">
        {filter || kindFilter.size > 0 ? 'No matching items' : 'No items to display'}
      </p>
    </div>
  {:else if useVirtualization}
    <VirtualTree
      {tree}
      {selected}
      {onSelect}
      {expandedIds}
      onToggleExpand={toggleExpand}
      filter={normalizedFilter}
      {kindFilter}
    />
  {:else}
    <div class="flex-1 overflow-auto p-2">
      {#each tree as item (item.node.id)}
        {@render treeItem(item, 0)}
      {/each}
    </div>
  {/if}
</div>

{#snippet treeItem(item: TreeNode, depth: number)}
  {@const hasChildren = item.children.length > 0}
  {@const isExpanded = expandedIds.has(item.node.id)}
  {@const isSelected = item.selectable && selected?.id === item.node.id}
  {@const matches = matchesFilter(item.node, normalizedFilter, kindFilter)}

  <div class="select-none">
    <button
      type="button"
      class="flex w-full items-center gap-1 rounded px-2 py-1 text-left text-sm hover:bg-[var(--panel-strong)] {isSelected
        ? 'bg-[var(--accent)]/10 ring-1 ring-[var(--accent)]'
        : ''} {!matches ? 'opacity-50' : ''}"
      style="padding-left: {depth * 16 + 8}px"
      onclick={() => {
        if (hasChildren) toggleExpand(item.node.id);
        if (item.selectable) onSelect(item.node);
      }}
    >
      <span class="w-4 text-center text-[var(--muted)]">
        {#if hasChildren}
          {isExpanded ? '▼' : '▶'}
        {/if}
      </span>
      <span
        class="flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold text-white"
        style="background-color: {kindColors[item.node.kind]}"
      >
        {kindIcons[item.node.kind]}
      </span>
      <span class="truncate font-medium text-[var(--ink)]">{item.node.name}</span>
      {#if item.node.visibility === 'Public'}
        <span class="text-[10px] text-green-600">pub</span>
      {/if}
    </button>
    {#if hasChildren && isExpanded}
      {#each item.children as child (child.node.id)}
        {@render treeItem(child, depth + 1)}
      {/each}
    {/if}
  </div>
{/snippet}
