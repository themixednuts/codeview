# Research: SSR, Svelte 5 idioms, URL state, thin frontend

Date: 2026-07-04

Scope: research and design only. This pass read the current-state brief, the route/RPC/design files named in the task, and searched the repo for existing Svelte 5 async/boundary conventions. `@sveltejs/mcp` was not exposed by tool discovery in this session, so framework claims below are verified against the official Svelte/SvelteKit docs instead.

Primary framework sources:

- [SvelteKit remote functions](https://svelte.dev/docs/kit/remote-functions)
- [SvelteKit loading data](https://svelte.dev/docs/kit/load)
- [SvelteKit page options](https://svelte.dev/docs/kit/page-options)
- [SvelteKit shallow routing](https://svelte.dev/docs/kit/shallow-routing)
- [$app/navigation](https://svelte.dev/docs/kit/%24app-navigation)
- [$app/state](https://svelte.dev/docs/kit/%24app-state)
- [Svelte await expressions](https://svelte.dev/docs/svelte/await-expressions)
- [Svelte `$derived`](https://svelte.dev/docs/svelte/%24derived)
- [Svelte best practices](https://svelte.dev/docs/svelte/best-practices)
- [Svelte `{@attach ...}`](https://svelte.dev/docs/svelte/%40attach)
- [Svelte reactivity built-ins](https://svelte.dev/docs/svelte/svelte-reactivity)
- [Svelte runtime errors, async/context/effect rules](https://svelte.dev/docs/svelte/runtime-errors)

## Executive recommendation

Keep SvelteKit SSR dynamic for the huge crate corpus. Do not route-prerender every crate or node page. Use prebuilt immutable artifacts in R2 as the durable data layer, then SSR selected pages from those artifacts on demand. Use remote `prerender(..., { dynamic: true })` for immutable per-argument data reads that benefit from client Cache API persistence and CDN/static handling for a finite known subset, but keep `+*.server.ts load` as the route-critical SSR path.

Make `page.url` the source of truth for all content/view state. Treat user appearance/integration settings as preferences, not view state. Preferences may persist in cookies/localStorage, but anything needed to reproduce the same content surface must be in the path, query string, or hash.

Thin the frontend by changing client components from "compute models/layouts/filtering" to "render DTOs and dispatch URL changes". Most current client computations can move to publisher artifacts, provider methods, route loads, or remote functions.

## Current repo state

The current-state brief says hosted mode is R2-only, with immutable static graph artifacts generated offline and uploaded to R2. Local mode keeps Bun dynamic parsing and WebSocket progress. The route/RPC seam is:

- `codeview-ui/src/routes/+page.server.ts` SSR-loads workspace crates and streams a `topCrates` promise.
- `codeview-ui/src/routes/[crate]/[version]/+layout.server.ts` resolves aliases, checks status, awaits `nodeView`, maybe loads `crateMap`, loads meta/roots with short timeouts, and prefetches tree children for ancestors plus `?ex=`.
- `codeview-ui/src/routes/[crate]/[version]/+layout.svelte` owns most app state under the crate route: SSE/progress side effects, query proxies, URL param sync, kind filter state, and `LiveExplorer`.
- `+page.svelte` and `[...path]/+page.svelte` are placeholders; selected node content is rendered from the layout.
- `codeview-ui/src/lib/rpc/*.remote.ts` uses `query`, `command`, `form`, and hosted `prerender(..., { dynamic: true })` wrappers around provider/Resolver methods.
- `LiveExplorer.svelte` owns docs-vs-graph mode, lazy tree expansion/collapse caches, tree filtering/flattening, doc-model building, relationship grouping, and detail rendering.
- Graph components build focus graph models, cap/aggregate nodes, compute graph layout, compute module stats/layouts, and keep hover/peek state client-side.
- `+layout.svelte`, `SettingsDrawer.svelte`, and `app.html` read/write many preferences from `localStorage`.

Repo memory/conventions already present:

- Context setup must happen before async boundaries. The crate layout explicitly comments "Context setup (must be before any `$derived(await ...)` async boundary)", matching Svelte's async/context restriction that `setContext` must occur during initialisation, not after `await`.
- Query proxies should not be constructed during SSR when they would make a component implicitly async and render pending snippets unexpectedly. The crate layout already gates client query proxies behind `clientReady`.
- Existing Svelte 5 style uses runes, event attributes like `onclick`, snippets, `{@render}`, `@attach`, and `<svelte:boundary>`.

## 1. SSR and data-loading idioms

### Verified framework facts

Remote functions are experimental in SvelteKit 2.27+ and require opt-in. They are exported from `.remote.ts` files, can be called from components, and always run on the server. The four flavors are `query`, `command`, `form`, and `prerender`.

Use:

- `query` for server reads that may be invoked from components and refreshed. Queries are cached while on the page. Use `query.batch` for N+1 read patterns such as many tree child loads.
- `command` for imperative mutations that are not a native form interaction.
- `form` for form submissions and progressive enhancement. It works without JS by providing method/action/enhancement behavior.
- `prerender` for data that changes at most once per redeploy. SvelteKit can prerender remote results at build time; `dynamic: true` keeps the function callable for arguments not prerendered. Prerendered data can live with static assets and is cached in the browser Cache API across reloads until a new deployment.

Use `+*.server.ts load` for route-critical SSR data:

- Route params, URL-derived view state, redirects, errors, cookies, and status.
- Data needed for the first HTML response and stable hydration.
- Data that should be available as `page.data` to the whole route tree.

Use streaming promises from server `load` only for non-essential data. SvelteKit 2 streams promises returned from server load; it no longer auto-awaits top-level promises. If content is primary page content, explicitly `await` it, ideally with `Promise.all` to avoid waterfalls. If a non-fetch promise is returned for streaming, attach a catch handler so rejection is handled before rendering catches it.

Use route `export const prerender` only for a finite page set that SvelteKit can crawl or enumerate. Dynamic routes marked `prerender = true` must be reached by the prerender crawler or listed via `entries`; otherwise they cannot be served dynamically. `prerender = 'auto'` is the escape hatch for "prerender some, SSR the long tail".

### Current code assessment

Good existing choices:

- `+layout.server.ts` awaits `nodeView` because it is primary route content. This matches the "do not stream critical content that changes layout after hydration" rule.
- `+page.server.ts` streams `topCrates` and catches failure to `[]`. That is non-essential data and fits streaming.
- Hosted `getStaticCrateMeta`, `getStaticTreeRoots`, `getStaticTreeChildren`, `getStaticNodeView`, `getStaticCrateMap`, and `getStaticTreeAncestors` use remote `prerender(..., { dynamic: true })`, which is appropriate for immutable `(crate, version)` data.
- Mutations use `command`/`form` for parse/install actions.
- `query.batch` is used for tree children and node detail batch reads.

Risk/cleanup areas:

- Node-specific primary content currently lives in `[crate]/[version]/+layout.server.ts`, even though `[...path]` is the selected node route. This works, but it makes the layout depend on child path and view query state. The cleaner SvelteKit ownership is crate-global data in layout load and node/view-specific data in page load.
- `+layout.svelte` creates extra client query proxies after hydration for metadata/roots. That is useful for local parse progress, but hosted mode should prefer SSR/load data plus remote-prerender cache refreshes only when deliberately warming cache.
- Current URL state updates are split between forms, mutable `SvelteURLSearchParams`, `replaceState`, and `goto`. Consolidate this into one typed URL-state parser/serializer.

### Recommended per-route loading strategy

#### Landing route `/`

Route state:

- `?q=<crate query>` for registry search.
- `?tab=workspace|popular` for the selected browse section when no search query is active.

Load strategy:

- Keep `+page.server.ts`.
- Load workspace crates synchronously for local mode and initial SSR.
- Stream `topCrates` as non-essential data.
- If `q.length >= 2`, load or stream `searchRegistry(q)` from the server so `/ ?q=serde` SSRs the same screen as the hydrated app.
- Keep `searchRegistry` as a `query` for interactive search refinement if needed, but URL-backed SSR should not depend only on a client query.

Prerender:

- Do not route-prerender the landing page by default because local workspace state and top registry data are dynamic.
- Hosted mode can add HTTP/edge caching later, but this is not a Svelte route-prerender use case unless the landing becomes fully static.

#### Crate layout `/:crate/:version`

Route state:

- Canonical crate name and concrete semver in the path.
- Version aliases `latest`, `stable`, `beta`, `nightly` should redirect server-side to concrete versions before rendering. Alias URLs are not immutable.

Load strategy:

- Keep layout load for crate-global data: status, canonical version redirect, crate meta, versions, roots, root children, and user preference defaults.
- In hosted mode, load only from static artifacts/provider direct methods. No parse enqueue, Workflows, Durable Objects fallback, or local parser imports.
- In local mode, keep `ensureParsed` fire-and-forget/short wait behavior for dynamic parse progress.
- Return a typed `viewState` parsed from `event.url` so components do not parse search params independently.
- Return a render-ready tree sidebar DTO for the current URL state when feasible: root rows, ancestor rows, expanded rows, active filters, kind facets.

Prerender:

- Do not set route `prerender = true` for all crate pages. The corpus is too large and cannot be fully enumerated safely at SvelteKit build time.
- Optional: use `prerender = 'auto'` plus `entries` for a curated small set such as std/core/top-N, while preserving dynamic SSR for long-tail crates.
- Continue using remote `prerender(..., { dynamic: true })` for immutable hosted artifact reads.

#### Node page `/:crate/:version/:path...`

Recommended structural change:

- Move selected-node data from `[crate]/[version]/+layout.server.ts` into `[crate]/[version]/[...path]/+page.server.ts`, and add a root `+page.server.ts` for the crate-root node.
- The layout should own crate chrome and tree shell. The page should own `nodeView`, doc model, focus graph model, source split data, and crate overview data when selected node is the crate root.
- This aligns load ownership with the route params: changing `path` should rerun node page load, not implicitly overload crate layout.

Load behavior:

- Await `nodeView` or a replacement `nodePageView` DTO. It is primary content.
- Await canonical alias resolution/redirect when needed.
- Stream non-essential or mode-specific data:
  - source content for `layout=split`
  - large crate overview graph data if below-the-fold
  - related panels that are not needed for the first stable layout
- For hosted immutable data, the underlying provider should read prebuilt artifacts. Remote `prerender` functions can remain as client cache helpers.

Prerender:

- Same as crate layout: no global `prerender = true`.
- Optional finite subset via `prerender = 'auto'`/`entries`, especially for std docs or top crates, if build time and artifact count are acceptable.

## 2. URL as the single source of truth

### Current state inventory

Path-backed today:

- `/:crate/:version` selects the crate root.
- `/:crate/:version/:path...` selects a node path.
- Version aliases redirect to concrete versions in server load.

Query/hash-backed today:

- `?ex=` comma-separated expanded tree ids. Server load prefetches those ids.
- `?q=` in-crate search/filter in `[crate]/[version]/+layout.svelte`.
- repeated `?k=` kind filters in `[crate]/[version]/+layout.svelte`.
- `?gbi=1` show graph blanket/synthetic impls.
- `?perf` and `?log=` debug/perf behavior.
- Legacy/detail route supports `?viz=graph|treemap|sunburst|grid`, `?td=...` treemap drill, and `?sd=...` sunburst drill.
- `#<toc-anchor>` is set by `DocToc`.

Not URL-backed today:

- Landing selected section and crate search input are local `$state`.
- `docLayout` is localStorage/context.
- `LiveExplorer` center mode `docs|graph` is local `$state`.
- `LiveExplorer` lazy tree caches, expanded/collapsed sets, and loaded children are local state, with only extra expanded ids mirrored into `?ex=`.
- Focus graph hover/peek state is local state.
- Crate module graph hover state is local state.
- Source modal open state uses `page.state.sourceSpanKey`, not the URL.
- Settings drawer open state and processing popover state are local UI state.
- Preferences in `+layout.svelte`, `SettingsDrawer.svelte`, and `app.html` use localStorage: theme, accent, density, voice, doc layout, code themes, external link mode, source provider, VCS mode, editor scheme, ligatures.

### Preference vs view-state split

View state must be in the URL:

- Selected crate/version/node.
- In-crate search query.
- Kind filters.
- Tree expansion state that changes the visible tree.
- Center view mode: docs vs graph.
- Documentation layout if it changes the content arrangement for the current page.
- Crate overview visualization mode and drill target.
- Source modal/open source selection.
- Stable anchors/sections.
- Any user-pinned graph focus/peek/highlight. Transient pointer hover is not view state.

Preferences may persist outside the URL:

- Theme preference and resolved theme.
- Accent, density, voice/typeface.
- Code light/dark theme.
- External link behavior.
- Source provider preference.
- Editor URI scheme.
- VCS command preference.
- Ligatures.

SSR safety for preferences:

- Do not read `localStorage` during SSR. The current code guards reads with `browser`, and `app.html` uses an inline localStorage script for first paint. That avoids server crashes but is not SSR-correct HTML.
- For SSR-correct first paint, store preferences in a cookie read by root server code. SvelteKit's cookies API requires an explicit `path`, usually `path: '/'`.
- To apply `<html data-*>` attributes before paint, use a server hook with `transformPageChunk` or equivalent HTML transform based on cookie prefs. Keep localStorage only as a client mirror if desired.
- Preference writes should go through a small server-backed preference endpoint/remote form/command that sets the cookie, then update client state. For non-sensitive UI prefs, the cookie can be readable by JS if necessary, but the server should remain authoritative for SSR.

### Recommended URL schema

Canonical route paths:

```text
/                                      home
/:crate/:version                       crate root, concrete version
/:crate/:version/:module/:item...      selected node path
```

Home query params:

| Param | Values | Meaning |
| --- | --- | --- |
| `q` | string | Registry search query. If present and length >= 2, visible section is search results. |
| `tab` | `workspace`, `popular` | Browse section when `q` is absent. Default `workspace`. |

Crate/node query params:

| Param | Values | Meaning |
| --- | --- | --- |
| `view` | `docs`, `graph` | Center surface in `LiveExplorer`. Default `docs`. |
| `layout` | `classic`, `reading`, `split` | Documentation layout. Default should be deterministic, not localStorage-dependent, if omitted. User preference may choose the value inserted into new URLs. |
| `q` | string | In-crate node search/filter query. |
| `k` | repeated node kind, e.g. `k=Struct&k=Trait` | Active kind facets. Repeated params are better than comma lists because they avoid escaping issues. |
| `ex` | comma-separated node ids | User-expanded tree ids excluding selected ancestors. Sort and cap, e.g. 64 ids, to avoid URL blowup. |
| `gbi` | `1` | Include blanket/synthetic impl nodes where normally hidden. |
| `viz` | `graph`, `treemap`, `sunburst`, `grid` | Crate-root overview visualization. |
| `td` | module id | Treemap drill module id. Only meaningful when `viz=treemap`. |
| `sd` | module id | Sunburst drill module id. Only meaningful when `viz=sunburst`. |
| `src` | encoded source span key | Open source modal/split target, e.g. URLSearchParams-encoded `path/to/file.rs:10:14`. |
| `peek` | node id | Optional user-pinned graph peek/focus. Do not use for hover-only state. |
| `rel` | relationship token | Optional user-pinned relationship highlight/filter. Do not use for hover-only state. |
| `perf`, `log` | debug values | Debug-only, not part of product canonical URLs. |

Hash:

- `#documentation`, `#methods`, `#trait-impls`, `#relationships`, `#attributes`, etc. for document sections.
- The hash is appropriate for scroll position/section identity. It should not be used for data-affecting state.

Notes:

- `layout` should replace the unused/preserved current `layout` param and should be consumed by the docs surface. Remove `docLayout` as route view state from localStorage.
- Keep `ex` as a compact comma list because it is already implemented and server load uses it. If ids become too large, switch to a server-resolved expansion preset or selected ancestor-only expansion.
- Use repeated `k` params and normalize to `nodeKindOrder` when serializing so URLs are stable.
- Do not encode collapsed ids. The reproducible tree can be represented as selected ancestors plus explicit expanded extras. If the product needs "collapsed selected ancestor" state, add `cx=` explicitly; otherwise do not preserve it.

### SvelteKit mechanics

Add one typed parser/serializer, for example `src/lib/url-state.ts`:

- `parseHomeState(url: URL): HomeViewState`
- `parseExplorerState(url: URL): ExplorerViewState`
- `serializeExplorerState(base: URL, patch: Partial<ExplorerViewState>): URL`
- Validation/clamping lives here, not in components.

Server:

- Parse URL state in `+*.server.ts load`.
- Return `viewState` in `data`.
- Use the same parser in remote functions when the remote accepts view-state inputs.
- For params that affect SSR data, make load depend on URL naturally by reading `event.url`.

Client:

- Derive from `page.url`, not from duplicate local `$state`:

```ts
const viewState = $derived(parseExplorerState(page.url));
```

- Use event handlers to update URL state. Avoid watcher `$effect`s whose only purpose is to keep local state and the URL in sync.
- Use `goto(url, { replaceState: true, noScroll: true, keepFocus: true })` when a URL change should rerun load or remote data inputs, such as `q`, `k`, `view`, `layout`, `viz`, `td`, `sd`, or `src` if source data is loaded by route load.
- Use `replaceState(url, page.state)` for shallow, already-loaded state that should not rerun load, such as `ex` while toggling tree expansion.
- Use `pushState(url, state)` for URL-backed modals or panes where the Back button should close the state, such as opening source with `src=...`.
- Use `page.state` only for transient history state that is not required to reproduce a copied URL. Since the stated goal is URL reproducibility, `SourceViewer` should not rely only on `page.state.sourceSpanKey`.
- Use `SvelteURLSearchParams` only as a local mutable helper if needed. Do not let it become a second source of truth; replace it from `page.url` on navigation.

Svelte 5 discipline:

- Use `$derived`/`$derived.by` for URL-derived data, render DTO transforms, and simple maps.
- Use `onMount` for mount-only behavior: SSE connection setup, visibility listeners, initial non-SSR browser APIs.
- Use `{@attach ...}` for element-imperative behavior: dialog sync, click-outside, measuring, tooltips, scroll-to-highlight.
- Use `$effect` only for true side effects that cannot be placed in an event handler or attachment. Current legitimate examples include SSE/status reactions, DOM dataset updates after preference changes, and attach internals. URL sync should generally move to event handlers.

## 3. Thin frontend: move computation server-side

The user goal is "backend does everything fully, frontend logic minimized". In this codebase that should mean:

- The publisher/provider/route load constructs typed DTOs for the current URL state.
- Components render DTOs and dispatch navigation events.
- Browser-only code remains for DOM APIs, pointer hover, focus, scrolling, dialogs, and SSE/progress.

### Migration list

| Current client computation | Current location | Move to | Client keeps |
| --- | --- | --- | --- |
| Detail doc model: selected/filtered edges, impl split, method groups, TOC entries, where-used refs | `src/lib/detail-model.ts`, used by `LiveExplorer.svelte`, `DetailView.svelte`, docs components | Server `nodePageView` load or `resolve.nodeView` output. For hosted, precompute enough in `node-details` shards or compose in provider. | Render `DocArticle`/panels from arrays/records. No Map-building or edge filtering. |
| Relationship groups and summary counts | `LiveExplorer.svelte` `buildRelationshipGroups` | Include `relationshipGroups`, `relationshipCounts`, `docSummary` in node view DTO. | Render lists and links. |
| Focus graph model and capping | `FocusGraphFlow.svelte` `buildFocusModel`, `countEdges`, `compareFocusItem` | Server `nodeGraphView` remote/load, or prebuilt node-detail graph shard. | Render provided graph nodes/edges; pointer hover only changes classes. |
| Focus graph layout geometry | `focus-layout.ts` from browser width | Prefer precomputed layouts for fixed breakpoints (`compact`, `desktop`, maybe `wide`) in node graph view. If true responsive layout is required, server returns stable ordering/groups and client applies a tiny deterministic projection, but that is a compromise. | Select breakpoint and render positions. |
| Tree filtering and recursive loaded-tree search | `LiveExplorer.svelte` `filterTree`, `filterTreeNode`, `matchesFilter` | Provider search/tree endpoint keyed by `q`, `k`, `gbi`, selected node, and `ex`. For hosted, use `search` shards plus ancestors/children artifacts. | Render returned rows/results. |
| Tree flattening and visible rows | `LiveExplorer.svelte` `flattenTree`, parentMap, child cache orchestration | Load-returned `treeView.rows` for URL state; remote `treeRows` for shallow expand if needed. Existing `tree-children` artifacts remain storage, not UI logic. | Toggle expand -> update URL; render rows. |
| TreeIndex construction/fallback | `src/lib/graph/tree-index.ts` via `rpc/helpers.ts` | Keep server-side only or move into provider/publisher. Hosted should prefer manifest/tree-child artifacts and never load full graph. | None. |
| Kind count map/facet ordering | `+layout.svelte` `buildKindCountMap` | `crateMeta` should return `kindFacets: Array<{kind,label,count,active}>` or layout load derives it. Counts already come from manifest in hosted mode. | Render buttons; active state from URL. |
| Workspace crate/version map and href construction | `+layout.svelte` `crateVersions`, `getNodeUrl`, `LiveExplorer` link building | Server returns `href` on DTOs wherever possible. Layout returns crate version map only if client truly needs ad hoc links. | Use DTO hrefs. |
| Crate overview graph node selection, module stats, edge styling, hierarchy layout | `CrateOverviewFlow.svelte` | `crateOverviewView({viz, selectedNodeId, drillId})` load/remote, backed by `crate-map.json` plus precomputed layouts/stats. | Render Flow nodes/edges or SVG from DTO. |
| Treemap squarified layout | `computeSquarifiedLayout` used by `CrateTreemap.svelte` | Precompute in `crate-map.json` for standard sizes or return from `crateOverviewView`. | Render rects and hover. |
| Sunburst radial layout | `computeSunburstArcs` used by `CrateSunburst.svelte` | Precompute arcs in `crate-map.json` or return from `crateOverviewView`. | Render arcs and hover. |
| Force-directed module layout | `computeForceDirectedLayout` in `crate-map.ts` | If used in product UI, precompute offline. Deterministic but CPU-heavy and not needed in the browser. | Render positions. |
| In-crate search filtering | `searchNodes` remote plus client loaded-tree filtering | Server/provider `searchNodesDirect` already exists. Expand it to accept `kind`, `gbi`, and return render-ready result rows with hrefs. Use SSR load for `?q`. | Debounced URL update and result rendering. |
| Source split loading | `DocSplit.svelte` calls `getSource` from component | If `layout=split`, page load should return/stream source result because it is part of the selected view. Keep remote query for modal/on-demand source. | Render code block; source modal URL open/close. |
| Home search state | `+page.svelte` local search/debounce | URL-backed `?q` and server-loaded search results. Remote query can remain for typeahead but results should be reproducible on reload. | Input value from URL, debounced `goto`. |

### Suggested DTOs

Crate layout data:

```ts
type CrateLayoutData = {
  status: CrateStatus;
  meta: CrateMeta;
  versions: string[];
  viewState: ExplorerViewState;
  kindFacets: Array<{ kind: NodeKind; label: string; count: number; active: boolean }>;
  treeView: {
    rows: Array<{
      id: string;
      href: string;
      depth: number;
      name: string;
      kind: NodeKind;
      visibility: Visibility;
      hasChildren: boolean;
      expanded: boolean;
      selected: boolean;
      ancestor: boolean;
    }>;
    expandedIds: string[];
  };
};
```

Node page data:

```ts
type NodePageData = {
  nodeView: NodeView;
  docModel: DetailDocModelDTO;
  docsView: { layout: 'classic' | 'reading' | 'split' };
  focusGraph?: FocusGraphDTO;
  source?: Promise<SourceResult | null>;
};
```

Crate overview data:

```ts
type CrateOverviewView = {
  mode: 'graph' | 'treemap' | 'sunburst' | 'grid';
  selectedModuleId: string | null;
  nodes: RenderNodeDTO[];
  edges: RenderEdgeDTO[];
  rects?: TreemapRectDTO[];
  arcs?: SunburstArcDTO[];
  stats: CrateOverviewStats;
};
```

Use DTOs with arrays/records instead of `Map`/`Set` for remote functions. `load` can serialize richer structures, but plain DTOs keep remote and load paths consistent.

## Recommended implementation sequence

1. Add typed URL-state parse/serialize helpers and switch home/search/explorer mode/kind/doc layout/source state to read from `page.url`.
2. Move `docLayout` from localStorage-only state to `layout=` query state. Keep a cookie preference only as a default when creating new URLs.
3. Move node-specific server work from crate layout into root/node page loads, or at least split the server helper internally into `loadCrateShell` and `loadNodePageView`.
4. Extend `nodeView`/provider DTOs with `docModel`, `relationshipGroups`, and render-ready hrefs.
5. Add a server `treeView` endpoint/load result keyed by URL state. Remove recursive client tree filtering/flattening once it covers search/kind/expanded rows.
6. Add `crateOverviewView` and migrate graph/treemap/sunburst layout calculations out of browser components.
7. Replace remaining URL-sync `$effect`s with event-driven URL updates. Keep effects only for true side effects.
8. Add cookie-backed SSR preferences and remove first-paint dependence on localStorage in `app.html`.

## Open questions for the architect

1. What is the exact definition of "reproducible screen"? I treated content/navigation/view-mode as URL state and appearance/integration settings as preferences. If pixel-exact theme/accent/density reproduction is required, add an explicit shared-preferences URL param or a "copy link with appearance" feature.
2. Should crate/node route HTML be partially prerendered for a curated catalog (`std`, `core`, top-N), or should all crate pages remain dynamic SSR over immutable R2 artifacts?
3. Should selected-node data move from `[crate]/[version]/+layout.server.ts` to root/node `+page.server.ts` now, or wait until the DTO migration?
4. What URL length cap is acceptable for `ex=`? If expanded ids routinely exceed 2-4 KB, the tree expansion state needs compression, presets, or a server-side share token.
5. Should graph layouts be precomputed for fixed breakpoints, or is a small client projection from server-ranked graph groups acceptable?
6. For source modal URLs, is exposing `file:line:end` in `src=` acceptable, or should source spans be referenced by a server-generated stable span id?
7. Remote functions are still experimental per the official docs. Is the project comfortable leaning further into them, or should route loads and conventional server endpoints remain the stable primary API with remote functions as an enhancement layer?

