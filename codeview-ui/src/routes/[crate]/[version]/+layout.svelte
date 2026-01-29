<script lang="ts">
  import type { Node, NodeKind } from '$lib/graph';
  import { SvelteSet } from 'svelte/reactivity';
  import { getContext, setContext, tick } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { browser } from '$app/environment';
  import { getCrates, getCrateIndex, getCrateTree, getCrateVersions, searchNodes } from '$lib/graph.remote';
  import { nodeUrl } from '$lib/url';
  import { KeyedMemo, keyEqual, keyOf } from '$lib/reactivity.svelte';
  import GraphTree from '$lib/components/GraphTree.svelte';
  import { CrateStatusConnection } from '$lib/crate-status.svelte';

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
  const getHosted = getContext<() => boolean>('isHosted');
  const theme = $derived(getTheme());
  const isHosted = $derived(getHosted());

  const params = $derived(page.params);
  const crateName = $derived(params.crate);
  const version = $derived(params.version);

  // --- Status-aware loading state ---
  const statusConn = new CrateStatusConnection();

  // Connect when crate/version changes
  $effect(() => {
    const name = crateName;
    const ver = version;
    if (!browser || !name || !ver) return;
    statusConn.connect(name, ver, { allowWebSocket: isHosted });
    return () => statusConn.destroy();
  });

  // Auto-trigger parse for unknown crates
  $effect(() => {
    if (!browser || !crateName || !version) return;
    if (isHosted && statusConn.hasStatus && statusConn.status === 'unknown') {
      statusConn.triggerParse(crateName, version, { allowWebSocket: isHosted });
    }
  });

  // --- Existing workspace/crate loading (works when status is 'ready') ---

  // Load workspace crate list (for switcher + version map)
  const cratesQuery = getCrates();

  // Hosted fallback: load lightweight crate index for cross-crate navigation
  const indexQuery = $derived(
    crateName && version ? getCrateIndex({ name: crateName, version }) : null
  );

  // Versions list for current crate (hosted uses registry)
  const versionsQuery = $derived(crateName ? getCrateVersions(crateName) : null);

  const crateVersionsMemo = new KeyedMemo(
    () => keyOf(crateName, version, cratesQuery.current, indexQuery?.current),
    () => {
      const map: Record<string, string> = {};
      if (cratesQuery.current && cratesQuery.current.length > 0) {
        for (const c of cratesQuery.current) {
          map[c.id] = c.version;
          if (c.name && c.name !== c.id) map[c.name] = c.version;
        }
      } else if (indexQuery?.current) {
        for (const c of indexQuery.current.crates) {
          map[c.id] = c.version;
          if (c.name && c.name !== c.id) map[c.name] = c.version;
        }
      }
      if (crateName && version && !map[crateName]) {
        map[crateName] = version;
      }
      return map;
    },
    { equalsKey: keyEqual }
  );
  const crateVersions = $derived(crateVersionsMemo.current);

  // Other workspace crates (for the switcher)
  const otherCratesMemo = new KeyedMemo(
    () => keyOf(crateName, cratesQuery.current, indexQuery?.current),
    () => {
      if (cratesQuery.loading) return [];
      if (cratesQuery.current && cratesQuery.current.length > 0) {
        return cratesQuery.current.filter((c) => c.id !== crateName && c.name !== crateName);
      }
      if (indexQuery?.current?.crates) {
        return indexQuery.current.crates.filter((c) => c.id !== crateName && c.name !== crateName);
      }
      return [];
    },
    { equalsKey: keyEqual }
  );
  const otherCrates = $derived(otherCratesMemo.current);

  const crateVersionOptions = $derived.by(() => {
    const options = versionsQuery?.current ?? [];
    if (version && !options.includes(version)) {
      return [version, ...options];
    }
    return options;
  });

  function onVersionChange(e: Event) {
    const target = e.currentTarget as HTMLSelectElement | null;
    if (!target) return;
    const nextVersion = target.value;
    if (!crateName || !nextVersion || nextVersion === version) return;
    const nextPath = page.params.path ? `/${page.params.path}` : '';
    const nextUrl = new URL(`/${crateName}/${nextVersion}${nextPath}`, page.url);
    nextUrl.search = page.url.search;
    goto(nextUrl.toString(), { replaceState: false, noScroll: true, keepFocus: true });
  }

  const getNodeUrl = (id: string, parent?: string) => {
    const url = nodeUrl(id, crateVersions);
    return parent ? `${url}?parent=${encodeURIComponent(parent)}` : url;
  };

  setContext('getNodeUrl', () => getNodeUrl);
  setContext('crateVersions', () => crateVersions);

  // Load the current crate's tree
  const treeQuery = $derived(crateName && version ? getCrateTree({ name: crateName, version }) : null);

  // Build a Graph-shaped object for GraphTree from the tree response.
  const treeGraphMemo = new KeyedMemo(
    () => keyOf(crateName, treeQuery?.current),
    () => {
      if (!treeQuery || treeQuery.loading || !treeQuery.current) return null;
      console.log(`[perf:derived] treeGraph materialized (${treeQuery.current.nodes.length}n ${treeQuery.current.edges.length}e)`);
      return {
        nodes: treeQuery.current.nodes as Node[],
        edges: treeQuery.current.edges
      };
    },
    { equalsKey: keyEqual }
  );
  const treeGraph = $derived(treeGraphMemo.current);

  // Search / filter state from URL
  const filter = $derived(browser ? (page.url.searchParams.get('q') ?? '') : '');

  // Server-side search when there's a query
  const searchQuery = $derived(filter ? searchNodes({ crate: crateName, version, q: filter }) : null);

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

  const graphForDisplayMemo = new KeyedMemo(
    () => treeGraph,
    () => {
      if (!treeGraph) return null;
      const t0 = performance.now();
      let nodes = treeGraph.nodes;
      let edges = treeGraph.edges;

      // Remove orphan nodes: any node not reachable from a Crate root via Contains/Defines.
      const childMap = new Map<string, string[]>();
      for (const e of edges) {
        if (e.kind === 'Contains' || e.kind === 'Defines') {
          if (!childMap.has(e.from)) childMap.set(e.from, []);
          childMap.get(e.from)!.push(e.to);
        }
      }
      const reachable = new Set<string>();
      const crateIds = nodes.filter((n) => n.kind === 'Crate').map((n) => n.id);
      const queue = [...crateIds];
      for (const id of queue) {
        if (reachable.has(id)) continue;
        reachable.add(id);
        const children = childMap.get(id);
        if (children) queue.push(...children);
      }
      if (reachable.size < nodes.length) {
        nodes = nodes.filter((n) => reachable.has(n.id));
        edges = edges.filter((e) => reachable.has(e.from) && reachable.has(e.to));
      }

      const dt = performance.now() - t0;
      if (dt > 2) console.log(`[perf:derived] graphForDisplay ${dt.toFixed(1)}ms (${nodes.length}n ${edges.length}e)`);
      return { nodes, edges };
    }
  );
  const graphForDisplay = $derived(graphForDisplayMemo.current);

  setContext('graphForDisplay', () => graphForDisplay);

  const statsMemo = new KeyedMemo(
    () => graphForDisplay,
    () => {
      if (!graphForDisplay) return { kindCounts: [] as { kind: NodeKind; count: number }[] };
      const t0 = performance.now();
      const kindCounts = nodeKindOrder
        .map((kind) => ({
          kind,
          count: graphForDisplay.nodes.filter((n) => n.kind === kind).length
        }))
        .filter((e) => e.count > 0);
      const dt = performance.now() - t0;
      if (dt > 2) console.log(`[perf:derived] stats ${dt.toFixed(1)}ms (${graphForDisplay.nodes.length}n)`);
      return { kindCounts };
    }
  );
  const stats = $derived(statsMemo.current);

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

  // Track crate change render timing
  let lastCrateName = '';
  $effect(() => {
    if (crateName && crateName !== lastCrateName) {
      lastCrateName = crateName;
      const t0 = performance.now();
      console.log(`[perf:render] layout crate changed to ${crateName}`);
      tick().then(() => {
        console.log(`[perf:render] layout tick ${(performance.now() - t0).toFixed(0)}ms`);
      });
    }
  });

  // Determine if we should show the main UI (ready or local mode with data)
  const isReady = $derived(
    statusConn.status === 'ready' || statusConn.status === 'unknown' || treeGraph !== null
  );

</script>

<div class="flex flex-1 overflow-hidden">
  <!-- Status overlay for processing/failed states -->
  {#if statusConn.status === 'processing'}
    <div class="flex flex-1 items-center justify-center">
      <div class="text-center">
        <div class="mb-4 text-lg font-semibold text-[var(--ink)]">Parsing {crateName} {version}</div>
        <div class="mb-2 text-sm text-[var(--muted)]">Fetching rustdoc and extracting graph...</div>
        <div class="mx-auto h-1 w-48 overflow-hidden rounded-full bg-[var(--panel-border)]">
          <div class="h-full animate-pulse rounded-full bg-[var(--accent)]" style="width: 60%"></div>
        </div>
      </div>
    </div>
  {:else if statusConn.status === 'failed'}
    <div class="flex flex-1 items-center justify-center">
      <div class="text-center">
        <div class="mb-2 text-lg font-semibold text-[var(--danger)]">Failed to parse {crateName}</div>
        {#if statusConn.error}
          <div class="mb-4 max-w-md text-sm text-[var(--muted)]">{statusConn.error}</div>
        {/if}
        <button
          type="button"
          class="rounded-[var(--radius-control)] corner-squircle bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity"
          onclick={() => crateName && version && statusConn.retry(crateName, version, { allowWebSocket: isHosted })}
        >
          Retry
        </button>
      </div>
    </div>
  {:else}
    <!-- Left sidebar -->
    <div class="flex w-80 flex-col border-r border-[var(--panel-border)] bg-[var(--panel)]">
      <!-- Workspace switcher -->
      <div class="border-b border-[var(--panel-border)] px-3 py-2">
        <div class="text-sm font-semibold text-[var(--ink)]">{crateName}</div>
        <div class="text-xs text-[var(--muted)]">{version}</div>
        {#if crateVersionOptions.length > 1}
          <div class="mt-2">
            <select
              class="w-full rounded-[var(--radius-control)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel-solid)] px-2 py-1 text-xs outline-none focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
              value={version}
              onchange={onVersionChange}
            >
              {#each crateVersionOptions as ver (ver)}
                <option value={ver}>{ver}</option>
              {/each}
            </select>
          </div>
        {/if}
        {#if otherCrates.length > 0}
          <div class="mt-2 flex flex-wrap gap-1">
            {#each otherCrates as c (c.id)}
              {@const routeName = c.name ?? c.id}
              <a
                href="/{routeName}/{c.version}"
                class="badge badge-sm hover:bg-[var(--panel-strong)] hover:text-[var(--ink)] transition-colors"
              >
                {c.name}
              </a>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Search (native GET form) -->
      <form
        method="get"
        class="border-b border-[var(--panel-border)] p-2"
        data-sveltekit-replacestate
        data-sveltekit-keepfocus
        data-sveltekit-noscroll
      >
        <input
          type="search"
          name="q"
          placeholder="Search items..."
          value={filter}
          class="w-full rounded-[var(--radius-control)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel-solid)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
        />
      </form>

      <!-- Kind filters -->
      <div class="flex flex-wrap items-center gap-1 border-b border-[var(--panel-border)] p-2">
        {#each stats.kindCounts as { kind, count } (kind)}
          <button
            type="button"
            class="badge badge-sm transition-colors {kindFilter.has(kind)
              ? 'badge-accent'
              : 'hover:bg-[var(--panel-strong)] hover:text-[var(--ink)]'}"
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
        {:else if treeQuery?.loading}
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
  {/if}
</div>
