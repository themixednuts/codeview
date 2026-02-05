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
    getCrateIndex,
    getCrateTree,
    getCrateVersions,
    searchNodes,
    triggerStdInstall,
  } from "$lib/graph.remote";
  import { cached, cacheKey } from "$lib/cache.svelte";
  import { nodeIdFromPath, nodeUrl } from "$lib/url";
  import { KeyedMemo, keyEqual, keyOf } from "$lib/reactivity.svelte";
  import { onMount } from "svelte";
  import GraphTree from "$lib/components/GraphTree.svelte";
  import Skeleton from "$lib/components/Skeleton.svelte";
  import SkeletonTree from "$lib/components/SkeletonTree.svelte";
  import { Loader2Icon } from "@lucide/svelte";
  import {
    CrateStatusConnection,
    stepLabels,
    stepPercents,
  } from "$lib/status.svelte";
  import { ParseProgressConnection } from "$lib/progress.svelte";
  import { perf } from "$lib/perf";
  import { perfTick } from "$lib/perf.svelte";
  import { getLogger } from "$lib/log";
  import { kindColors, kindIcons } from "$lib/tree";
  import { kindLabels, nodeKindOrder } from "$lib/node-labels";
  import { SvelteSet } from "svelte/reactivity";
  import { TreeModel } from "$lib/tree-model.svelte";
  import { isValidCrateNameParam, isValidVersionParam } from "$lib/crate-ref";

  const log = getLogger("layout");

  let { children } = $props();
  const theme = $derived(themeCtx.get());

  const params = $derived(page.params);
  const crateName = $derived(params.crate);
  const version = $derived(params.version);
  const canonicalCrateName = $derived((crateName ?? "").replace(/_/g, "-"));
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
  let treeRefreshInFlight: Promise<void> | null = null;
  let indexRefreshInFlight: Promise<void> | null = null;

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
    const current = treeQuery?.current;
    if (!current) return;
    const summary = `${current.nodes.length}/${current.edges.length}`;
    if (summary !== lastTreeSummary) {
      lastTreeSummary = summary;
      log.debug`${context} ${canonicalCrateName}@${version}: ${summary} source=${treeModel.source} status=${statusConn.status}`;
    }
  }

  function refreshTreeQuery(reason: string, force = false): Promise<void> {
    if (!treeQuery) return Promise.resolve();
    if (treeRefreshInFlight) return treeRefreshInFlight;
    if (!force && (treeQuery.loading || treeQuery.current))
      return Promise.resolve();
    const t0 = performance.now();
    log.debug`treeQuery refresh start ${canonicalCrateName}@${version} reason=${reason}`;
    treeRefreshInFlight = treeQuery
      .refresh()
      .then(() => {
        const ms = Math.round(performance.now() - t0);
        const n = treeQuery.current?.nodes.length ?? 0;
        const e = treeQuery.current?.edges.length ?? 0;
        log.debug`treeQuery refresh done ${canonicalCrateName}@${version} in ${ms}ms (${n}n ${e}e) reason=${reason}`;
        logQueryTreeSnapshot("treeQuery current");
        syncTreeFromQuery();
      })
      .catch((err) => {
        log.warn`treeQuery refresh failed ${canonicalCrateName}@${version} reason=${reason}: ${String(err)}`;
      })
      .finally(() => {
        treeRefreshInFlight = null;
      });
    return treeRefreshInFlight;
  }

  function refreshIndexQuery(reason: string, force = false): Promise<void> {
    if (!indexQuery) return Promise.resolve();
    if (indexRefreshInFlight) return indexRefreshInFlight;
    if (!force && (indexQuery.loading || indexQuery.current))
      return Promise.resolve();
    const t0 = performance.now();
    log.debug`indexQuery refresh start ${canonicalCrateName}@${version} reason=${reason}`;
    indexRefreshInFlight = indexQuery
      .refresh()
      .then(() => {
        const ms = Math.round(performance.now() - t0);
        const c = indexQuery.current?.crates.length ?? 0;
        log.debug`indexQuery refresh done ${canonicalCrateName}@${version} in ${ms}ms (${c} crates) reason=${reason}`;
      })
      .catch((err) => {
        log.warn`indexQuery refresh failed ${canonicalCrateName}@${version} reason=${reason}: ${String(err)}`;
      })
      .finally(() => {
        indexRefreshInFlight = null;
      });
    return indexRefreshInFlight;
  }

  function primeRouteQueries() {
    if (!canQueryCrate) return;
    // Ensure remote queries start even while status overlay is visible.
    // This prevents deadlock where status remains unknown and tree query
    // was never pulled.
    void refreshTreeQuery("prime");
    void refreshIndexQuery("prime");
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
    const queryTree = treeQuery?.current;
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
      // Parse is done: refresh canonical query snapshots and adopt them as the single tree model.
      progressConn.reset();
      void refreshTreeQuery("ready", true);
      void refreshIndexQuery("ready", true);
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

  // Hosted fallback: load lightweight crate index for cross-crate navigation
  const indexQuery = $derived(
    canQueryCrate
      ? cached(
          cacheKey("index", canonicalCrateName, version),
          getCrateIndex({ name: canonicalCrateName, version }),
        )
      : null,
  );

  // Versions list for current crate (hosted uses registry)
  const versionsQuery = $derived(
    canonicalCrateName
      ? cached(
          cacheKey("versions", canonicalCrateName),
          getCrateVersions(canonicalCrateName),
        )
      : null,
  );

  const crateVersionsMemo = new KeyedMemo(
    () =>
      keyOf(
        canonicalCrateName,
        version,
        cratesQuery.current,
        indexQuery?.current,
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
      if (indexQuery?.current) {
        for (const c of indexQuery.current.crates) {
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
    () => keyOf(canonicalCrateName, cratesQuery.current, indexQuery?.current),
    () => {
      if (cratesQuery.current && cratesQuery.current.length > 0) {
        return cratesQuery.current.filter(
          (c) => c.id !== crateName && c.name !== crateName,
        );
      }
      if (indexQuery?.current?.crates) {
        return indexQuery.current.crates.filter(
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
    if (indexQuery?.current?.crates) {
      return indexQuery.current.crates.length;
    }
    return null;
  });

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

  // Load the current crate's tree
  const treeQuery = $derived(
    canQueryCrate
      ? cached(
          cacheKey("tree", canonicalCrateName, version),
          getCrateTree({
            name: canonicalCrateName,
            version,
            mode: "structural",
            includeExternal: false,
          }),
        )
      : null,
  );

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
      ((indexQuery?.loading ?? false) && !indexQuery?.current),
  );
</script>

<div class="flex flex-1 overflow-hidden">
  {#if statusConn.status === "failed" && statusConn.action === "install_std_docs"}
    <div class="flex flex-1 items-center justify-center">
      <div class="text-center max-w-md">
        <div class="mb-2 text-lg font-semibold text-[var(--ink)]">
          Install std docs for {crateName}?
        </div>
        <div class="mb-4 text-sm text-[var(--muted)]">
          The rustdoc JSON for <code
            class="rounded bg-[var(--panel-strong)] px-1 py-0.5 text-xs"
            >{crateName} {version}</code
          >
          is not installed locally.
          {#if statusConn.installedVersion}
            Your current toolchain has version <code
              class="rounded bg-[var(--panel-strong)] px-1 py-0.5 text-xs"
              >{statusConn.installedVersion}</code
            >.
          {/if}
          This will run
          <code class="rounded bg-[var(--panel-strong)] px-1 py-0.5 text-xs"
            >rustup component add rust-docs-json</code
          >.
        </div>
        <div class="flex items-center justify-center gap-3">
          <button
            type="button"
            class="rounded-[var(--radius-control)] corner-squircle bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity"
            onclick={async () => {
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
  {:else if statusConn.status === "failed" && !treeGraph}
    <!-- Show failed state only if no tree data (allow viewing partial data on failure) -->
    <div class="flex flex-1 items-center justify-center">
      <div class="text-center">
        <div class="mb-2 text-lg font-semibold text-[var(--danger)]">
          Failed to parse {crateName}
        </div>
        {#if statusConn.error}
          <div class="mb-4 max-w-md text-sm text-[var(--muted)]">
            {statusConn.error}
          </div>
        {/if}
        <button
          type="button"
          class="rounded-[var(--radius-control)] corner-squircle bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity"
          onclick={() =>
            crateName && version && statusConn.retry(crateName, version)}
        >
          Retry
        </button>
      </div>
    </div>
  {:else}
    <!-- Left sidebar -->
    <div
      class="flex w-80 flex-col border-r border-[var(--panel-border)] bg-[var(--panel)]"
    >
      <!-- Workspace switcher -->
      <div class="border-b border-[var(--panel-border)] px-3 py-2">
        <div class="flex items-center justify-between gap-2">
          <div class="text-sm font-semibold text-[var(--ink)]">{crateName}</div>
          {#if relatedCrateCount !== null}
            <div class="text-[10px] text-[var(--muted)] font-mono">
              {relatedCrateCount} crates
            </div>
          {/if}
        </div>
        <div class="text-xs text-[var(--muted)]">{version}</div>

        <!-- Reserved slot avoids layout shift when progress badge appears/disappears -->
        <div class="mt-2 min-h-11">
          {#if showProgressBadge}
            <div
              class="flex items-center gap-2 rounded-[var(--radius-chip)] bg-[var(--accent)]/10 px-2 py-1.5"
            >
              <Loader2Icon class="h-3 w-3 animate-spin text-[var(--accent)]" />
              <div class="flex-1 min-w-0">
                <div class="text-xs text-[var(--accent)] font-medium truncate">
                  {stepLabel}
                </div>
                <div class="text-xs text-[var(--muted)] font-mono">
                  {progressConn.nodeCount.toLocaleString()} nodes · {progressConn.edgeCount.toLocaleString()}
                  edges
                </div>
              </div>
            </div>
          {/if}
        </div>

        {#if showPerfDebug && statusConn.status === "processing"}
          <div
            class="mt-2 rounded border border-[var(--panel-border)] bg-[var(--panel-solid)] px-2 py-1.5 text-[10px] font-mono text-[var(--muted)]"
          >
            <div>statusKey: {statusDebugKey}</div>
            <div>progressKey: {progressDebugKey}</div>
            <div>contentId: {progressConn.contentId ?? "-"}</div>
            <div>sequence: {progressConn.sequence ?? "-"}</div>
            <div>stale: {progressConn.stale ? "yes" : "no"}</div>
            <div>treeSource: {treeModel.source}</div>
          </div>
        {/if}
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
        <div class="mt-2 min-h-8">
          {#if otherCrates.length > 0}
            <div class="flex flex-wrap gap-1">
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
          {:else if loadingRelatedCrates}
            <div
              class="flex items-center gap-2 px-1 py-1 text-xs text-[var(--muted)]"
            >
              <Loader2Icon class="h-3 w-3 animate-spin" />
              <span>Loading crate list...</span>
            </div>
          {/if}
        </div>
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
          <!-- Server-side search results -->
          <svelte:boundary>
            {@const results = await searchQuery}
            {#if results && results.length > 0}
              <div class="p-2">
                <div class="px-2 pb-1 text-xs text-[var(--muted)]">
                  {results.length} result{results.length === 1 ? "" : "s"}
                </div>
                {#each results as node (node.id)}
                  {@const isSelected = selectedNodeId === node.id}
                  {@const KindIcon = kindIcons[node.kind] ?? kindIcons.Crate}
                  <a
                    href={getNodeUrl(node.id)}
                    data-sveltekit-noscroll
                    class="flex items-center gap-2 rounded-[var(--radius-chip)] corner-squircle px-2 py-1.5 text-sm hover:bg-[var(--panel-strong)] {isSelected
                      ? 'bg-[var(--accent)]/10 ring-1 ring-inset ring-[var(--accent)]'
                      : ''}"
                  >
                    <span
                      class="flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-chip)] corner-squircle text-white"
                      style="background-color: {kindColors[node.kind] ??
                        kindColors.Crate}"
                      ><KindIcon size={12} strokeWidth={2.5} /></span
                    >
                    <span class="min-w-0 flex-1">
                      <span class="block truncate font-medium text-[var(--ink)]"
                        >{node.name}</span
                      >
                      <span class="block truncate text-xs text-[var(--muted)]"
                        >{node.id}</span
                      >
                    </span>
                  </a>
                {/each}
              </div>
            {:else}
              <div class="p-4 text-sm text-[var(--muted)]">
                No results for "{filter}"
              </div>
            {/if}
            {#snippet pending()}
              <!-- Skeleton search results -->
              <div class="p-2">
                <Skeleton
                  width="5rem"
                  height="0.75rem"
                  rounded="sm"
                  class="mb-2 ml-2"
                />
                {#each [1, 2, 3, 4, 5] as _}
                  <div class="flex items-center gap-2 px-2 py-1.5">
                    <Skeleton width="1.25rem" height="1.25rem" rounded="md" />
                    <div class="flex-1">
                      <Skeleton
                        width="60%"
                        height="0.875rem"
                        rounded="sm"
                        class="mb-1"
                      />
                      <Skeleton width="80%" height="0.625rem" rounded="sm" />
                    </div>
                  </div>
                {/each}
              </div>
            {/snippet}
          </svelte:boundary>
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
          />
        {:else if treeQuery}
          <svelte:boundary>
            {@const _tree = await treeQuery}
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
      {#if showStreamingState && !treeGraph}
        <div class="pointer-events-none absolute left-6 top-6 z-10">
          <div
            class="rounded-[var(--radius-card)] border border-[var(--panel-border)] bg-[var(--panel-solid)] px-3 py-2 shadow-[var(--shadow-soft)]"
          >
            <div class="text-sm font-semibold text-[var(--ink)]">
              Parsing {crateName}
              {version}
            </div>
            <div class="mt-1 text-xs text-[var(--muted)]">{stepLabel}</div>
            {#if progressConn.nodeCount > 0}
              <div class="mt-1 text-xs text-[var(--muted)] font-mono">
                {progressConn.nodeCount.toLocaleString()} nodes · {progressConn.edgeCount.toLocaleString()}
                edges
              </div>
            {/if}
            <div
              class="mt-2 h-1 w-44 overflow-hidden rounded-full bg-[var(--panel-border)]"
            >
              <div
                class="h-full rounded-full bg-[var(--accent)] transition-all duration-500"
                style="width: {stepPercent}%"
              ></div>
            </div>
          </div>
        </div>
      {/if}
      {@render children()}
    </div>
  {/if}
</div>
