<script lang="ts">
  import type { Graph, Node, NodeKind } from '$lib/graph';

  let { graph, selected, getNodeUrl } = $props<{
    graph: Graph;
    selected: Node;
    getNodeUrl: (id: string) => string;
  }>();

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

  // Build path by walking Contains/Defines edges from selected node to root
  let path = $derived.by(() => {
    const nodeMap = new Map<string, Node>();
    for (const node of graph.nodes) {
      nodeMap.set(node.id, node);
    }

    // Build parent map from Contains/Defines edges
    const parentMap = new Map<string, string>();
    for (const edge of graph.edges) {
      if (edge.kind === 'Contains' || edge.kind === 'Defines') {
        // edge.from contains edge.to, so parent of 'to' is 'from'
        parentMap.set(edge.to, edge.from);
      }
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

  // Truncate path if too long, keeping first and last items visible
  let displayPath = $derived.by(() => {
    if (path.length <= 4) return { items: path, truncated: false };

    // Show: first, ..., second-to-last, last
    return {
      items: [path[0], path[path.length - 2], path[path.length - 1]],
      truncated: true,
      hiddenCount: path.length - 3
    };
  });
</script>

{#if path.length > 1}
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
        <span class="flex items-center gap-1.5 px-2 py-1 rounded-[var(--radius-chip)] corner-squircle bg-[var(--panel-strong)]">
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
          class="flex items-center gap-1.5 px-2 py-1 rounded-[var(--radius-chip)] corner-squircle hover:bg-[var(--panel-strong)] transition-colors"
        >
          <span
            class="w-2 h-2 rounded-full flex-shrink-0"
            style="background-color: {kindColors[node.kind]}"
          ></span>
          <span class="text-[var(--muted)] hover:text-[var(--ink)] truncate max-w-[150px]">{node.name}</span>
        </a>
      {/if}
    {/each}
  </nav>
{/if}
