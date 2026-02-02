<script lang="ts">
  import type { Node, NodeKind } from '$lib/graph';
  import { SvelteSet } from 'svelte/reactivity';
  import { themeCtx, getNodeUrlCtx, crateVersionsCtx, graphForDisplayCtx } from '$lib/context';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { browser } from '$app/environment';
  import { getCrates, getCrateIndex, getCrateTree, getCrateVersions, searchNodes, triggerStdInstall } from '$lib/graph.remote';
  import { cached } from '$lib/query-cache.svelte';
  import { nodeUrl } from '$lib/url';
  import { KeyedMemo, keyEqual, keyOf } from '$lib/reactivity.svelte';
  import { onDestroy } from 'svelte';
  import GraphTree from '$lib/components/GraphTree.svelte';
  import { Loader2Icon } from '@lucide/svelte';
  import { CrateStatusConnection } from '$lib/crate-status.svelte';
  import { perf } from '$lib/perf';
  import { perfTick } from '$lib/perf.svelte';
  import { kindColors, kindIcons } from '$lib/tree-constants';

  let { children } = $props();
  const theme = $derived(themeCtx.get());

  const params = $derived(page.params);
  const crateName = $derived(params.crate);
  const version = $derived(params.version);

  // --- Status-aware loading state ---
  const statusConn = new CrateStatusConnection();

  // Connect when crate/version changes — connect() handles closing previous ES internally
  $effect(() => {
    const name = crateName;
    const ver = version;
    if (!browser || !name || !ver) return;
    statusConn.connect(name, ver);
  });
  onDestroy(() => statusConn.destroy());


  // --- Existing workspace/crate loading (works when status is 'ready') ---

  // Load workspace crate list (for switcher + version map)
  const cratesQuery = cached('workspaceCrates', getCrates());

  // Hosted fallback: load lightweight crate index for cross-crate navigation
  const indexQuery = $derived(
    crateName && version ? cached(`index:${crateName}@${version}`, getCrateIndex({ name: crateName, version })) : null
  );

  // Versions list for current crate (hosted uses registry)
  const versionsQuery = $derived(crateName ? cached(`versions:${crateName}`, getCrateVersions(crateName)) : null);

  const crateVersionsMemo = new KeyedMemo(
    () => keyOf(crateName, version, cratesQuery.current, indexQuery?.current),
    () => {
      const map: Record<string, string> = {};
      if (cratesQuery.current && cratesQuery.current.length > 0) {
        for (const c of cratesQuery.current) {
          map[c.id] = c.version;
          if (c.name && c.name !== c.id) map[c.name] = c.version;
        }
      }
      // Always merge index data (includes external crate versions)
      if (indexQuery?.current) {
        for (const c of indexQuery.current.crates) {
          if (!map[c.id]) map[c.id] = c.version;
          if (c.name && c.name !== c.id && !map[c.name]) map[c.name] = c.version;
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
    const base = nodeUrl(id, crateVersions);
    // Carry forward current query params so view state (layout, structural,
    // semantic, etc.) persists across navigations.
    const params = new URLSearchParams(page.url.searchParams);
    if (parent) {
      params.set('parent', parent);
    } else {
      params.delete('parent');
    }
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  };

  getNodeUrlCtx.set(() => getNodeUrl);
  crateVersionsCtx.set(() => crateVersions);

  // Load the current crate's tree
  const treeQuery = $derived(
    crateName && version ? cached(`tree:${crateName}@${version}`, getCrateTree({ name: crateName, version })) : null
  );

  // When status transitions to 'ready', refresh the tree and index queries
  // to pick up freshly parsed data (the initial call may have cached null).
  $effect(() => {
    if (statusConn.status === 'ready') {
      treeQuery?.refresh();
      indexQuery?.refresh();
    }
  });

  // Build a Graph-shaped object for GraphTree from the tree response.
  const treeGraphMemo = new KeyedMemo(
    () => keyOf(crateName, treeQuery?.current),
    () => {
      if (!treeQuery?.current) return null;
      return perf.time('derived', 'treeGraph', () => ({
        nodes: treeQuery.current!.nodes as Node[],
        edges: treeQuery.current!.edges
      }), {
        detail: (r) => `${r.nodes.length}n ${r.edges.length}e`
      });
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
      return perf.time('derived', 'graphForDisplay', () => {
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

        return { nodes, edges };
      }, {
        detail: (r) => `${r.nodes.length}n ${r.edges.length}e`
      });
    }
  );
  const graphForDisplay = $derived(graphForDisplayMemo.current);

  graphForDisplayCtx.set(() => graphForDisplay);

  const statsMemo = new KeyedMemo(
    () => graphForDisplay,
    () => {
      if (!graphForDisplay) return { kindCounts: [] as { kind: NodeKind; count: number }[] };
      return perf.time('derived', 'stats', () => {
        const kindCounts = nodeKindOrder
          .map((kind) => ({
            kind,
            count: graphForDisplay.nodes.filter((n) => n.kind === kind).length
          }))
          .filter((e) => e.count > 0);
        return { kindCounts };
      }, {
        detail: () => `${graphForDisplay.nodes.length}n`
      });
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
      perfTick('render', `layout crate=${crateName} tick`);
    }
  });

  // Determine if we should show the main UI
  const isReady = $derived(
    statusConn.status === 'ready' || treeGraph !== null
  );

  // --- Step progress mappings ---
  const stepLabels: Record<string, string> = {
    resolving: 'Resolving metadata...',
    fetching: 'Downloading rustdoc...',
    parsing: 'Extracting graph...',
    storing: 'Uploading graph...',
    indexing: 'Indexing dependencies...'
  };
  const stepPercents: Record<string, number> = {
    resolving: 20,
    fetching: 40,
    parsing: 60,
    storing: 80,
    indexing: 90
  };
  const stepLabel = $derived(statusConn.step ? (stepLabels[statusConn.step] ?? 'Processing...') : 'Starting...');
  const stepPercent = $derived(statusConn.step ? (stepPercents[statusConn.step] ?? 10) : 10);

</script>

<div class="flex flex-1 overflow-hidden">
  <!-- Status overlay for processing/failed states -->
  {#if statusConn.status === 'unknown' && !treeGraph}
    <div class="flex flex-1 items-center justify-center">
      <div class="flex items-center gap-2 text-sm text-[var(--muted)]">
        <Loader2Icon class="animate-spin" size={16} />
        Loading {crateName}...
      </div>
    </div>
  {:else if statusConn.status === 'processing'}
    <div class="flex flex-1 items-center justify-center">
      <div class="text-center">
        <div class="mb-4 text-lg font-semibold text-[var(--ink)]">Parsing {crateName} {version}</div>
        <div class="mb-2 text-sm text-[var(--muted)]">{stepLabel}</div>
        <div class="mx-auto h-1 w-48 overflow-hidden rounded-full bg-[var(--panel-border)]">
          <div class="h-full rounded-full bg-[var(--accent)] transition-all duration-500" style="width: {stepPercent}%"></div>
        </div>
      </div>
    </div>
  {:else if statusConn.status === 'failed' && statusConn.action === 'install_std_docs'}
    <div class="flex flex-1 items-center justify-center">
      <div class="text-center max-w-md">
        <div class="mb-2 text-lg font-semibold text-[var(--ink)]">Install std docs for {crateName}?</div>
        <div class="mb-4 text-sm text-[var(--muted)]">
          The rustdoc JSON for <code class="rounded bg-[var(--panel-strong)] px-1 py-0.5 text-xs">{crateName} {version}</code> is not installed locally.
          {#if statusConn.installedVersion}
            Your current toolchain has version <code class="rounded bg-[var(--panel-strong)] px-1 py-0.5 text-xs">{statusConn.installedVersion}</code>.
          {/if}
          This will run <code class="rounded bg-[var(--panel-strong)] px-1 py-0.5 text-xs">rustup component add rust-docs-json</code>.
        </div>
        <div class="flex items-center justify-center gap-3">
          <button
            type="button"
            class="rounded-[var(--radius-control)] corner-squircle bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity"
            onclick={async () => {
              if (!crateName || !version) return;
              statusConn.status = 'processing';
              statusConn.step = 'resolving';
              statusConn.action = undefined;
              statusConn.error = null;
              try {
                await triggerStdInstall(`${crateName}@${version}`);
                statusConn.connect(crateName, version);
              } catch (err) {
                statusConn.status = 'failed';
                statusConn.error = err instanceof Error ? err.message : String(err);
              }
            }}
          >
            Install
          </button>
          <button
            type="button"
            class="rounded-[var(--radius-control)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel)] px-4 py-2 text-sm text-[var(--muted)] hover:text-[var(--ink)] transition-colors"
            onclick={() => history.back()}
          >
            Go back
          </button>
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
          onclick={() => crateName && version && statusConn.retry(crateName, version)}
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
          <svelte:boundary>
            {#snippet pending()}
              <div class="flex items-center gap-2 p-4 text-sm text-[var(--muted)]">
                <Loader2Icon class="animate-spin" size={16} />
                Searching...
              </div>
            {/snippet}
            {@const results = await searchQuery}
            {#if results && results.length > 0}
              <div class="p-2">
                <div class="px-2 pb-1 text-xs text-[var(--muted)]">{results.length} result{results.length === 1 ? '' : 's'}</div>
                {#each results as node (node.id)}
                  {@const isSelected = selectedNodeId === node.id}
                  {@const KindIcon = kindIcons[node.kind]}
                  <a
                    href={getNodeUrl(node.id)}
                    data-sveltekit-noscroll
                    class="flex items-center gap-2 rounded-[var(--radius-chip)] corner-squircle px-2 py-1.5 text-sm hover:bg-[var(--panel-strong)] {isSelected
                      ? 'bg-[var(--accent)]/10 ring-1 ring-inset ring-[var(--accent)]'
                      : ''}"
                  >
                    <span
                      class="flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-chip)] corner-squircle text-white"
                      style="background-color: {kindColors[node.kind]}"
                    ><KindIcon size={12} strokeWidth={2.5} /></span>
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
          </svelte:boundary>
        {:else if treeQuery}
          <svelte:boundary>
            {#snippet pending()}
              <div class="flex items-center gap-2 p-4 text-sm text-[var(--muted)]">
                <Loader2Icon class="animate-spin" size={16} />
                Loading tree...
              </div>
            {/snippet}
            {@const _tree = await treeQuery}
            {#if graphForDisplay}
              <GraphTree
                graph={graphForDisplay}
                selected={selectedNode}
                {getNodeUrl}
                filter=""
                {kindFilter}
              />
            {:else}
              <div class="p-4 text-sm text-[var(--muted)]">No data available</div>
            {/if}
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
