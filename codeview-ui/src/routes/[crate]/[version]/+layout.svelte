<script lang="ts">
  import type { Node, NodeKind } from "$lib/graph";
  import {
    themeCtx,
    getNodeUrlCtx,
    crateVersionsCtx,
    graphForDisplayCtx,
    crateStatusCtx,
    parseProgressCtx,
  } from "$lib/context";
  import { page } from "$app/state";
  import { afterNavigate, goto } from "$app/navigation";
  import { browser } from "$app/environment";
  import {
    getCrates,
    triggerStdInstall,
  } from "$lib/rpc/crate.remote";
  import { getCrateData } from "$lib/rpc/crate-data.remote";
  import { searchNodes } from "$lib/rpc/search.remote";
  import { cached, cacheKey } from "$lib/cache.svelte";
  import { nodeIdFromPath, nodeUrl } from "$lib/url";
  import { hyphenateCrateName } from "$lib/crate-names";
  import { KeyedMemo, keyEqual, keyOf } from "$lib/reactivity.svelte";
  import { onMount } from "svelte";
  import GraphTree from "$lib/components/GraphTree.svelte";
  import Skeleton from "$lib/components/Skeleton.svelte";
  import SkeletonTree from "$lib/components/SkeletonTree.svelte";
  import ProgressToast from "$lib/components/ProgressToast.svelte";
  import StdDocsPrompt from "$lib/components/StdDocsPrompt.svelte";
  import ParseError from "$lib/components/ParseError.svelte";
  import DocsUnavailable from "$lib/components/DocsUnavailable.svelte";
  import CrateHeader from "$lib/components/CrateHeader.svelte";
  import SearchResults from "$lib/components/SearchResults.svelte";
  import { Loader2Icon } from "@lucide/svelte";
  import {
    CrateStatusConnection,
    stepLabels,
    stepPercents,
    ParseProgressConnection,
  } from "$lib/sse";
  import { perf } from "$lib/perf";
  import { perfTick } from "$lib/perf.svelte";
  import { getLogger } from "$lib/log";
  import { kindLabels, nodeKindOrder } from "$lib/display-names";
  import { SvelteSet } from "svelte/reactivity";
  import { TreeModel } from "$lib/tree-model.svelte";
  import { isValidCrateNameParam, isValidVersionParam } from "$lib/crate-ref";

  const log = getLogger("layout");

  let { children } = $props();
  const theme = $derived(themeCtx.get());

  const params = $derived(page.params);
  const crateName = $derived(params.crate);
  const version = $derived(params.version);
  const canonicalCrateName = $derived(hyphenateCrateName(crateName ?? ""));
  const hasValidCrateParam = $derived(
    isValidCrateNameParam(canonicalCrateName),
  );
  const hasValidVersionParam = $derived(isValidVersionParam(version));
  const canQueryCrate = $derived(hasValidCrateParam && hasValidVersionParam);

  // --- SSE connections for status and parse progress ---
  const statusConn = new CrateStatusConnection();
  const progressConn = new ParseProgressConnection();
  const treeModel = new TreeModel();
  let lastProgressKey = "";
  let activeRouteKey = "";
  let rafMonitor: number | null = null;
  let wasHidden = false;
  let lastTreeSummary = "";
  let crateDataRefreshInFlight: Promise<void> | null = null;

  function startMainThreadMonitor() {
    if (!browser) return;
    if (rafMonitor !== null) return;
    const onVisibility = () => {
      wasHidden = document.visibilityState !== "visible";
    };
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    let last = performance.now();
    const tick = (now: number) => {
      const gap = now - last;
      // Capture long main-thread stalls that can hide state transitions.
      if (!wasHidden && gap > 500 && gap < 10_000) {
        log.warn`main-thread gap ${Math.round(gap)}ms route=${canonicalCrateName}@${version} status=${statusConn.status} step=${statusConn.step ?? "none"} treeSource=${treeModel.source} tree=${treeModel.tree ? "yes" : "no"}`;
      }
      last = now;
      rafMonitor = requestAnimationFrame(tick);
    };
    rafMonitor = requestAnimationFrame(tick);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }

  function stopMainThreadMonitor() {
    if (rafMonitor === null) return;
    cancelAnimationFrame(rafMonitor);
    rafMonitor = null;
  }

  function logQueryTreeSnapshot(context: string) {
    const current = treeFromQuery;
    if (!current) return;
    const summary = `${current.nodes.length}/${current.edges.length}`;
    if (summary !== lastTreeSummary) {
      lastTreeSummary = summary;
      log.debug`${context} ${canonicalCrateName}@${version}: ${summary} source=${treeModel.source} status=${statusConn.status}`;
    }
  }

  function refreshCrateData(reason: string, force = false): Promise<void> {
    if (!crateDataQuery) return Promise.resolve();
    if (crateDataRefreshInFlight) return crateDataRefreshInFlight;
    if (!force && (crateDataQuery.loading || crateDataQuery.current))
      return Promise.resolve();
    const t0 = performance.now();
    log.debug`crateData refresh start ${canonicalCrateName}@${version} reason=${reason}`;
    crateDataRefreshInFlight = crateDataQuery
      .refresh()
      .then(() => {
        const ms = Math.round(performance.now() - t0);
        const data = crateDataQuery.current;
        const n = data?.tree.nodes.length ?? 0;
        const e = data?.tree.edges.length ?? 0;
        const v = data?.versions.length ?? 0;
        log.debug`crateData refresh done ${canonicalCrateName}@${version} in ${ms}ms (${n}n ${e}e ${v}v) reason=${reason}`;
        logQueryTreeSnapshot("crateData current");
        syncTreeFromQuery();
      })
      .catch((err) => {
        log.warn`crateData refresh failed ${canonicalCrateName}@${version} reason=${reason}: ${String(err)}`;
      })
      .finally(() => {
        crateDataRefreshInFlight = null;
      });
    return crateDataRefreshInFlight;
  }

  function primeRouteQueries() {
    if (!canQueryCrate) return;
    // Ensure remote query starts even while status overlay is visible.
    // This prevents deadlock where status remains unknown and tree query
    // was never pulled.
    void refreshCrateData("prime");
  }

  function connectStatusForCurrentRoute() {
    if (!browser || !canonicalCrateName || !version || !canQueryCrate) return;
    const routeKey = `${canonicalCrateName}@${version}`;
    if (routeKey === activeRouteKey) return;
    treeModel.clear();
    progressConn.reset();
    lastProgressKey = "";
    activeRouteKey = routeKey;
    primeRouteQueries();
    statusConn.connect(canonicalCrateName, version);
  }

  function connectProgressForCurrentRoute() {
    if (!browser || !canonicalCrateName || !version || !canQueryCrate) return;
    if (statusConn.status !== "processing") return;
    const nextKey = `${canonicalCrateName}@${version}`;
    if (nextKey === lastProgressKey) return;
    lastProgressKey = nextKey;
    progressConn.connect(canonicalCrateName, version);
  }

  function syncTreeFromProgress() {
    if (statusConn.status !== "processing") return;
    if (!progressConn.tree) return;
    treeModel.applyStreamTree(
      progressConn.tree,
      progressConn.sequence,
      progressConn.contentId,
    );
  }

  function syncTreeFromQuery() {
    const queryTree = treeFromQuery;
    if (!queryTree) {
      log.debug`syncTreeFromQuery skip ${canonicalCrateName}@${version}: no query tree`;
      return;
    }
    if (
      treeModel.source === "query" &&
      treeModel.tree?.nodes.length === queryTree.nodes.length &&
      treeModel.tree?.edges.length === queryTree.edges.length &&
      statusConn.status !== "unknown"
    ) {
      return;
    }
    log.debug`syncTreeFromQuery start ${canonicalCrateName}@${version}: ${queryTree.nodes.length}n ${queryTree.edges.length}e status=${statusConn.status} source=${treeModel.source}`;
    // Query tree is canonical persisted state. If status SSE lags or misses
    // the initial message, treat this route as ready instead of showing
    // a permanent "Starting..." overlay.
    if (statusConn.status === "unknown") {
      statusConn.status = "ready";
      statusConn.step = null;
      progressConn.reset();
    }
    if (statusConn.status === "processing" && treeModel.source === "stream")
      return;
    if (treeModel.source === "query" && treeModel.tree === queryTree) return;
    treeModel.applyQuerySnapshot(queryTree);
    log.debug`syncTreeFromQuery done ${canonicalCrateName}@${version}: status=${statusConn.status} source=${treeModel.source}`;
  }

  onMount(() => {
    const stopMonitor = startMainThreadMonitor();
    connectStatusForCurrentRoute();
    afterNavigate(() => {
      connectStatusForCurrentRoute();
      connectProgressForCurrentRoute();
    });
    return () => {
      stopMonitor?.();
      stopMainThreadMonitor();
      statusConn.disconnect();
      progressConn.disconnect();
      treeModel.clear();
    };
  });

  // Track status changes and react accordingly
  let wasReady = $state(false);
  $effect(() => {
    // Read status to establish dependency
    const currentStatus = statusConn.status;
    const currentStep = statusConn.step;

    connectProgressForCurrentRoute();
    if (treeModel.source !== "query" || currentStatus === "unknown") {
      logQueryTreeSnapshot("treeQuery current");
      syncTreeFromQuery();
    }
    log.debug`status: ${currentStatus} step=${currentStep ?? "none"} for ${crateName}@${version}`;
    const isReady = currentStatus === "ready";
    if (isReady && !wasReady) {
      // Parse is done: refresh canonical query snapshot and adopt it as the single tree model.
      progressConn.reset();
      void refreshCrateData("ready", true);
    }
    wasReady = isReady;
  });

  // Track progress changes
  $effect(() => {
    // Read progress properties to establish dependencies
    const tree = progressConn.tree;
    const nodeCount = progressConn.nodeCount;

    syncTreeFromProgress();
    if (nodeCount > 0 || tree) {
      log.debug`progress: ${nodeCount} nodes, tree=${tree ? "yes" : "no"}`;
    }
  });

  // --- Existing workspace/crate loading (works when status is 'ready') ---

  // Load workspace crate list (for switcher + version map)
  const cratesQuery = cached(cacheKey("workspaceCrates"), getCrates());

  // Combined query: tree + index + versions in one roundtrip
  const crateDataQuery = $derived(
    canQueryCrate
      ? cached(
          cacheKey("crateData", canonicalCrateName, version),
          getCrateData({
            name: canonicalCrateName,
            version,
            mode: "structural",
            includeExternal: false,
          }),
        )
      : null,
  );

  // Derive individual values from the combined query
  const treeFromQuery = $derived(crateDataQuery?.current?.tree ?? null);
  const indexFromQuery = $derived(crateDataQuery?.current?.index ?? null);
  const versionsFromQuery = $derived(crateDataQuery?.current?.versions ?? []);

  const crateVersionsMemo = new KeyedMemo(
    () =>
      keyOf(
        canonicalCrateName,
        version,
        cratesQuery.current,
        indexFromQuery,
      ),
    () => {
      const map: Record<string, string> = {};
      if (cratesQuery.current && cratesQuery.current.length > 0) {
        for (const c of cratesQuery.current) {
          map[c.id] = c.version;
          if (c.name && c.name !== c.id) map[c.name] = c.version;
        }
      }
      // Always merge index data (includes external crate versions)
      if (indexFromQuery) {
        for (const c of indexFromQuery.crates) {
          if (!map[c.id]) map[c.id] = c.version;
          if (c.name && c.name !== c.id && !map[c.name])
            map[c.name] = c.version;
        }
      }
      if (canonicalCrateName && version && !map[canonicalCrateName]) {
        map[canonicalCrateName] = version;
      }
      return map;
    },
    { equalsKey: keyEqual },
  );
  const crateVersions = $derived(crateVersionsMemo.current);

  // Other workspace crates (for the switcher)
  const otherCratesMemo = new KeyedMemo(
    () => keyOf(canonicalCrateName, cratesQuery.current, indexFromQuery),
    () => {
      if (cratesQuery.current && cratesQuery.current.length > 0) {
        return cratesQuery.current.filter(
          (c) => c.id !== crateName && c.name !== crateName,
        );
      }
      if (indexFromQuery?.crates) {
        return indexFromQuery.crates.filter(
          (c) => c.id !== crateName && c.name !== crateName,
        );
      }
      return [];
    },
    { equalsKey: keyEqual },
  );
  const otherCrates = $derived(otherCratesMemo.current);
  const relatedCrateCount = $derived.by(() => {
    if (cratesQuery.current && cratesQuery.current.length > 0) {
      return cratesQuery.current.length;
    }
    if (indexFromQuery?.crates) {
      return indexFromQuery.crates.length;
    }
    return null;
  });

  const crateVersionOptions = $derived.by(() => {
    const options = versionsFromQuery;
    if (version && !options.includes(version)) {
      return [version, ...options];
    }
    return options;
  });

  function onVersionChange(e: Event) {
    const target = e.currentTarget as HTMLSelectElement | null;
    if (!target) return;
    const nextVersion = target.value;
    if (!canonicalCrateName || !nextVersion || nextVersion === version) return;
    const nextPath = page.params.path ? `/${page.params.path}` : "";
    const nextUrl = new URL(
      `/${canonicalCrateName}/${nextVersion}${nextPath}`,
      page.url,
    );
    nextUrl.search = page.url.search;
    goto(nextUrl.toString(), {
      replaceState: false,
      noScroll: true,
      keepFocus: true,
    });
  }

  const getNodeUrl = (id: string, parent?: string) => {
    const base = nodeUrl(id, crateVersions);
    // Carry forward current query params so view state (layout, structural,
    // semantic, etc.) persists across navigations.
    const params = new URLSearchParams(page.url.searchParams);
    if (parent) {
      params.set("parent", parent);
    } else {
      params.delete("parent");
    }
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  };

  getNodeUrlCtx.set(() => getNodeUrl);
  crateVersionsCtx.set(() => crateVersions);
  crateStatusCtx.set(() => statusConn.status);
  parseProgressCtx.set(() => progressConn);

  // Build a Graph-shaped object for GraphTree from the tree response.
  // Prefer streamed progress tree during parsing, fall back to cached query.
  const treeGraphMemo = new KeyedMemo(
    () => keyOf(crateName, treeModel.version, treeModel.source),
    () => {
      const tree = treeModel.tree;
      if (!tree) return null;
      return perf.time(
        "derived",
        "treeGraph",
        () => ({
          nodes: tree.nodes as Node[],
          edges: tree.edges,
        }),
        {
          detail: (r) => `${r.nodes.length}n ${r.edges.length}e`,
        },
      );
    },
    { equalsKey: keyEqual },
  );
  const treeGraph = $derived(treeGraphMemo.current);

  // Search / filter state from URL
  const filter = $derived(
    browser ? (page.url.searchParams.get("q") ?? "") : "",
  );

  // Server-side search when there's a query
  const searchQuery = $derived(
    filter ? searchNodes({ crate: crateName, version, q: filter }) : null,
  );

  const activeKinds = new SvelteSet<NodeKind>();
  const kindFilter = $derived(activeKinds);

  const graphForDisplayMemo = new KeyedMemo(
    () => treeGraph,
    () => {
      if (!treeGraph) return null;
      // Orphan filtering is now done server-side in the parser adapter
      // Just pass through the pre-filtered tree data
      return treeGraph;
    },
  );
  const graphForDisplay = $derived(graphForDisplayMemo.current);

  graphForDisplayCtx.set(() => graphForDisplay);

  const statsMemo = new KeyedMemo(
    () =>
      keyOf(
        statusConn.status,
        treeModel.source,
        graphForDisplay,
        progressConn.sequence,
        progressConn.nodeCount,
      ),
    () => {
      if (
        statusConn.status === "processing" &&
        treeModel.source === "stream" &&
        progressConn.nodeCount > 0
      ) {
        const kindCounts = nodeKindOrder
          .map((kind) => ({
            kind,
            count: progressConn.getKindCount(kind),
          }))
          .filter((e) => e.count > 0);
        return { kindCounts };
      }
      if (!graphForDisplay) {
        return { kindCounts: [] as { kind: NodeKind; count: number }[] };
      }
      return perf.time(
        "derived",
        "stats",
        () => {
          const kindCounts = nodeKindOrder
            .map((kind) => ({
              kind,
              count: graphForDisplay.nodes.filter((n) => n.kind === kind)
                .length,
            }))
            .filter((e) => e.count > 0);
          return { kindCounts };
        },
        {
          detail: () => `${graphForDisplay.nodes.length}n`,
        },
      );
    },
  );
  const stats = $derived(statsMemo.current);

  function toggleKindFilter(kind: NodeKind) {
    if (activeKinds.has(kind)) {
      activeKinds.delete(kind);
      return;
    }
    activeKinds.add(kind);
  }

  // Derive selected node ID from the current path
  const selectedNodeId = $derived.by(() => {
    const pathParam = page.params.path;
    return crateName ? nodeIdFromPath(crateName, pathParam) : "";
  });

  const selectedNode = $derived.by(() => {
    if (!graphForDisplay) return null;
    return graphForDisplay.nodes.find((n) => n.id === selectedNodeId) ?? null;
  });

  // Track crate change render timing
  let lastCrateName = "";
  $effect(() => {
    if (crateName && crateName !== lastCrateName) {
      lastCrateName = crateName;
      perfTick("render", `layout crate=${crateName} tick`);
    }
  });

  const stepLabel = $derived(
    statusConn.step
      ? (stepLabels[statusConn.step] ?? "Processing...")
      : "Starting...",
  );
  const stepPercent = $derived(
    statusConn.step ? (stepPercents[statusConn.step] ?? 10) : 10,
  );
  const showPerfDebug = $derived(
    browser ? page.url.searchParams.has("perf") : false,
  );
  const statusDebugKey = $derived(
    crateName && version ? `rust:${crateName}:${version}` : "-",
  );
  const progressDebugKey = $derived(
    crateName && version ? `progress:rust:${crateName}:${version}` : "-",
  );
  const showStreamingState = $derived(
    statusConn.status === "unknown" || statusConn.status === "processing",
  );
  const showProgressBadge = $derived(statusConn.status === "processing");
  const pendingSkeletonCount = $derived.by(() => {
    const known = progressConn.totalItems ?? progressConn.nodeCount;
    return known > 0 ? known : 24;
  });
  const loadingRelatedCrates = $derived(
    (cratesQuery.loading && !cratesQuery.current) ||
      ((crateDataQuery?.loading ?? false) && !indexFromQuery),
  );
</script>

<div class="flex flex-1 overflow-hidden">
  {#if statusConn.status === "failed" && statusConn.action === "install_std_docs"}
    <StdDocsPrompt
      {crateName}
      {version}
      installedVersion={statusConn.installedVersion}
      onInstall={async () => {
        if (!crateName || !version) return;
        statusConn.status = "processing";
        statusConn.step = "resolving";
        statusConn.action = undefined;
        statusConn.error = null;
        try {
          await triggerStdInstall(`${crateName}@${version}`);
          statusConn.connect(crateName, version);
        } catch (err) {
          statusConn.status = "failed";
          statusConn.error =
            err instanceof Error ? err.message : String(err);
        }
      }}
    />
  {:else if statusConn.status === "failed" && statusConn.action === "docs_unavailable" && !treeGraph}
    <DocsUnavailable
      {crateName}
      {version}
      {crateVersionOptions}
      onRetry={() => crateName && version && statusConn.retry(crateName, version)}
    />
  {:else if statusConn.status === "failed" && !treeGraph}
    <ParseError
      {crateName}
      error={statusConn.error}
      onRetry={() => crateName && version && statusConn.retry(crateName, version)}
    />
  {:else}
    <!-- Left sidebar -->
    <div
      class="flex w-80 flex-col border-r border-[var(--panel-border)] bg-[var(--panel)]"
    >
      <CrateHeader
        {crateName}
        {version}
        {relatedCrateCount}
        {crateVersionOptions}
        {otherCrates}
        {loadingRelatedCrates}
        {onVersionChange}
        debugInfo={showPerfDebug && statusConn.status === "processing"
          ? {
              statusDebugKey,
              progressDebugKey,
              contentId: progressConn.contentId,
              sequence: progressConn.sequence,
              stale: progressConn.stale,
              treeSource: treeModel.source,
            }
          : null}
      />

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
      <div
        class="flex min-h-10 flex-wrap items-center gap-1 border-b border-[var(--panel-border)] p-2"
      >
        {#if stats.kindCounts.length > 0}
          {#each stats.kindCounts as { kind, count } (kind)}
            <button
              type="button"
              data-kind={kind}
              data-active={activeKinds.has(kind) ? "true" : undefined}
              class="badge badge-sm transition-colors {activeKinds.has(kind)
                ? 'badge-accent'
                : 'hover:bg-[var(--panel-strong)] hover:text-[var(--ink)]'}"
              onclick={() => toggleKindFilter(kind)}
            >
              {kindLabels[kind]} ({count})
            </button>
          {/each}
        {:else if showStreamingState}
          <div class="text-xs text-[var(--muted)] px-1">
            Waiting for kind counts...
          </div>
        {/if}
      </div>

      <!-- Tree / Search results -->
      <div class="flex-1 overflow-auto">
        {#if filter && searchQuery}
          <SearchResults {searchQuery} {filter} {selectedNodeId} {getNodeUrl} />
        {:else if graphForDisplay}
          <GraphTree
            graph={graphForDisplay}
            selected={selectedNode}
            {getNodeUrl}
            filter=""
            {kindFilter}
          />
        {:else if showStreamingState}
          <SkeletonTree
            count={pendingSkeletonCount}
            showKindBadges={false}
            pathStructure={progressConn.pathStructure}
            currentPath={page.params.path ?? ''}
            crateName={canonicalCrateName}
            streamedTree={progressConn.tree}
          />
        {:else if crateDataQuery}
          <svelte:boundary>
            {@const _data = await crateDataQuery}
            <div class="p-4 text-sm text-[var(--muted)]">Preparing tree…</div>
            {#snippet pending()}
              <div class="p-2">
                <div
                  class="flex items-center gap-2 px-2 py-2 text-xs text-[var(--muted)]"
                >
                  <Loader2Icon class="h-3 w-3 animate-spin" />
                  <span>Loading tree...</span>
                </div>
                {#each [1, 2, 3, 4, 5, 6] as _}
                  <div class="flex items-center gap-2 px-2 py-1.5">
                    <Skeleton width="1.25rem" height="1.25rem" rounded="md" />
                    <Skeleton width="70%" height="0.875rem" rounded="sm" />
                  </div>
                {/each}
              </div>
            {/snippet}
            {#snippet failed(error, reset)}
              <div class="p-4 text-sm text-[var(--danger)]">
                <p class="font-medium">Failed to render tree</p>
                <button
                  type="button"
                  class="mt-2 text-[var(--accent)] hover:underline"
                  onclick={reset}>Try again</button
                >
              </div>
            {/snippet}
          </svelte:boundary>
        {:else}
          <div class="p-4 text-sm text-[var(--muted)]">No data available</div>
        {/if}
      </div>
    </div>

    <!-- Right panel -->
    <div class="relative flex-1 overflow-auto bg-[var(--bg)] p-6">
      {@render children()}
    </div>
  {/if}
</div>

{#if showProgressBadge}
  <ProgressToast {stepLabel} nodeCount={progressConn.nodeCount} edgeCount={progressConn.edgeCount} />
{/if}
