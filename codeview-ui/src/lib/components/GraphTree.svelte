<script lang="ts">
  import type { Graph, Node, NodeKind } from '$lib/graph';
  import { SvelteSet } from 'svelte/reactivity';
  import { kindOrder, matchesFilter, hasMatchingDescendant, type TreeNode } from '$lib/tree-constants';
  import { KeyedMemo, Memo } from '$lib/reactivity.svelte';
  import TreeItem from './TreeItem.svelte';
  import VirtualTree from './VirtualTree.svelte';
  import { perf } from '$lib/perf';
  import { perfTick } from '$lib/perf.svelte';

  let {
    graph,
    selected,
    getNodeUrl,
    filter,
    kindFilter
  } = $props<{
    graph: Graph | null;
    selected: Node | null;
    getNodeUrl: (id: string, parent?: string) => string;
    filter: string;
    kindFilter: Set<NodeKind>;
  }>();

  const expandedIds = new SvelteSet<string>();

  function buildTree(graph: Graph, parentMap: Map<string, string>): TreeNode[] {
    const nodeMap = new Map<string, Node>();
    const childrenMap = new Map<string, string[]>();

    for (const node of graph.nodes) {
      nodeMap.set(node.id, node);
    }

    for (const edge of graph.edges) {
      if (edge.kind === 'Contains' || edge.kind === 'Defines') {
        if (!childrenMap.has(edge.from)) {
          childrenMap.set(edge.from, []);
        }
        childrenMap.get(edge.from)!.push(edge.to);
      }
    }

    // Find root nodes (nodes that are not children of any other node)
    const childIds = new Set(parentMap.keys());

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

    return roots.sort((a, b) => {
      const kindDiff = (kindOrder[a.node.kind] ?? 99) - (kindOrder[b.node.kind] ?? 99);
      if (kindDiff !== 0) return kindDiff;
      return a.node.name.localeCompare(b.node.name);
    });
  }

  function filterTree(trees: TreeNode[], filter: string, kindFilter: Set<NodeKind>): TreeNode[] {
    return trees
      .filter((t) => hasMatchingDescendant(t, filter, kindFilter))
      .map((t) => ({
        ...t,
        children: filterTree(t.children, filter, kindFilter)
      }));
  }

  const normalizedFilter = $derived(filter.trim().toLowerCase());

  // Reactive parent map: child ID → parent ID, built from Contains/Defines edges
  const parentMapMemo = new KeyedMemo(
    () => graph,
    () => {
      if (!graph) return new Map<string, string>();
      return perf.time('derived', 'parentMap', () => {
        const map = new Map<string, string>();
        for (const edge of graph!.edges) {
          if (edge.kind === 'Contains' || edge.kind === 'Defines') {
            if (!map.has(edge.to)) {
              map.set(edge.to, edge.from);
            }
          }
        }
        return map;
      }, {
        detail: (map) => `${map.size} entries`
      });
    }
  );
  const parentMap = $derived(parentMapMemo.current);

  const baseTreeMemo = new KeyedMemo(
    () => graph,
    () => {
      if (!graph) return [] as TreeNode[];
      return perf.time('derived', 'baseTree', () => buildTree(graph!, parentMap), {
        detail: () => `${graph!.nodes.length}n`
      });
    }
  );
  const baseTree = $derived(baseTreeMemo.current);

  const tree = $derived.by(() => {
    if (!graph) return [];
    if (!normalizedFilter && kindFilter.size === 0) {
      return baseTree;
    }
    return perf.time('derived', 'filterTree', () => filterTree(baseTree, normalizedFilter, kindFilter));
  });

  const ancestorMemo = new Memo(() => {
    const selId = selected?.id;
    if (!selId) return [] as string[];
    const ancestors: string[] = [];
    let currentId = selId;
    while (parentMap.has(currentId)) {
      const pid = parentMap.get(currentId)!;
      ancestors.push(pid);
      currentId = pid;
    }
    return ancestors;
  });
  const selectedAncestorIds = $derived(ancestorMemo.current);

  // Cache expandedIdsForRender to avoid creating a new Set reference when contents
  // haven't changed — a new reference triggers flatNodes in VirtualTree to re-evaluate.
  const expandedForRenderMemo = new Memo(() => {
    return perf.time('derived', 'expandedIdsForRender', () => {
      const ids: string[] = [];
      for (const id of expandedIds) ids.push(id);
      for (const id of selectedAncestorIds) ids.push(id);
      return new Set(ids);
    }, {
      detail: (s) => `${s.size} ids`
    });
  });
  const expandedIdsForRender = $derived(expandedForRenderMemo.current);

  // Auto-expand the selected node when selection changes.
  // Uses $effect.pre so the mutation happens before DOM reconciliation,
  // avoiding cascading re-renders that corrupt keyed {#each} blocks.
  let lastAutoExpandedId: string | null = null;
  $effect.pre(() => {
    if (selected && selected.id !== lastAutoExpandedId) {
      lastAutoExpandedId = selected.id;
      expandedIds.add(selected.id);
    }
  });

  function toggleExpand(id: string) {
    if (expandedIds.has(id)) {
      expandedIds.delete(id);
    } else {
      expandedIds.add(id);
    }
  }

  /** Row-click logic: expand collapsed parents, collapse re-clicked active parents */
  function selectExpand(id: string, isSelected: boolean, isExpanded: boolean, hasChildren: boolean) {
    if (!hasChildren) return;
    if (!isExpanded) {
      expandedIds.add(id);
    } else if (isSelected) {
      expandedIds.delete(id);
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

  // Track render timing
  let lastGraphId = '';
  $effect(() => {
    const gid = graph?.nodes[0]?.id ?? '';
    if (gid !== lastGraphId) {
      lastGraphId = gid;
      perfTick('render', 'GraphTree tick');
    }
  });

</script>

<div class="flex h-full flex-col">
  <div class="flex items-center gap-2 border-b border-[var(--panel-border)] px-3 py-2">
    <button
      type="button"
      class="badge badge-sm hover:bg-[var(--panel-strong)] transition-colors"
      onclick={expandAll}
    >
      Expand all
    </button>
    <button
      type="button"
      class="badge badge-sm hover:bg-[var(--panel-strong)] transition-colors"
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
    <svelte:boundary>
      <VirtualTree
        {tree}
        {selected}
        {getNodeUrl}
        expandedIds={expandedIdsForRender}
        onToggleExpand={toggleExpand}
        onSelectExpand={selectExpand}
        filter={normalizedFilter}
        {kindFilter}
      />
      {#snippet failed(error, reset)}
        <div class="p-4 text-sm text-[var(--danger)]">
          <p>Tree render error</p>
          <button type="button" class="mt-1 text-[var(--accent)] hover:underline" onclick={reset}>Retry</button>
        </div>
      {/snippet}
    </svelte:boundary>
  {:else}
    <svelte:boundary>
      <div class="flex-1 overflow-auto p-2" style="scrollbar-gutter: stable;">
        {#each tree as item (item.node.id)}
          {@render treeItem(item, 0, undefined)}
        {/each}
      </div>
      {#snippet failed(error, reset)}
        <div class="p-4 text-sm text-[var(--danger)]">
          <p>Tree render error</p>
          <button type="button" class="mt-1 text-[var(--accent)] hover:underline" onclick={reset}>Retry</button>
        </div>
      {/snippet}
    </svelte:boundary>
  {/if}
</div>

{#snippet treeItem(item: TreeNode, depth: number, parentId: string | undefined)}
  {@const hasChildren = item.children.length > 0}
  {@const isExpanded = expandedIdsForRender.has(item.node.id)}
  {@const isSelected = item.selectable && selected?.id === item.node.id}
  {@const matches = matchesFilter(item.node, normalizedFilter, kindFilter)}

  <TreeItem
    node={item.node}
    {depth}
    {hasChildren}
    {isExpanded}
    {isSelected}
    dimmed={!matches}
    selectable={item.selectable}
    href={getNodeUrl(item.node.id, parentId)}
    onToggle={() => { if (hasChildren) toggleExpand(item.node.id); }}
    onSelect={() => {
      if (hasChildren && !isExpanded) expandedIds.add(item.node.id);
      else if (hasChildren && isSelected && isExpanded) expandedIds.delete(item.node.id);
    }}
  />
  {#if hasChildren && isExpanded}
    {#each item.children as child (child.node.id)}
      {@render treeItem(child, depth + 1, item.node.id)}
    {/each}
  {/if}
{/snippet}
