<script lang="ts">
  import type { Node, NodeKind } from '$lib/graph';
  import { SvelteSet } from 'svelte/reactivity';
  import { getContext, setContext } from 'svelte';
  import { page } from '$app/state';
  import { browser } from '$app/environment';
  import { getAllCrateTrees, searchNodes } from '$lib/graph.remote';
  import { nodeUrl } from '$lib/url';
  import GraphTree from '$lib/components/GraphTree.svelte';

  /** Kind badge colors */
  const kindColors: Record<NodeKind, string> = {
    Crate: '#e85d04', Module: '#2d6a4f', Struct: '#9d4edd', Union: '#7b2cbf',
    Enum: '#3a86ff', Trait: '#06d6a0', TraitAlias: '#0db39e', Impl: '#8d99ae',
    Function: '#f72585', Method: '#b5179e', TypeAlias: '#ff6d00'
  };
  const kindIcons: Record<NodeKind, string> = {
    Crate: '📦', Module: '📁', Struct: 'S', Union: 'U', Enum: 'E',
    Trait: 'T', TraitAlias: 'T', Impl: 'I', Function: 'fn', Method: 'fn', TypeAlias: '='
  };

  let { children } = $props();
  const getTheme = getContext<() => 'light' | 'dark'>('theme');
  const theme = $derived(getTheme());

  const params = $derived(page.params);
  const crateName = $derived(params.crate);
  const version = $derived(params.version);

  // Load all crate trees for the sidebar
  const treeQuery = getAllCrateTrees();

  const crateVersions = $derived.by(() => {
    if (treeQuery.loading || !treeQuery.current) return {} as Record<string, string>;
    return treeQuery.current.crateVersions;
  });

  const getNodeUrl = $derived((id: string) => nodeUrl(id, crateVersions));

  setContext('getNodeUrl', () => getNodeUrl);
  setContext('crateVersions', () => crateVersions);

  // Build a Graph-shaped object for GraphTree from the tree response
  const treeGraph = $derived.by(() => {
    if (treeQuery.loading || !treeQuery.current) return null;
    return {
      nodes: treeQuery.current.nodes as Node[],
      edges: treeQuery.current.edges
    };
  });

  // Search / filter state from URL
  const filter = $derived(browser ? (page.url.searchParams.get('q') ?? '') : '');
  const hideExternal = $derived(browser ? page.url.searchParams.get('deps') !== 'show' : true);

  // Server-side search when there's a query
  const searchQuery = $derived(filter ? searchNodes({ crate: crateName, q: filter }) : null);

  const kindFilter = new SvelteSet<NodeKind>();

  const nodeKindOrder: NodeKind[] = [
    'Crate', 'Module', 'Struct', 'Enum', 'Trait', 'Impl',
    'Function', 'Method', 'TypeAlias', 'Union', 'TraitAlias'
  ];

  const kindLabels: Record<NodeKind, string> = {
    Crate: 'Crate', Module: 'Module', Struct: 'Struct', Union: 'Union',
    Enum: 'Enum', Trait: 'Trait', TraitAlias: 'Trait alias', Impl: 'Impl',
    Function: 'Function', Method: 'Method', TypeAlias: 'Type alias'
  };

  // Filter graph to hide external + impl blocks for tree display
  const graphForDisplay = $derived.by(() => {
    if (!treeGraph) return null;
    let nodes = treeGraph.nodes;
    let edges = treeGraph.edges;

    if (hideExternal) {
      const nonExternalIds = new Set(nodes.filter((n) => !n.is_external).map((n) => n.id));
      nodes = nodes.filter((n) => !n.is_external);
      edges = edges.filter((e) => nonExternalIds.has(e.from) && nonExternalIds.has(e.to));
    }

    // Filter out impl blocks from tree
    const implIds = new Set(nodes.filter((n) => n.kind === 'Impl').map((n) => n.id));
    if (implIds.size > 0) {
      nodes = nodes.filter((n) => !implIds.has(n.id));
      edges = edges.filter((e) => !implIds.has(e.from) && !implIds.has(e.to));
    }

    return { nodes, edges };
  });

  setContext('graphForDisplay', () => graphForDisplay);

  const stats = $derived.by(() => {
    if (!graphForDisplay) return { kindCounts: [] as { kind: NodeKind; count: number }[], externalCount: 0 };
    const externalCount = treeGraph?.nodes.filter((n) => n.is_external).length ?? 0;
    const kindCounts = nodeKindOrder
      .map((kind) => ({
        kind,
        count: graphForDisplay.nodes.filter((n) => n.kind === kind).length
      }))
      .filter((e) => e.count > 0);
    return { kindCounts, externalCount };
  });

  function toggleKindFilter(kind: NodeKind) {
    if (kindFilter.has(kind)) {
      kindFilter.delete(kind);
    } else {
      kindFilter.add(kind);
    }
  }

  // Derive selected node ID from the current path
  const selectedNodeId = $derived.by(() => {
    const pathParam = page.params.path;
    if (pathParam) {
      return `${crateName}::${pathParam.replace(/\//g, '::')}`;
    }
    return crateName;
  });

  const selectedNode = $derived.by(() => {
    if (!graphForDisplay) return null;
    return graphForDisplay.nodes.find((n) => n.id === selectedNodeId) ?? null;
  });

  /** Current path with deps toggled */
  const depsToggleHref = $derived.by(() => {
    if (!browser) return '#';
    const url = new URL(page.url);
    if (hideExternal) {
      url.searchParams.set('deps', 'show');
    } else {
      url.searchParams.delete('deps');
    }
    return url.pathname + url.search;
  });
</script>

<div class="flex flex-1 overflow-hidden">
  <!-- Left sidebar -->
  <div class="flex w-80 flex-col border-r border-[var(--panel-border)] bg-[var(--panel)]">
    <!-- Search (native GET form) -->
    <form
      method="get"
      class="border-b border-[var(--panel-border)] p-2"
      data-sveltekit-replacestate
      data-sveltekit-keepfocus
      data-sveltekit-noscroll
    >
      {#if !hideExternal}
        <input type="hidden" name="deps" value="show" />
      {/if}
      <input
        type="search"
        name="q"
        placeholder="Search items..."
        value={filter}
        class="w-full rounded-[var(--radius-control)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel-solid)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
      />
    </form>

    <!-- Deps toggle + kind filters -->
    <div class="flex flex-wrap items-center gap-1 border-b border-[var(--panel-border)] p-2">
      {#if stats.externalCount > 0}
        <a
          href={depsToggleHref}
          data-sveltekit-replacestate
          data-sveltekit-noscroll
          class="flex items-center gap-1 rounded-[var(--radius-chip)] corner-squircle px-2 py-0.5 text-xs {hideExternal
            ? 'bg-[var(--accent)] text-white'
            : 'text-[var(--muted)] hover:bg-[var(--panel-strong)]'}"
        >
          {hideExternal ? 'Deps hidden' : 'Show deps'}
        </a>
      {/if}
      {#each stats.kindCounts as { kind, count } (kind)}
        <button
          type="button"
          class="rounded-[var(--radius-chip)] corner-squircle px-2 py-0.5 text-xs {kindFilter.has(kind)
            ? 'bg-[var(--accent)] text-white'
            : 'bg-[var(--panel)] text-[var(--muted)] hover:bg-[var(--panel-strong)]'}"
          onclick={() => toggleKindFilter(kind)}
        >
          {kindLabels[kind]} ({count})
        </button>
      {/each}
    </div>

    <!-- Tree / Search results -->
    <div class="flex-1 overflow-auto">
      {#if filter && searchQuery}
        <!-- Server-side search results -->
        {#if searchQuery.loading}
          <div class="p-4 text-sm text-[var(--muted)]">Searching...</div>
        {:else if searchQuery.current && searchQuery.current.length > 0}
          <div class="p-2">
            <div class="px-2 pb-1 text-xs text-[var(--muted)]">{searchQuery.current.length} result{searchQuery.current.length === 1 ? '' : 's'}</div>
            {#each searchQuery.current as node (node.id)}
              {@const isSelected = selectedNodeId === node.id}
              <a
                href={getNodeUrl(node.id)}
                data-sveltekit-noscroll
                class="flex items-center gap-2 rounded-[var(--radius-chip)] corner-squircle px-2 py-1.5 text-sm hover:bg-[var(--panel-strong)] {isSelected
                  ? 'bg-[var(--accent)]/10 ring-1 ring-inset ring-[var(--accent)]'
                  : ''}"
              >
                <span
                  class="flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-chip)] corner-squircle text-[10px] font-bold leading-none text-white"
                  style="background-color: {kindColors[node.kind]}"
                >{kindIcons[node.kind]}</span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate font-medium text-[var(--ink)]">{node.name}</span>
                  <span class="block truncate text-xs text-[var(--muted)]">{node.id}</span>
                </span>
              </a>
            {/each}
          </div>
        {:else}
          <div class="p-4 text-sm text-[var(--muted)]">No results for "{filter}"</div>
        {/if}
      {:else if treeQuery.loading}
        <div class="p-4 text-sm text-[var(--muted)]">Loading tree...</div>
      {:else if graphForDisplay}
        <svelte:boundary>
          <GraphTree
            graph={graphForDisplay}
            selected={selectedNode}
            {getNodeUrl}
            filter=""
            {kindFilter}
          />
          {#snippet failed(error, reset)}
            <div class="p-4 text-sm text-[var(--danger)]">
              <p class="font-medium">Failed to render tree</p>
              <button type="button" class="mt-2 text-[var(--accent)] hover:underline" onclick={reset}>Try again</button>
            </div>
          {/snippet}
        </svelte:boundary>
      {:else}
        <div class="p-4 text-sm text-[var(--muted)]">No data available</div>
      {/if}
    </div>
  </div>

  <!-- Right panel -->
  <div class="flex-1 overflow-auto bg-[var(--bg)] p-6">
    {@render children()}
  </div>
</div>
