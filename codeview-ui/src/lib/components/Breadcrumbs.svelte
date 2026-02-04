<script lang="ts">
  import type { Graph, Node, NodeKind } from '$lib/graph';
  import { kindColors } from '$lib/tree';
  import { KeyedMemo, keyOf, keyEqual } from '$lib/reactivity.svelte';
  import { perf } from '$lib/perf';
  import { getLogger } from '$lib/log';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';

  const log = getLogger('breadcrumbs');

  let { graph, selected, getNodeUrl, parentHint } = $props<{
    graph: Graph;
    selected: Node;
    getNodeUrl: (id: string) => string;
    parentHint?: string;
  }>();

  // Build path by walking Contains/Defines edges from selected node to root
  // Use KeyedMemo to skip expensive computation when inputs haven't changed
  const pathMemo = new KeyedMemo(
    () => keyOf(graph?.nodes?.length, graph?.edges?.length, selected?.id, parentHint),
    () => {
    return perf.time('derived', 'breadcrumbs.path', () => {
      if (!graph || !selected) {
        log.debug`no graph or selected node`;
        return [];
      }

      const nodeMap = new Map<string, Node>();
      for (const node of graph.nodes) {
        nodeMap.set(node.id, node);
      }

      // Check if selected node exists in graph
      if (!nodeMap.has(selected.id)) {
        log.debug`selected node "${selected.id}" not in graph (${graph.nodes.length} nodes)`;
        // Return just the selected node as a fallback
        return [selected];
      }

      // Build parent map from Contains/Defines edges
      const parentMap = new Map<string, string>();
      for (const edge of graph.edges) {
        if (edge.kind === 'Contains' || edge.kind === 'Defines') {
          parentMap.set(edge.to, edge.from);
        }
      }

      // Override with parent hint if provided (for shared nodes like methods
      // that belong to multiple impl blocks)
      if (parentHint && nodeMap.has(parentHint)) {
        parentMap.set(selected.id, parentHint);
      }

      // Walk up from selected node to root
      const ancestors: Node[] = [];
      let currentId: string | undefined = selected.id;

      // Prevent infinite loops with a visited set
      const visited = new Set<string>();
      while (currentId && !visited.has(currentId)) {
        visited.add(currentId);
        const node = nodeMap.get(currentId);
        if (node) {
          ancestors.unshift(node);
        }
        currentId = parentMap.get(currentId);
      }

      log.debug`built path for "${selected.name}": ${ancestors.length} ancestors`;
      return ancestors;
    }, { detail: (r) => `${r.length} ancestors` });
  },
    { equalsKey: keyEqual }
  );
  let path = $derived(pathMemo.current);

  // Truncate path if too long, keeping first and last items visible
  // Use KeyedMemo keyed on path length to avoid recomputing
  const displayPathMemo = new KeyedMemo(
    () => path.length,
    () => {
    if (path.length <= 4) return { items: path, truncated: false as const };

    // Show: first, ..., second-to-last, last
    return {
      items: [path[0], path[path.length - 2], path[path.length - 1]],
      truncated: true as const,
      hiddenCount: path.length - 3
    };
  });
  let displayPath = $derived(displayPathMemo.current);
</script>

{#if path.length > 0}
  <nav class="flex items-center gap-1 text-sm overflow-x-auto pb-1" aria-label="Breadcrumb">
    {#each displayPath.items as node, index (node.id)}
      {#if index > 0}
        {#if displayPath.truncated && index === 1}
          <span class="text-[var(--muted)] px-1">...</span>
          <ChevronRight size={16} class="text-[var(--muted)] flex-shrink-0" />
        {:else}
          <ChevronRight size={16} class="text-[var(--muted)] flex-shrink-0" />
        {/if}
      {/if}

      {#if node.id === selected.id}
        <!-- Current node (not clickable) -->
        <span class="badge badge-strong badge-lg gap-1.5">
          <span
            class="w-2 h-2 rounded-full flex-shrink-0"
            style="background-color: {kindColors[node.kind as NodeKind]}"
          ></span>
          <span class="font-medium text-[var(--ink)] truncate max-w-[150px]">{node.name}</span>
        </span>
      {:else}
        <!-- Ancestor node (clickable) -->
        <a
          href={getNodeUrl(node.id)}
          data-sveltekit-noscroll
          class="badge badge-lg gap-1.5 text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--panel-strong)] transition-colors"
        >
          <span
            class="w-2 h-2 rounded-full flex-shrink-0"
            style="background-color: {kindColors[node.kind as NodeKind]}"
          ></span>
          <span class="truncate max-w-[150px]">{node.name}</span>
        </a>
      {/if}
    {/each}
  </nav>
{:else}
  <!-- Fallback when path is empty -->
  <nav class="flex items-center gap-1 text-sm overflow-x-auto pb-1" aria-label="Breadcrumb">
    <span class="badge badge-strong badge-lg gap-1.5">
      <span
        class="w-2 h-2 rounded-full flex-shrink-0"
        style="background-color: {kindColors[selected.kind as NodeKind]}"
      ></span>
      <span class="font-medium text-[var(--ink)] truncate max-w-[150px]">{selected.name}</span>
    </span>
  </nav>
{/if}
