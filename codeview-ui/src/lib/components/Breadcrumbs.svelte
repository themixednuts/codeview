<script lang="ts">
  import type { Graph, Node } from '$lib/graph';
  import { kindColors } from '$lib/tree-constants';
  import { Memo } from '$lib/reactivity.svelte';

  let { graph, selected, getNodeUrl, parentHint } = $props<{
    graph: Graph;
    selected: Node;
    getNodeUrl: (id: string) => string;
    parentHint?: string;
  }>();

  // Build path by walking Contains/Defines edges from selected node to root
  const pathMemo = new Memo(() => {
    const nodeMap = new Map<string, Node>();
    for (const node of graph.nodes) {
      nodeMap.set(node.id, node);
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

    return ancestors;
  });
  let path = $derived(pathMemo.current);

  // Truncate path if too long, keeping first and last items visible
  const displayPathMemo = new Memo(() => {
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

<nav class="flex items-center gap-1 text-sm overflow-x-auto pb-1" aria-label="Breadcrumb">
  {#each displayPath.items as node, index (node.id)}
    {#if index > 0}
      {#if displayPath.truncated && index === 1}
        <span class="text-[var(--muted)] px-1">...</span>
        <svg class="w-4 h-4 text-[var(--muted)] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
        </svg>
      {:else}
        <svg class="w-4 h-4 text-[var(--muted)] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
        </svg>
      {/if}
    {/if}

    {#if node.id === selected.id}
      <!-- Current node (not clickable) -->
      <span class="badge badge-strong badge-lg gap-1.5">
        <span
          class="w-2 h-2 rounded-full flex-shrink-0"
          style="background-color: {kindColors[node.kind]}"
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
          style="background-color: {kindColors[node.kind]}"
        ></span>
        <span class="truncate max-w-[150px]">{node.name}</span>
      </a>
    {/if}
  {/each}
</nav>
