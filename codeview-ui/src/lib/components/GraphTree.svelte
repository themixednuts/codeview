<script lang="ts">
  import type { Graph, Node, NodeKind } from '$lib/graph';
  import { SvelteSet } from 'svelte/reactivity';
  import { kindOrder, matchesFilter, type TreeNode } from '$lib/tree';
  import { KeyedMemo, keyEqual, keyOf } from '$lib/reactivity.svelte';
  import TreeItem from './TreeItem.svelte';
  import VirtualTree from './VirtualTree.svelte';
  import { perf } from '$lib/perf';
  import { perfTick } from '$lib/perf.svelte';
  import { getLogger } from '$lib/log';

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
  const log = getLogger('graph-tree');

  const expandedIds = new SvelteSet<string>();
  // Tracks nodes the user explicitly collapsed — prevents selectedAncestorIds
  // from forcing ancestor nodes back open after the user collapses them.
  const collapsedIds = new SvelteSet<string>();

  const indexedNodes = new Map<string, Node>();
  const indexedParentMap = new Map<string, string>();
  const indexedChildIds = new Map<string, string[]>();
  const indexedRootIds: string[] = [];
  const indexedTreeNodes = new Map<string, TreeNode>();
  const indexedRootTreeNodes: TreeNode[] = [];

  let indexedNodeArrayRef: Graph['nodes'] | null = null;
  let indexedEdgeArrayRef: Graph['edges'] | null = null;
  let indexedNodeLength = 0;
  let indexedEdgeLength = 0;
  let indexedVersion = 0;
  let renderedTreeVersion = -1;
  let renderedTreeRoots: TreeNode[] = [];

  function compareNodeIds(a: string, b: string): number {
    const an = indexedNodes.get(a);
    const bn = indexedNodes.get(b);
    if (!an && !bn) return a.localeCompare(b);
    if (!an) return 1;
    if (!bn) return -1;
    const kindDiff = (kindOrder[an.kind] ?? 99) - (kindOrder[bn.kind] ?? 99);
    if (kindDiff !== 0) return kindDiff;
    return an.name.localeCompare(bn.name);
  }

  function insertSortedUnique(list: string[], id: string) {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const cmp = compareNodeIds(id, list[mid]);
      if (cmp === 0 && list[mid] === id) return;
      if (cmp > 0) lo = mid + 1;
      else hi = mid;
    }
    if (list[lo] === id) return;
    list.splice(lo, 0, id);
  }

  function removeId(list: string[], id: string) {
    const idx = list.indexOf(id);
    if (idx >= 0) list.splice(idx, 1);
  }

  function resetIndex() {
    indexedNodes.clear();
    indexedParentMap.clear();
    indexedChildIds.clear();
    indexedRootIds.length = 0;
    indexedTreeNodes.clear();
    indexedRootTreeNodes.length = 0;
    indexedNodeArrayRef = null;
    indexedEdgeArrayRef = null;
    indexedNodeLength = 0;
    indexedEdgeLength = 0;
    indexedVersion += 1;
  }

  function rebuildIndex(graph: Graph) {
    resetIndex();

    // Pass 1: register nodes.
    for (const node of graph.nodes) {
      indexedNodes.set(node.id, node);
      indexedChildIds.set(node.id, []);
    }

    // Pass 2: register parent links from structural edges.
    for (const edge of graph.edges) {
      if (edge.kind !== "Contains" && edge.kind !== "Defines") continue;
      if (indexedParentMap.has(edge.to)) continue;
      if (!indexedNodes.has(edge.from) || !indexedNodes.has(edge.to)) continue;
      indexedParentMap.set(edge.to, edge.from);
      const children = indexedChildIds.get(edge.from);
      if (children) children.push(edge.to);
    }

    // Pass 3: sort child lists once.
    for (const children of indexedChildIds.values()) {
      if (children.length > 1) children.sort(compareNodeIds);
    }

    // Pass 4: roots.
    for (const nodeId of indexedNodes.keys()) {
      if (!indexedParentMap.has(nodeId)) indexedRootIds.push(nodeId);
    }
    if (indexedRootIds.length > 1) indexedRootIds.sort(compareNodeIds);

    // Pass 5: create tree nodes once.
    for (const nodeId of indexedNodes.keys()) {
      const node = indexedNodes.get(nodeId);
      if (!node) continue;
      indexedTreeNodes.set(nodeId, { node, children: [], selectable: true });
    }

    // Pass 6: attach children.
    for (const [parentId, children] of indexedChildIds) {
      const parentTree = indexedTreeNodes.get(parentId);
      if (!parentTree || children.length === 0) continue;
      for (const childId of children) {
        const childTree = indexedTreeNodes.get(childId);
        if (childTree) parentTree.children.push(childTree);
      }
    }

    // Pass 7: root tree nodes.
    for (const rootId of indexedRootIds) {
      const rootTree = indexedTreeNodes.get(rootId);
      if (rootTree) indexedRootTreeNodes.push(rootTree);
    }
  }

  function compareTreeNodes(a: TreeNode, b: TreeNode): number {
    const kindDiff = (kindOrder[a.node.kind] ?? 99) - (kindOrder[b.node.kind] ?? 99);
    if (kindDiff !== 0) return kindDiff;
    return a.node.name.localeCompare(b.node.name);
  }

  function insertSortedUniqueTreeNode(list: TreeNode[], node: TreeNode) {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const cmp = compareTreeNodes(node, list[mid]);
      if (cmp === 0 && list[mid].node.id === node.node.id) return;
      if (cmp > 0) lo = mid + 1;
      else hi = mid;
    }
    if (list[lo]?.node.id === node.node.id) return;
    list.splice(lo, 0, node);
  }

  function removeTreeNodeById(list: TreeNode[], nodeId: string) {
    const idx = list.findIndex((n) => n.node.id === nodeId);
    if (idx >= 0) list.splice(idx, 1);
  }

  function ensureTreeNode(nodeId: string): TreeNode | null {
    const node = indexedNodes.get(nodeId);
    if (!node) return null;
    const existing = indexedTreeNodes.get(nodeId);
    if (existing) {
      if (existing.node !== node) existing.node = node;
      return existing;
    }
    const created: TreeNode = { node, children: [], selectable: true };
    indexedTreeNodes.set(nodeId, created);
    return created;
  }

  function attachTreeNode(nodeId: string): boolean {
    const treeNode = ensureTreeNode(nodeId);
    if (!treeNode) return false;

    const parentId = indexedParentMap.get(nodeId);
    if (!parentId) {
      insertSortedUniqueTreeNode(indexedRootTreeNodes, treeNode);
      return true;
    }

    const parentTree = ensureTreeNode(parentId);
    if (!parentTree) return false;
    removeTreeNodeById(indexedRootTreeNodes, nodeId);
    insertSortedUniqueTreeNode(parentTree.children, treeNode);
    return true;
  }

  function addIndexedNode(node: Node): boolean {
    const existed = indexedNodes.has(node.id);
    indexedNodes.set(node.id, node);
    if (!existed) {
      if (!indexedParentMap.has(node.id)) insertSortedUnique(indexedRootIds, node.id);
      let changed = attachTreeNode(node.id);
      for (const childId of indexedChildIds.get(node.id) ?? []) {
        changed = attachTreeNode(childId) || changed;
      }
      return changed;
    }
    return false;
  }

  function addIndexedEdge(from: string, to: string): boolean {
    if (indexedParentMap.has(to)) return false;
    indexedParentMap.set(to, from);
    const children = indexedChildIds.get(from) ?? [];
    if (!indexedChildIds.has(from)) indexedChildIds.set(from, children);
    insertSortedUnique(children, to);
    removeId(indexedRootIds, to);
    attachTreeNode(to);
    return true;
  }

  function appendIndex(graph: Graph, nodeStart: number, edgeStart: number): boolean {
    let changed = false;

    for (let i = nodeStart; i < graph.nodes.length; i++) {
      if (addIndexedNode(graph.nodes[i])) changed = true;
    }

    for (let i = edgeStart; i < graph.edges.length; i++) {
      const edge = graph.edges[i];
      if (edge.kind !== 'Contains' && edge.kind !== 'Defines') continue;
      if (addIndexedEdge(edge.from, edge.to)) changed = true;
    }

    return changed;
  }

  function ensureIndexed(graph: Graph): 'rebuild' | 'delta' | 'noop' {
    const requiresRebuild =
      indexedNodeArrayRef !== graph.nodes ||
      indexedEdgeArrayRef !== graph.edges ||
      graph.nodes.length < indexedNodeLength ||
      graph.edges.length < indexedEdgeLength;

    if (requiresRebuild) {
      rebuildIndex(graph);
      indexedNodeArrayRef = graph.nodes;
      indexedEdgeArrayRef = graph.edges;
      indexedNodeLength = graph.nodes.length;
      indexedEdgeLength = graph.edges.length;
      indexedVersion += 1;
      return 'rebuild';
    }

    if (graph.nodes.length === indexedNodeLength && graph.edges.length === indexedEdgeLength) {
      return 'noop';
    }

    const changed = appendIndex(graph, indexedNodeLength, indexedEdgeLength);
    indexedNodeLength = graph.nodes.length;
    indexedEdgeLength = graph.edges.length;
    if (changed) indexedVersion += 1;
    return changed ? 'delta' : 'noop';
  }

  function filterTree(trees: TreeNode[], filter: string, kindFilter: Set<NodeKind>): TreeNode[] {
    function filterNode(node: TreeNode): TreeNode | null {
      const filteredChildren: TreeNode[] = [];
      for (const child of node.children) {
        const next = filterNode(child);
        if (next) filteredChildren.push(next);
      }

      const selfMatches = matchesFilter(node.node, filter, kindFilter);
      if (!selfMatches && filteredChildren.length === 0) return null;
      if (filteredChildren.length === node.children.length) return node;
      return {
        node: node.node,
        selectable: node.selectable,
        children: filteredChildren
      };
    }

    const result: TreeNode[] = [];
    for (const tree of trees) {
      const filtered = filterNode(tree);
      if (filtered) result.push(filtered);
    }
    return result;
  }

  function cloneTree(nodes: TreeNode[]): TreeNode[] {
    const out: TreeNode[] = [];
    for (const node of nodes) {
      const clonedChildren = cloneTree(node.children);
      out.push({
        node: node.node,
        selectable: node.selectable,
        children: clonedChildren
      });
    }
    return out;
  }

  const normalizedFilter = $derived(filter.trim().toLowerCase());

  const indexedTreeMemo = new KeyedMemo(
    () => keyOf(graph?.nodes, graph?.edges, graph?.nodes.length ?? 0, graph?.edges.length ?? 0),
    () => {
      if (!graph) {
        resetIndex();
        renderedTreeVersion = -1;
        renderedTreeRoots = [];
        return {
          tree: [] as TreeNode[],
          parentMap: indexedParentMap,
          version: indexedVersion
        };
      }
      const mode = ensureIndexed(graph);
      if (indexedVersion !== renderedTreeVersion) {
        const t0 = performance.now();
        // Avoid deep clone of the full tree on large crates.
        renderedTreeRoots = indexedRootTreeNodes;
        renderedTreeVersion = indexedVersion;
        const ms = performance.now() - t0;
        if (ms > 120) {
          log.warn`cloneTree slow ${Math.round(ms)}ms nodes=${graph.nodes.length} edges=${graph.edges.length} mode=${mode}`;
        }
      }
      const tree = perf.time('derived', 'baseTree', () => renderedTreeRoots, {
        detail: () => `${graph.nodes.length}n ${mode}`
      });
      return {
        tree,
        parentMap: indexedParentMap,
        version: indexedVersion
      };
    },
    { equalsKey: keyEqual }
  );
  const indexedTree = $derived(indexedTreeMemo.current);
  const parentMap = $derived(indexedTree.parentMap);
  const baseTree = $derived(indexedTree.tree);

  const tree = $derived.by(() => {
    if (!graph) return [];
    if (!normalizedFilter && kindFilter.size === 0) {
      return baseTree;
    }
    return perf.time('derived', 'filterTree', () => filterTree(baseTree, normalizedFilter, kindFilter));
  });

  const ancestorMemo = new KeyedMemo(
    () => keyOf(selected?.id ?? null, indexedTree.version),
    () => {
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
    },
    { equalsKey: keyEqual }
  );
  const selectedAncestorIds = $derived(ancestorMemo.current);

  const expandedIdsForRender = new SvelteSet<string>();
  const expandedIdsForRenderScratch = new Set<string>();
  let expandedVersion = $state(0);
  $effect(() => {
    perf.time('derived', 'expandedIdsForRender', () => {
      expandedIdsForRenderScratch.clear();
      for (const id of expandedIds) expandedIdsForRenderScratch.add(id);
      for (const id of selectedAncestorIds) {
        if (!collapsedIds.has(id)) expandedIdsForRenderScratch.add(id);
      }

      let changed = false;
      for (const id of expandedIdsForRender) {
        if (!expandedIdsForRenderScratch.has(id)) {
          expandedIdsForRender.delete(id);
          changed = true;
        }
      }
      for (const id of expandedIdsForRenderScratch) {
        if (!expandedIdsForRender.has(id)) {
          expandedIdsForRender.add(id);
          changed = true;
        }
      }
      if (changed) expandedVersion += 1;
      return expandedIdsForRender;
    }, {
      detail: () => `${expandedIdsForRender.size} ids`
    });
  });

  // Auto-expand the selected node when selection changes.
  // Uses $effect.pre so the mutation happens before DOM reconciliation,
  // avoiding cascading re-renders that corrupt keyed {#each} blocks.
  let lastAutoExpandedId: string | null = null;
  $effect.pre(() => {
    if (selected && selected.id !== lastAutoExpandedId) {
      lastAutoExpandedId = selected.id;
      expandedIds.add(selected.id);
      collapsedIds.clear();
    }
  });

  function toggleExpand(id: string) {
    if (expandedIdsForRender.has(id)) {
      expandedIds.delete(id);
      collapsedIds.add(id);
    } else {
      expandedIds.add(id);
      collapsedIds.delete(id);
    }
  }

  /** Row-click logic: toggle only for non-selectable nodes. */
  function selectExpand(
    id: string,
    _isSelected: boolean,
    isExpanded: boolean,
    hasChildren: boolean,
    selectable: boolean
  ) {
    if (selectable || !hasChildren) return;
    toggleExpand(id);
  }

  function expandAll() {
    if (!graph) return;
    collapsedIds.clear();
    expandedIds.clear();
    for (const node of graph.nodes) {
      expandedIds.add(node.id);
    }
  }

  function collapseAll() {
    expandedIds.clear();
    collapsedIds.clear();
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
        treeVersion={indexedTree.version}
        expandedVersion={expandedVersion}
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
      if (!item.selectable && hasChildren) toggleExpand(item.node.id);
    }}
  />
  {#if hasChildren && isExpanded}
    {#each item.children as child (child.node.id)}
      {@render treeItem(child, depth + 1, item.node.id)}
    {/each}
  {/if}
{/snippet}
