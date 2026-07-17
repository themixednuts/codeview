# Phase B Integration Plan

Read-only analysis for replacing `codeview-ui`'s live UI in place with the generated Svelte 5 design components from `E:/Projects/htmlswap/target/jsx-out/`.

No source changes are proposed in this document beyond the future implementation steps. This plan is grounded in the current RPC layer, loaders, route consumers, existing components, the generated design output, and `resources/research/handoff-jsx-inventory.md`.

## 1. RPC / Data Inventory

### Data Types Exposed By Codeview

The live app already exposes the data needed for crate metadata, trees, node details, relationship edges, docs, source, and search.

| Area | Real shape | Evidence |
|---|---|---|
| Node | `Node` includes `id`, `name`, `kind`, `visibility`, spans, attrs, `is_external`, `is_deprecated`, fields, variants, signature, generics, docs, doc links, impl/type/import metadata, etc. | `codeview-ui/src/lib/schema.ts:359`-`411` |
| Node summary | `NodeSummary` carries the lighter row shape: `id`, `name`, `kind`, `visibility`, `is_external`, `is_deprecated`, `impl_trait`, `impl_category`, and `generics`. | `codeview-ui/src/lib/schema.ts:455`-`466`, `codeview-ui/src/lib/schema.ts:615`-`627` |
| Edge | `Edge` is `{ from, to, kind, confidence, is_glob? }`. | `codeview-ui/src/lib/schema.ts:413`-`419` |
| Edge kinds | Real relationship kinds are `Contains`, `Defines`, `Implements`, `UsesType`, `CallsStatic`, `CallsRuntime`, `Derives`, and `ReExports`. | `codeview-ui/src/lib/generated/codeview-schema.d.ts:4`-`12` |
| Node detail | `NodeDetail` is `{ node, edges, relatedNodes }`, which is the main live input for the focus graph and relationship panels. | `codeview-ui/src/lib/schema.ts:497`-`501`, `codeview-ui/src/lib/schema.ts:635`-`639` |
| Node view | `NodeView` is `{ detail, ancestors }`, so one endpoint can feed the selected node article, breadcrumbs, tree expansion, and focus graph. | `codeview-ui/src/lib/schema.ts:743`-`748` |
| Tree rows | `TreeNodeDTO` is `{ node: NodeSummary, hasChildren: boolean }`. | `codeview-ui/src/lib/schema.ts:651`-`656` |
| Crate index | `CrateIndex` is `{ name, version, crates: CrateIndexEntry[] }`; entries include `id`, `name`, `version`, and `is_external`. | `codeview-ui/src/lib/schema.ts:476`-`488` |
| Crate meta | `CrateMeta` is `{ index: CrateIndex|null, versions: string[], kindCounts: Record<NodeKind, number> }`. | `codeview-ui/src/lib/schema.ts:735`-`741` |
| Source | `SourceResult` is `{ error, content, absolutePath, repoUrl }`. | `codeview-ui/src/lib/schema.ts:504`-`509` |
| Crate map | `CrateMapData` contains module nodes, module edges, counts, visible semantic edge counts, and truncation flags for crate-root maps. | `codeview-ui/src/lib/graph/crate-map.ts:37`-`49` |

### Relationship Edge Confirmation

Real relationship-edge data exists and is already used by the current UI.

For a selected node, `Resolver.nodeDetail` builds `edges` from internal incident edges plus cross-crate edges, and returns `relatedNodes` for every related id it can resolve. The local workspace path collects graph edges where `edge.from === nodeId || edge.to === nodeId`, adds cross edges, and returns `{ node, edges, relatedNodes }` (`codeview-ui/src/lib/rpc/helpers.ts:298`-`342`). The universal/provider path similarly merges `provider.loadNodeDetail`, full graph fallback edges, and `provider.getCrossEdgeData(nodeId)`, then de-dupes by `from|to|kind|confidence|is_glob` (`codeview-ui/src/lib/rpc/helpers.ts:347`-`400`).

The focus graph should therefore be fed by `NodeView.detail.edges` and `NodeView.detail.relatedNodes`, not by `loadCrateGraph`. `loadCrateGraph` intentionally filters to structural `Contains` and `Defines` edges only (`codeview-ui/src/lib/rpc/crate.remote.ts:202`-`221`), which is useful for tree/crate structure but incomplete for the focus graph.

### Remote Functions

Inputs below are the Zod schema shapes in `src/lib/rpc/schemas.ts`; return shapes are the TypeScript/domain shapes above.

| Remote | Input | Return | Notes / evidence |
|---|---|---|---|
| `getCrates` | none | `CrateSummary[]` | Reads workspace crates and maps `{ id, name, version }`; `codeview-ui/src/lib/rpc/crate.remote.ts:24`-`33`. |
| `getTopCrates` | none | `CrateSearchResult[]` | Registry/provider top crates; `codeview-ui/src/lib/rpc/crate.remote.ts:35`-`39`. |
| `getProcessingCrates` | `{ refresh?: boolean }` | `CrateSearchResult[]` | Uses `ProcessingInputSchema`; `codeview-ui/src/lib/rpc/schemas.ts:64`-`66`, `codeview-ui/src/lib/rpc/crate.remote.ts:41`-`48`. |
| `getCrateVersions` | `{ name: string }` | `string[]` | Uses `CrateNameInputSchema`; `codeview-ui/src/lib/rpc/schemas.ts:18`-`20`, `codeview-ui/src/lib/rpc/crate.remote.ts:50`-`55`. |
| `getCrateIndex` | `{ name, version?, mode?, includeExternal? }` | `CrateIndex|null` | Loads crate dependency/index data; `CrateRefSchema` at `codeview-ui/src/lib/rpc/schemas.ts:51`-`56`, remote at `codeview-ui/src/lib/rpc/crate.remote.ts:57`-`64`. |
| `getCrateStatus` | `{ name, version }` | `CrateStatus` | Status enum includes `unknown`, `processing`, `ready`, `failed`; `codeview-ui/src/lib/schema.ts:513`-`521`, remote at `codeview-ui/src/lib/rpc/crate.remote.ts:66`-`74`. |
| `triggerCrateParse` | `{ name, version, force? }` | `void` | Command for local parse trigger; `codeview-ui/src/lib/rpc/schemas.ts:27`-`31`, `codeview-ui/src/lib/rpc/crate.remote.ts:76`-`85`. |
| `triggerCrateParseForm` | `{ name, version, force? }` | form result / void | Form wrapper for the same parse trigger; `codeview-ui/src/lib/rpc/crate.remote.ts:87`-`95`. |
| `installStdDocs` | `{ name, version }` | form result / void | Form wrapper for std docs install; `codeview-ui/src/lib/rpc/schemas.ts:33`-`36`, `codeview-ui/src/lib/rpc/crate.remote.ts:97`-`106`. |
| `searchRegistry` | `{ q: string }` | `CrateSearchResult[]` | Registry crate search, sanitized and length-gated; `codeview-ui/src/lib/rpc/schemas.ts:38`-`40`, `codeview-ui/src/lib/rpc/crate.remote.ts:108`-`117`. |
| `probeAvailableDocsVersion` | `{ name, currentVersion, candidates }` | `string|null` | Probes docs.rs JSON candidates; `codeview-ui/src/lib/rpc/schemas.ts:42`-`46`, `codeview-ui/src/lib/rpc/crate.remote.ts:119`-`200`. |
| `loadCrateGraph` | `{ name, version?, mode?, includeExternal? }` | `CrateTree|null` | Local-only query; returns summarized nodes and only `Contains`/`Defines` structural edges; `codeview-ui/src/lib/rpc/crate.remote.ts:202`-`221`. |
| `getCrateMeta` | `{ name, version?, mode?, includeExternal? }` | `CrateMeta|null` | Lightweight metadata, versions, index, and kind counts; `codeview-ui/src/lib/rpc/meta.remote.ts:11`-`24`, exported at `codeview-ui/src/lib/rpc/meta.remote.ts:32`. |
| `getStaticCrateMeta` | same as `getCrateMeta` | `CrateMeta|null` | Prerender/static variant; `codeview-ui/src/lib/rpc/meta.remote.ts:34`-`36`. |
| `getCrateMap` | `{ name, version?, mode?, includeExternal? }` | `CrateMapData|null` | Loads module map with hierarchy/matrix caps; `codeview-ui/src/lib/rpc/crateMap.remote.ts:11`-`35`, exported at `codeview-ui/src/lib/rpc/crateMap.remote.ts:46`. |
| `getStaticCrateMap` | same as `getCrateMap` | `CrateMapData|null` | Prerender/static variant; `codeview-ui/src/lib/rpc/crateMap.remote.ts:48`-`50`. |
| `getTreeRoots` | `{ name, version?, mode?, includeExternal? }` | `TreeNodeDTO[]` | Root tree rows with `hasChildren`; `codeview-ui/src/lib/rpc/roots.remote.ts:11`-`24`, exported at `codeview-ui/src/lib/rpc/roots.remote.ts:29`. |
| `getStaticTreeRoots` | same as `getTreeRoots` | `TreeNodeDTO[]` | Prerender/static variant; `codeview-ui/src/lib/rpc/roots.remote.ts:31`-`33`. |
| `getTreeChildren` | `{ name, version?, nodeId }` | `TreeNodeDTO[]` per input | Batch query with dedupe/concurrency; `TreeNodeInputSchema` at `codeview-ui/src/lib/rpc/schemas.ts:68`-`72`, remote at `codeview-ui/src/lib/rpc/children.remote.ts:37`-`87`. |
| `getStaticTreeChildren` | same as `getTreeChildren` | `TreeNodeDTO[]` | Prerender/static variant; `codeview-ui/src/lib/rpc/children.remote.ts:89`-`91`. |
| `getTreeAncestors` | `{ name, version?, nodeId }` | `NodeSummary[]` | Root-to-parent ancestor path, excluding selected node; `codeview-ui/src/lib/rpc/ancestors.remote.ts:12`-`58`, exported at `codeview-ui/src/lib/rpc/ancestors.remote.ts:64`. |
| `getStaticTreeAncestors` | same as `getTreeAncestors` | `NodeSummary[]` | Prerender/static variant; `codeview-ui/src/lib/rpc/ancestors.remote.ts:66`-`68`. |
| `getNodeView` | `{ name, version?, nodeId, refresh? }` | `NodeView|null` | Combined detail plus ancestors endpoint; `codeview-ui/src/lib/rpc/schemas.ts:74`-`80`, loader at `codeview-ui/src/lib/rpc/nodeView.remote.ts:11`-`37`, exported at `codeview-ui/src/lib/rpc/nodeView.remote.ts:44`. |
| `getStaticNodeView` | same as `getNodeView` | `NodeView|null` | Prerender/static variant; `codeview-ui/src/lib/rpc/nodeView.remote.ts:46`-`48`. |
| `getNodeDetail` | `{ nodeId, version?, refresh? }` | `NodeDetail|null` per input | Batch detail endpoint; note it does not take crate name, so route code should prefer `getNodeView` when crate context is available; `codeview-ui/src/lib/rpc/schemas.ts:58`-`62`, `codeview-ui/src/lib/rpc/detail.remote.ts:7`-`20`. |
| `getSource` | `{ file, crateName?, crateVersion?, sourceProvider? }` | `SourceResult` per input | Batch source fetch with `auto`, `crates-io`, or `github` provider; `codeview-ui/src/lib/rpc/schemas.ts:11`-`16`, `codeview-ui/src/lib/rpc/source.remote.ts:18`-`80`. |
| `searchNodes` | `{ crate?, version?, q }` | `NodeSummary[]` | Node search by name/id, excluding external nodes; can search scoped crate or whole loaded workspace; `codeview-ui/src/lib/rpc/schemas.ts:3`-`7`, `codeview-ui/src/lib/rpc/search.remote.ts:8`-`55`. |
| `checkNodeExists` | `string[]` | `Record<string, boolean>` | Workspace-backed existence map; `NodeIdsSchema` at `codeview-ui/src/lib/rpc/schemas.ts:48`-`49`, remote at `codeview-ui/src/lib/rpc/search.remote.ts:58`-`71`. |

### Route Loaders And Current Consumers

| Route | Loader data | Current consumer |
|---|---|---|
| `/` | Server loader returns `workspaceCrates` from local workspace and deferred `topCrates` from provider. | `src/routes/+page.svelte` renders registry search, workspace crates, and top crates; root search uses `searchRegistry({ q })` on debounce. Evidence: `codeview-ui/src/routes/+page.server.ts:31`-`50`, `codeview-ui/src/routes/+page.svelte:14`-`24`, `codeview-ui/src/routes/+page.svelte:98`-`145`, `codeview-ui/src/routes/+page.svelte:155`-`264`. |
| Root layout | No page data required for shell; it owns theme state, settings drawer, processing popover, and global header. | Current header/top bar lives in `src/routes/+layout.svelte`; it imports app CSS, processing remotes, realtime processing, theme/settings state, and renders children. Evidence: `codeview-ui/src/routes/+layout.svelte:2`-`7`, `codeview-ui/src/routes/+layout.svelte:219`-`298`, `codeview-ui/src/routes/+layout.svelte:308`-`456`. |
| `/:crate/:version` layout | Resolves aliases, ensures local parse, computes selected `nodeId`, returns `status`, `meta`, `roots`, `rootChildren`, `prefetchedTreeChildren`, `crateMap`, `nodeView`, and `nodeId`. | `src/routes/[crate]/[version]/+layout.svelte` feeds `CrateSidebar`, tree expansion context, search, kind filters, version switcher, and child route outlet. Evidence: `codeview-ui/src/routes/[crate]/[version]/+layout.server.ts:42`-`151`, `codeview-ui/src/routes/[crate]/[version]/+layout.svelte:219`-`246`, `codeview-ui/src/routes/[crate]/[version]/+layout.svelte:317`-`470`, `codeview-ui/src/routes/[crate]/[version]/+layout.svelte:554`-`635`. |
| `/:crate/:version` page and `/:crate/:version/...path` page | No additional data; both render `CrateNodePage`. | `CrateNodePage` derives `nodeId` from route params and passes it to `DetailView`. Evidence: `codeview-ui/src/routes/[crate]/[version]/+page.svelte:1`-`5`, `codeview-ui/src/routes/[crate]/[version]/[...path]/+page.svelte:1`-`5`, `codeview-ui/src/lib/components/CrateNodePage.svelte:1`-`11`. |

## 2. Component / Route Mapping Table

| Generated design component/view | Live route or component it replaces | Real data to wire | Delete/retire candidates after parity |
|---|---|---|---|
| `TopBar.svelte` | Root shell header in `src/routes/+layout.svelte`. Current shell also owns theme and processing UI. | Preserve current settings/theme/processing state from `+layout.svelte`; turn generated logo/nav/search controls into real links/buttons. | Replace current header markup in `+layout.svelte:308`-`432`; keep `SettingsDrawer` unless design includes its replacement. |
| `HomeMain.svelte`, `HomeLibrary.svelte`, `HomeSearch.svelte`, `HomeTerminal.svelte` | `/` route, currently `src/routes/+page.svelte`. | `workspaceCrates`, deferred `topCrates`, `searchRegistry`, optionally `searchNodes` for local scoped item search. | Current landing markup in `+page.svelte`; supporting home card markup can be deleted once selected variant is wired. |
| `CrateCard.svelte` | Current top-crate cards and workspace crate rows on `/`. | `CrateSearchResult` and `CrateSummary` mapped to design card fields. | Current card/row markup in `+page.svelte:98`-`264`. |
| `Explorer.svelte` | Main crate/node experience under `/:crate/:version` and `/:crate/:version/...path`. It should become a live `CrateExplorer` component rendered by `[crate]/[version]/+layout.svelte` or the page outlet. | `nodeView`, `roots`, `rootChildren`, `prefetchedTreeChildren`, `meta`, `crateMap`, route params, `searchNodes`, `getTreeChildren`, `getNodeView`, and `nodeUrl`. | `CrateSidebar.svelte`, `CrateNodePage.svelte`, and large parts of `DetailView.svelte` once the new shell owns tree, selected node, docs, and graph. Current props: `CrateSidebar.svelte:13`-`68`; `DetailView.svelte:48`-`107`. |
| `ExTreeRow.svelte`, `TreeRow.svelte` | Tree rows in `GraphTree` / `VirtualTree` and docs side trees. | `TreeNodeDTO.node`, `hasChildren`, expansion state, selected id, ancestors, kind filter, search state. | `GraphTree.svelte` and its row rendering once lazy loading and virtualization needs are replaced or preserved in a new live tree. Current tree data flow: `GraphTree.svelte:18`-`48`, `GraphTree.svelte:120`-`166`, `GraphTree.svelte:572`-`583`. |
| `FocusGraphView.svelte`, `GraphNodePill.svelte`, `PeekCard.svelte`, `RelGroup.svelte` | Current relationship visualization and relationship lists. | `NodeView.detail.edges`, `NodeView.detail.relatedNodes`, selected node, `edgeLabels`, `nodeUrl`, and optional lazy `getNodeView` for hover/refocus. | `RelationshipGraph.svelte` and relationship-list portions of `NodeDetails.svelte`. Current relationship split and graph input: `DetailView.svelte:251`-`314`; current graph props: `RelationshipGraph.svelte:29`-`53`. |
| New Svelte Flow crate overview based on design graph language | Current crate-root d3 force map and alternate crate-root visualizations. | `getCrateMap` / `getStaticCrateMap` `CrateMapData.moduleNodes` and `moduleEdges`. | `CrateGraph.svelte` is d3-force based (`CrateGraph.svelte:4`-`9`, `CrateGraph.svelte:63`-`104`); `DetailView.svelte:533`-`587` currently switches between `CrateGraph`, treemap, sunburst, and grid. |
| `DocClassic.svelte`, `DocReading.svelte`, `DocSplit.svelte`, `DocPane.svelte` | Node documentation view under `/:crate/:version/...path`. | Selected `Node`, ancestors, docs, doc links, source span, method/impl groupings, incoming/outgoing edges, `formatSignature`, `getSource`, and `DocToc` data. | `NodeDetails.svelte`, `Documentation.svelte`, `SignatureBlock.svelte`, `SourceViewer.svelte`, `Breadcrumbs.svelte`, and possibly `DocToc.svelte` after design doc layouts cover their behavior. Evidence: `NodeDetails.svelte:45`-`86`, `Documentation.svelte:18`-`39`, `SignatureBlock.svelte:6`-`19`, `SourceViewer.svelte:18`-`52`, `Breadcrumbs.svelte:6`-`26`. |
| `KindBadge.svelte` and icon primitives | Current kind labels, kind icons, and badge treatments across tree, search, docs, and graph. | `NodeKind` mapped through `kindLabels`, `kindColors`, and `kindIcons`. | Keep `display-names.ts` and `tree.ts` as source-of-truth helpers; replace visual badge markup. Evidence: `display-names.ts:3`-`25`, `display-names.ts:98`-`131`, `tree.ts:23`-`53`. |
| `CodeBlock.svelte`, `Signature.svelte` | Current `CodeBlock.svelte` and `SignatureBlock.svelte`. | Use existing Shiki/highlight pipeline for actual code and `formatSignature(node)` for signatures; design token renderer can be the visual shell. | Current `SignatureBlock` can retire after design signature handles inline/multiline signatures; current `CodeBlock` can retire only if the design version preserves highlighting, line numbers, and source modal needs. Evidence: `CodeBlock.svelte:4`-`33`, `SignatureBlock.svelte:6`-`87`. |

## 3. Data Mapping

### Shared Live Design Types

The generated graph mocks use a node dictionary with `{ kind, path, version?, external?, blurb?, sig? }` and tuple edges `[from, rel, to]` (`E:/Projects/htmlswap/target/jsx-out/graph-data.ts:11`-`89`). `nodeOf`, `focusModel`, and `relCounts` then derive node objects and incoming/outgoing groups (`E:/Projects/htmlswap/target/jsx-out/graph-data.ts:91`-`120`). The handoff confirms this same shape: graph data stores tuple edges over a node dictionary with `kind`, `path`, optional `version`, `external`, `blurb`, and `sig` (`resources/research/handoff-jsx-inventory.md:61`-`62`).

Port the mock helpers to live helpers instead of keeping `graph-data.ts` as runtime truth.

| Design field | Live source | Mapping |
|---|---|---|
| `node.id` | `Node.id` or `NodeSummary.id` | Preserve exact id. This is the canonical route/search/edge id. |
| `node.kind` | `Node.kind` | Convert `NodeKind` enum string to lower-case design token. Preserve full enum in `node.real.kind` for logic. |
| `node.path` | `Node.id`, ancestors, and `node.name` | For display, prefer ancestor path plus selected name when ancestors are available; otherwise use `node.id`. For links, never parse `path`; use `nodeUrl` (`codeview-ui/src/lib/url.ts:4`-`16`). |
| `node.version` | route `version`, `CrateIndex.version`, or selected crate version | Current route layout already resolves aliases to concrete versions before returning data (`codeview-ui/src/routes/[crate]/[version]/+layout.server.ts:42`-`51`). |
| `node.external` | `Node.is_external` / `NodeSummary.is_external` | Direct boolean mapping. |
| `node.blurb` | `Node.docs` first paragraph or crate search description | For nodes, derive a short first sentence/paragraph from docs. For crate cards, use `CrateSearchResult.description`. Gap: many nodes may have no docs. |
| `node.sig` | `formatSignature(node)` | Existing formatter uses structured signature/types/generics and returns inline/multiline Rust signatures (`codeview-ui/src/lib/signature-format.ts:42`-`67`). Gap: `NodeSummary` does not include full signature; only detail nodes and related full `Node` objects can show signatures. |
| `node.visibility`, `deprecated` | `Node.visibility`, `Node.is_deprecated` | Add to live design data even though the mock does not model all of it; current UI already renders both in tree/details. |

### Relationship Mapping

The generated relationship vocabulary is `contains`, `reexports`, `implements`, `defines`, and `uses` (`E:/Projects/htmlswap/target/jsx-out/graph-data.ts:1`-`9`). Real edge kinds are broader.

| Real `EdgeKind` | Design relation | Notes |
|---|---|---|
| `Contains` | `contains` | Structural hierarchy. |
| `Defines` | `defines` | Module/crate defining child item. |
| `Implements` | `implements` | Trait/type impl relation. |
| `UsesType` | `uses` | Type reference relation. |
| `ReExports` | `reexports` | Design spelling is lower-case plural. |
| `CallsStatic` | new `calls-static` or grouped `calls` | Gap: design does not currently define call lanes. Add relation token/color/labels or fold into `uses` only if product accepts losing precision. |
| `CallsRuntime` | new `calls-runtime` or grouped `calls` | Same gap as above. |
| `Derives` | new `derives` | Gap: design does not define derive lane. |

The live grouping helper should take `detail.edges`, split by direction relative to `selected.id`, group by mapped relation, and resolve the other endpoint through `detail.relatedNodes` plus the selected node. The current `DetailView` already computes incoming and outgoing edges by `e.to === detail.node.id` and `e.from === detail.node.id` (`codeview-ui/src/lib/components/DetailView.svelte:251`-`262`) and builds a related node map (`codeview-ui/src/lib/components/DetailView.svelte:264`-`280`).

### Home Views

| Design mock | Live data | Gaps / decisions |
|---|---|---|
| `POPULAR` / `D_POPULAR` / trending cards `{ name, version, desc, dl, trend, items }` | `topCrates` from `/` loader and `getTopCrates`; `CrateSearchResult` has `{ id?, name, version, description? }` (`schema.ts:523`-`528`). | Downloads `dl`, trend sparkline, item counts, and update deltas are not exposed by current remotes. Either hide those chips or add provider fields later. |
| `WORKSPACE` crate strings | `workspaceCrates: { id, name, version }[]` from `+page.server.ts` (`codeview-ui/src/routes/+page.server.ts:31`-`50`). | No gap. |
| `RECENT`, `NEW_CRATES`, `RECENTLY_UPDATED` | No direct remote. | Current home uses top crates and registry search, not recent release feeds. Treat these as optional chrome until a registry feed exists. |
| `LIVE_RESULTS.crates` | `searchRegistry({ q })` from root page (`codeview-ui/src/routes/+page.svelte:14`-`24`). | No gap for crate rows. |
| `LIVE_RESULTS.items` | `searchNodes({ q })` can search loaded workspace or scoped crate (`codeview-ui/src/lib/rpc/search.remote.ts:8`-`55`). | Gap for hosted/global all-crates item search. Root item search should be local-workspace only unless a hosted search index is added. |

### Explorer / Tree

| Design field or state | Live source | Mapping |
|---|---|---|
| `EX_TREE: { id, depth, group }[]` | `roots`, `rootChildren`, `prefetchedTreeChildren`, lazy `getTreeChildren` | Replace static array with live expanded tree. `TreeNodeDTO` already includes node summary and child availability. |
| `EX_DEPS` | `meta.index.crates` from `CrateIndex` | Use `CrateIndexEntry` rows for dependency/external crate list. Gap: the design uses dependency ids without version/status detail. |
| `stack` / `ptr` focus history | Browser navigation plus local stack | Prefer route navigation for durable selection; keep local back/forward only for in-panel graph focus if it does not fight browser history. Generated Explorer owns stack/mode/spotlight (`E:/Projects/htmlswap/target/jsx-out/Explorer.svelte:55`-`74`). |
| `mode: graph|docs` | URL query, local state, or route subview | The generated mode buttons switch graph/docs (`Explorer.svelte:124`-`135`). Use query param for shareable state. |
| Breadcrumb segments | `nodeView.ancestors` plus selected `detail.node` | Existing `Breadcrumbs` already uses ancestors plus selected (`Breadcrumbs.svelte:6`-`26`). |
| Right detail panel | `detail.node`, `detail.edges`, related node map | Replace mock `blurb/sig/version/external` panel with live node fields, signature, docs summary, incoming/outgoing counts. |
| Search/filter | `searchNodes({ crate, version, q })` and kind filters from `meta.kindCounts` | Current layout already wires sidebar search and kind filters (`[crate]/[version]/+layout.svelte:406`-`464`). |

### Docs

| Design field | Live source | Mapping |
|---|---|---|
| Title/name/kind/path | `Node` and ancestors | Direct. Current `NodeDetails` renders the selected title/kind/path from `selected` (`NodeDetails.svelte:525` onward). |
| Visibility chips | `Node.visibility`, `isPublic` helper | Existing display helper determines public visibility (`display-names.ts:50`-`58`). |
| Signature | `formatSignature(selected)` | Feed into design `Signature` shell; preserve multiline rendering for long signatures. |
| Prose body | `selected.docs` and `selected.doc_links` | Reuse current docs parsing/linking/highlighting behavior instead of inserting raw markdown. Current `Documentation` parses docs and delegates internal links (`Documentation.svelte:18`-`39`, `Documentation.svelte:87`-`123`). |
| Source pane | `selected.span` plus `getSource` | Current `SourceViewer` only fetches source when opened and can use local/crates.io/GitHub provider (`SourceViewer.svelte:18`-`52`, `SourceViewer.svelte:191`-`266`). `DocSplit` should make that fetch explicit for the visible source pane. |
| Required methods / methods | Existing `DetailView` method grouping over impls | Current grouping logic computes source impls, blanket impls, and method groups (`DetailView.svelte:316`-`431`). Move this to a reusable adapter. |
| Implementors / where used | `detail.edges` incoming/outgoing and related nodes | Current `NodeDetails` renders relationships from `selectedEdges` (`NodeDetails.svelte:941`-`1068`); where-used data is already derived in `DetailView` (`DetailView.svelte:452`-`466`). |
| TOC | Existing section derivation | `DetailView` already derives TOC entries for docs/methods/impls/relationships/attrs (`DetailView.svelte:433`-`450`). |

### Focus Graph

| Design contract | Live mapping |
|---|---|
| `focus` id prop | Current selected `nodeId` from route/layout. |
| `focusModel(focus)` | New `buildFocusModel(detail: NodeDetail)` grouped by real `Edge.kind` and direction. |
| `group.items` | Other endpoint nodes resolved from `detail.relatedNodes`, with fallback placeholders for missing external nodes. |
| `relCounts(node.id)` | For selected node, derive from `detail.edges`. For hover cards on related nodes, either show counts only within the current visible graph or lazy-load `getNodeView` for that related id to get exact counts. Mock `relCounts` counted the whole static graph (`graph-data.ts:115`-`120`), which is not available for every node without another fetch. |
| `onFocus(id)` | Navigate to `getNodeUrl(id)` and let route loader fetch the new `NodeView`; optionally keep in-panel history for keyboard shortcuts. |

## 4. Svelte Flow Graph Plan

Use `@xyflow/svelte` for the live focus graph and crate overview. It is not currently installed; `rg "@xyflow|xyflow"` found no match in `codeview-ui/package.json` or `codeview-ui/src`, while current dependencies include `d3-force` (`codeview-ui/package.json:107`) and Lucide (`codeview-ui/package.json:103`).

External API reference checked: Svelte Flow exposes `<SvelteFlow bind:nodes bind:edges />`, custom nodes via `nodeTypes`, node-level controls such as `nodesDraggable` and `nodesConnectable`, node pointer/click handlers, and `nodrag` / `nopan` class controls in its official docs: https://svelteflow.dev/api-reference/svelte-flow and https://svelteflow.dev/learn/customization/custom-nodes.

### Focus Graph Replacement

Create a live `FocusGraphFlow.svelte` replacing `RelationshipGraph.svelte`.

Inputs:

```ts
type FocusGraphFlowProps = {
  detail: NodeDetail;
  ancestors: NodeSummary[];
  crateName: string;
  crateVersion: string;
  getNodeUrl: (nodeId: string) => string;
  onNavigate?: (nodeId: string) => void;
};
```

Pipeline:

1. Normalize `detail.node` and `detail.relatedNodes` into live design nodes.
2. Split `detail.edges` into incoming/outgoing relative to `detail.node.id`, mirroring current `DetailView` logic (`DetailView.svelte:251`-`262`).
3. Group by mapped relationship kind and order by an extended `REL_ORDER`.
4. Build Svelte Flow nodes:
   - One focus node at center.
   - Related nodes on the left for incoming and right for outgoing.
   - Optional lightweight group label nodes or overlay labels for relationship lanes.
5. Build Svelte Flow edges:
   - One edge per real `Edge`, with `data` carrying `kind`, `confidence`, `is_glob`, direction, group index, and bundled control points.
   - Use a custom `RelationshipEdge.svelte` to draw the design's curved lane path and color. This preserves the design's bundled visual while keeping each real edge addressable for hover/selection.
6. Set read-only interaction:
   - `nodesDraggable={false}` and node-level `draggable: false`.
   - `nodesConnectable={false}` and no `<Handle />` components in the node pill.
   - Disable edge reconnection/deletion behavior; edges are display-only.
   - Keep pan/zoom if desired, but no edit affordances.
7. Wire hover and click:
   - `onnodepointerenter` / `onnodepointerleave` update peek state.
   - `onnodeclick` navigates to `getNodeUrl(node.id)` for click-refocus.
   - Keyboard focus should remain enabled for node pills, with Enter using the same navigation.

Positioning:

The generated `FocusGraphView` already has deterministic layout math: pill measurement, side layout, center coordinates, hub positions, row height, and gap constants (`E:/Projects/htmlswap/target/jsx-out/FocusGraphView.svelte:7`-`66`). Reuse that math as a pure `layoutFocusGraph(model, size)` function that returns Svelte Flow node positions and edge control data. This avoids force simulation and keeps the design's left=incoming, right=outgoing visual grammar.

Custom node:

Implement `GraphNodePillFlow.svelte` as the Svelte Flow custom node equivalent of `GraphNodePill.svelte`, which currently renders an absolute button with `KindBadge`, id label, focus kind text, and active/dim styles (`E:/Projects/htmlswap/target/jsx-out/GraphNodePill.svelte:4`-`44`). The flow node's `data` should include `{ node, color, isFocus, dim, active, href }`.

Peek card:

Keep `PeekCard` as a normal overlay component outside Svelte Flow's node list. It currently positions itself from hover geometry and displays kind, id, path, incoming/outgoing counts, and a focus hint (`E:/Projects/htmlswap/target/jsx-out/PeekCard.svelte:35`-`83`). In the live version, feed it the hovered flow node data and either visible-graph counts or lazy exact counts.

### Crate Root Graph Replacement

Replace the current crate-root `CrateGraph.svelte` d3-force map with a read-only Svelte Flow `CrateOverviewFlow.svelte`.

Inputs:

```ts
type CrateOverviewFlowProps = {
  data: CrateMapData;
  selectedNodeId?: string;
  getNodeUrl: (nodeId: string) => string;
};
```

Data mapping:

- `data.moduleNodes` become module flow nodes; each node carries id, label, depth/path, item counts, and kind count summaries.
- `data.moduleEdges` become module flow edges; `kindCounts` and semantic edge counts color/stroke lanes.
- Use deterministic hierarchy/grid positions from module path/depth and child counts, not d3-force. The current force layout is imported and computed in `CrateGraph.svelte:4`-`9` and `CrateGraph.svelte:63`-`74`; replacing it removes the d3-force dependency from the UI path.

Verification target:

- Relationship focus graph and crate overview both render with no draggable nodes, no handles, and no edit affordances.
- Hover peek works.
- Click navigates to the same URLs produced by current `nodeUrl`.
- Edge kinds and labels match `edgeLabels` (`display-names.ts:98`-`107`) and preserve real kinds even if grouped visually.

## 5. Tailwind V4 Compatibility

Current setup:

- `src/app.css` imports Tailwind v4 with `@import 'tailwindcss';` (`codeview-ui/src/app.css:1`).
- Vite uses the Tailwind Vite plugin with SvelteKit (`codeview-ui/vite.config.ts:110`-`112`).
- Package dependencies include Tailwind v4 and `@tailwindcss/vite` (`codeview-ui/package.json:56`, `codeview-ui/package.json:79`).
- The app already has the design-compatible Solarized token system, including root UI/code/kind/edge/status tokens and dark overrides (`codeview-ui/src/app.css:22`-`219`), code theme tokens (`codeview-ui/src/app.css:221`-`399`), accent/density/voice attributes (`codeview-ui/src/app.css:401`-`533`), and helpers such as `.mono` and `.font-display` (`codeview-ui/src/app.css:508`-`525`).

Expected class scanning behavior:

- If generated components are ported into `codeview-ui/src`, Tailwind v4 should see their static class strings.
- If components remain imported from `E:/Projects/htmlswap/target/jsx-out`, Tailwind will not reliably scan them. Do not leave live components outside the app source tree unless an explicit Tailwind `@source`/safelist strategy is added.
- Static arbitrary values used by the design, such as `grid-cols-[...]`, `text-[10.5px]`, `tracking-[0.22em]`, and `hover:bg-[color:var(--panel-muted)]`, should compile when they are literal class strings. The handoff found 62 unique arbitrary tokens and 300 uses (`resources/research/handoff-jsx-inventory.md:77`-`85`).

Patterns needing attention:

| Pattern | Risk | Plan |
|---|---|---|
| `animate-[fadeIn_.12s_ease]` | The design expects `@keyframes fadeIn`; current app CSS has `float-in` and `shimmer`, but no `fadeIn` match from the scan. Handoff calls out the original `fadeIn` dependency (`resources/research/handoff-jsx-inventory.md:99`), current keyframes are `app.css:908`-`926`. | Add a `fadeIn` keyframe or replace with existing `float-in` during port. |
| Dynamic class construction | Tailwind cannot see class names built from data. | Keep arbitrary utility strings literal; move dynamic color/kind choices to CSS variables or maps of complete literal class strings. |
| Design helper classes | Design uses `plate`, `mono`, `font-display`, `kbd`, `badge`, `codeblock`, token classes, `ulink`, and `dotsep` (`handoff-jsx-inventory.md:85`). | Most helpers already exist in `app.css` (`.mono`/`.font-display` at `app.css:508`-`525`, `.codeblock` at `app.css:723`-`736`, token classes at `app.css:738`-`860`, `.badge`/corner helpers at `app.css:862`-`875`, `.ulink`/`.dotsep` at `app.css:877`-`905`). Add only missing `plate`/surface aliases if the port keeps those classes. |
| Inline React-style numeric CSS converted to Svelte | The handoff warns React numeric styles need units and dynamic style conversion (`resources/research/handoff-jsx-inventory.md:25`-`28`, `resources/research/handoff-jsx-inventory.md:140`-`141`). | Audit generated inline styles during port; use explicit `px` or CSS variables. |
| Svelte Flow CSS | Svelte Flow needs its base/style CSS. | Import the minimal Svelte Flow base stylesheet once, then theme flow internals with existing Solarized vars to avoid a second visual system. |

## 6. A11Y Fixes

The generated design is a visual prototype and needs semantic fixes during porting.

Required fixes:

| Issue | Evidence | Fix |
|---|---|---|
| Hrefless anchors in generated top nav, home cards/lists, doc links, tree rows, and TOC links. | Examples: `TopBar.svelte:30`-`39`, `CrateCard.svelte:32`, `TreeRow.svelte:49`, plus handoff notes that product views contain many anchors and shared route components (`resources/research/handoff-jsx-inventory.md:46`-`49`). | Convert to real SvelteKit `<a href={...}>` links when navigation is intended. Convert to `<button type="button">` when it is an action. |
| Buttons without explicit type or labels. | Generated graph/topbar buttons include `TopBar.svelte:41`-`57`, `Explorer.svelte:91` and mode buttons at `Explorer.svelte:124`-`135`, `GraphNodePill.svelte:33`. | Add `type="button"`. Add `aria-label` where icon-only or ambiguous. Preserve visible labels where possible. |
| Interactive `div` for keyboard handling. | `Explorer.svelte` uses a focusable `div` with `tabindex=0` and `onkeydown` (`E:/Projects/htmlswap/target/jsx-out/Explorer.svelte:96`). | Move keyboard shortcuts to a scoped action or window listener with cleanup, or give the container a real role and accessible label if it remains focusable. |
| Hover-only graph affordances. | `FocusGraphView` has hover/peek state and legend hover buttons (`FocusGraphView.svelte:69`-`95`, `FocusGraphView.svelte:237`-`247`). | Ensure keyboard focus shows the same peek state; Enter navigates; Escape clears peek. |
| Raw docs HTML and delegated click handlers. | Current `Documentation` uses event delegation with `svelte-ignore` and `{@html}` after parsing/highlighting (`Documentation.svelte:87`-`123`). | Preserve sanitization/link rewrite behavior; if design docs use generated markup, keep real anchors and avoid inert spans for links. |
| Dialog semantics for source view. | Current `SourceViewer` dialog has explicit a11y ignores around modal shell (`SourceViewer.svelte:196`-`202`). | If replacing with `DocSplit`, avoid custom modal needs where possible; if source modal remains, use a real dialog pattern with focus trap/close semantics. |

## 7. Recommended In-Place Sequence

Each step should be independently buildable, reviewable, and committable.

### Step 1: Add Live Design Adapters And Shared Primitives

Files likely changed:

- Add `src/lib/components/design/KindBadge.svelte`, icon wrappers, `GraphNodePill` visual shell, `Signature` shell, and `CodeBlock` shell.
- Add `src/lib/design/live-node.ts` or similar adapters for node/kind/edge mapping.
- Keep existing helpers in `display-names.ts`, `tree.ts`, `url.ts`, `signature-format.ts`, and docs/source utilities.

Wire real data:

- `Node` / `NodeSummary` to live design node.
- `EdgeKind` to design relationship tokens.
- `formatSignature(node)` to design signature display.

Verify:

- `cd codeview-ui && vp run check`.
- Render existing pages unchanged except imported primitives if introduced behind feature flags.
- Confirm no Tailwind class loss for ported primitives.

### Step 2: Replace Root TopBar Shell

Files likely changed:

- `src/routes/+layout.svelte`
- New live `TopBar` component.

Wire real data:

- Current theme/settings/processing popover state remains owned by root layout.
- Generated nav/search/GitHub controls become real links/buttons.

Verify:

- `cd codeview-ui && vp run dev`.
- Visit `/`; check theme settings still apply to `documentElement` attributes, processing popover still loads via `getProcessingCrates`, and child route outlet still renders.

### Step 3: Replace Landing Page With The Chosen Home Variant

Files likely changed:

- `src/routes/+page.svelte`
- Possibly `src/lib/components/design/home/*`.

Wire real data:

- `workspaceCrates` from `+page.server.ts`.
- `topCrates` deferred promise.
- `searchRegistry({ q })` for crate search.
- Optional local `searchNodes({ q })` only for workspace item results.

Verify:

- Search for a registry crate and open its link.
- Workspace crate links still route to `/:crate/:version`.
- Build/type-check: `vp run check`, `vp run build`.

### Step 4: Introduce Live Explorer Shell Without Removing Existing Detail Logic

Files likely changed:

- `src/routes/[crate]/[version]/+layout.svelte`
- Add `src/lib/components/design/LiveExplorer.svelte`
- Add live tree adapter/components.

Wire real data:

- Use existing layout server result: `status`, `meta`, `roots`, `rootChildren`, `prefetchedTreeChildren`, `nodeView`, `nodeId`.
- Reuse `getTreeChildren`/static variants for lazy expansion.
- Reuse `nodeUrl` for navigation and query preservation.
- Keep current `DetailView` or node docs in the main pane initially while the shell/tree/right panel move to the design.

Verify:

- Run local UI via `cargo run -p codeview-cli -- ui .` or `cd codeview-ui && vp run dev`.
- Open a crate root and several nested nodes.
- Tree expands selected ancestors from server data.
- Kind filters/search still work or are intentionally hidden until Step 5.

### Step 5: Replace Relationship Graph With Svelte Flow Focus Graph

Files likely changed:

- Add `@xyflow/svelte` dependency.
- Add `FocusGraphFlow.svelte`, `GraphNodePillFlow.svelte`, `RelationshipEdge.svelte`, and focus graph adapter.
- Replace `RelationshipGraph` call sites in the live detail/explorer pane.

Wire real data:

- `nodeView.detail.edges`
- `nodeView.detail.relatedNodes`
- `edgeLabels`, relation token mapping, `getNodeUrl`

Verify:

- Open nodes with incoming and outgoing edges.
- Confirm left=incoming and right=outgoing grouping.
- Confirm real edge kinds appear, including call/derive/re-export edges where available.
- Confirm no node dragging, no handles, no edge editing.
- Hover peek and click-to-navigate work.

### Step 6: Replace Node Documentation Layout

Files likely changed:

- Add live `DocClassic`, `DocReading`, or `DocSplit` component under app source.
- Move method/impl grouping out of `DetailView` into a reusable adapter if needed.
- Replace `NodeDetails` rendering path.

Wire real data:

- `detail.node.docs`, `doc_links`, `formatSignature`, fields, variants, impl/method groups, attrs.
- `getSource` for `DocSplit` or source drawer.
- `ancestors` for breadcrumb and doc tree.

Verify:

- Open module, trait, struct, enum, function, impl, and external nodes.
- Check docs links navigate internally when node exists and externally when not.
- Check source pane handles missing source, crates.io source, GitHub source, and local source.

### Step 7: Replace Crate Root Visualization

Files likely changed:

- Add `CrateOverviewFlow.svelte` or fold crate root into `FocusGraphFlow`.
- Remove d3-force crate graph import path once no longer used.

Wire real data:

- `crateMap` from layout server or `getCrateMap`.
- `CrateMapData.moduleNodes` and `moduleEdges`.

Verify:

- Crate root shows module structure without d3-force.
- Truncation flags are surfaced when `truncatedHierarchy` or `truncatedMatrix` is true.
- Module links navigate through `getNodeUrl`.

### Step 8: Delete Replaced Components And Tighten Tests

Files likely removed only after no imports remain:

- `CrateSidebar.svelte`
- `CrateHeader.svelte`
- `GraphTree.svelte` and tree row/virtual tree pieces if not reused
- `DetailView.svelte`
- `RelationshipGraph.svelte`
- `CrateGraph.svelte`
- `CrateGrid.svelte`, treemap/sunburst components if the new crate overview fully replaces them
- `NodeDetails.svelte`
- `Documentation.svelte`
- `SourceViewer.svelte`
- `Breadcrumbs.svelte`
- `SignatureBlock.svelte`
- old home/card fragments embedded in route files

Verify:

- `rg` no longer finds imports of deleted components.
- `cd codeview-ui && vp run check`
- `cd codeview-ui && vp test`
- `cd codeview-ui && vp run build`
- Cloudflare static mode check if hosted build is in scope: `vp run cf:check` and `vp run cf:build`.

## 8. Open Decisions

1. Which home variant becomes `/` by default: `HomeMain` editorial, `HomeLibrary`, `HomeSearch`, or `HomeTerminal`.
2. Which docs layout is default for node pages: `DocClassic`, `DocReading`, or `DocSplit`.
3. Should `DocSplit` be automatic only when `selected.span` and source content exist, with `DocClassic` fallback for docs-only or external nodes?
4. Should focus graph click-refocus always navigate routes, or should it support temporary in-panel focus without changing URL?
5. Should real `CallsStatic`, `CallsRuntime`, and `Derives` get distinct design lanes, or be folded into existing `uses`/`implements` groups?
6. Should hover peek counts be exact via lazy `getNodeView` fetches, or scoped to the currently visible focus graph for speed?
7. Should crate root use a Svelte Flow module overview from `CrateMapData`, or simply show the crate node focus graph first and defer module overview?
8. Should home item search remain local-workspace only, or should Phase B include a hosted/global item search index?
