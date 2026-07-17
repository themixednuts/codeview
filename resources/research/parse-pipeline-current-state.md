# Codeview parse/schedule/cache pipeline — current-state brief

> Authored by the architect (Claude) from a full read of the pipeline on 2026-07-04.
> This is the grounding doc for the "parse-all-crates + schedule + cache + SSR" redesign.
> **Research threads: read this first, then your specific source files, then produce your deliverable.**

## The two halves

### A. Static build pipeline (Rust `codeview cron`, driven by `.github/workflows/parse.yml`)

Daily cron (`0 3 * * *`) + `workflow_dispatch`. Three job stages:

1. **`freshness` job** → runs `codeview cron sweep`
   - `codeview-cli/src/cron/sweep.rs`
   - Loads a **watchlist** (`--watchlist`): `catalog` (default, from `rust/catalog.json`), `top:N` (crates.io top-N by downloads), or a file path.
   - For **each** candidate, sequentially calls `crates_io::newest_version` (one HTTP call per crate) then `FreshnessRegistry::check`.
   - Emits a GHA matrix JSON `{ include: [{name, version, reason}] }`, capped at `--max-crates` (default 50; workflow passes 20).
   - **Sequential** — no concurrency over the watchlist.

2. **`parse` job** (GHA matrix, `max-parallel: 10`) → runs `codeview cron parse-one` per entry
   - `codeview-cli/src/cron/parse_one.rs` → `publisher/artifacts.rs::publish_one`
   - Pipeline: freshness check → fetch rustdoc JSON from docs.rs (`publisher/docs_rs.rs`) → `codeview_rustdoc::extract_graph` → build sharded artifacts (`publisher/shards.rs`) → upload to R2 (`publisher/r2.rs`) → record freshness.
   - Idempotency: skips upload if `graph_hash` unchanged (parser bumped, output identical).
   - Exit codes 0/64(transient)/65(permanent)/70(internal) drive GHA retry semantics.

3. **`catalog` job** → runs `codeview cron catalog`
   - `codeview-cli/src/cron/catalog.rs` → reads the whole freshness index (`FreshnessRegistry::list_all`, which does **one R2 GET per crate** under `rust/_index/`) → writes `rust/catalog.json`.

**std crates** (`codeview-cli/src/cron/seed_std.rs`): NOT on docs.rs. Sourced from a rustup-installed `rust-docs-json` component (`share/doc/rust/json/{crate}.json`), which is **nightly-only** today. `seed-std` runs the same `publish_one` with `CrateSource::LocalFile`. For bare `nightly` it writes alias pointers `stable`/`beta`/`latest` → the nightly version (a **stopgap** — "until per-channel parsing exists"). **`std.yml` is referenced in `parse.yml`'s header comment but does not exist** — std seeding is only run locally (via `cf:dev` auto-seed calling `cron seed-std --if-missing`). This is a gap.

**Freshness registry** (`publisher/freshness.rs`): per-crate JSON at `rust/_index/{name}.json`. Staleness predicate = never-parsed | newer-version | parser-revision-changed | schema-version-changed. `list_all()` = `list_prefix("rust/_index/")` then a GET per key.

**Artifacts** (`publisher/shards.rs`, wire-format frozen for the TS reader). Per crate at `rust/{storageName}/{version}/`:
- `manifest.json` — kind counts, roots + rootChildren, `populatedShards` (which of the 128 buckets are non-empty).
- `nodes/{bucket}.json` — full Node payloads, FNV-1a % 128 by nodeId.
- `node-details/{bucket}.json` — per node: edges (out+in), relatedIds, ancestors chain.
- `tree-children/{bucket}.json` — parent → children[] (for lazy tree).
- `search/{prefix}.json` + `search-manifest.json` — 2-char prefix shards.
- `aliases.json` — public-path → canonical-id.
- `{version}.json`, `latest.json`, `stable.json`… — version-alias pointers `{version}`.

**R2 abstraction** (`publisher/r2.rs`): `trait R2 { get, put, list_prefix, concurrency_hint }`. `S3Backend` (Cloudflare R2 over S3 API, concurrency 8) for prod; `LocalMiniflareBackend` (shells to `wrangler r2 object`, concurrency 1, plus a long-lived `bulk-put-local.ts` sidecar) for local `wrangler dev` parity.

### B. Serving layer (SvelteKit / TS)

**Hosted (Cloudflare)** — `codeview-ui/src/lib/server/cloudflare/provider.ts`:
- Reads the R2 sharded JSON directly. **No database.**
- `resolveArtifactRef(name, version)` resolves name variants + version aliases via multiple R2 `head`/`get` calls per request (chatty).
- Per-isolate in-process caches: `jsonCache` (128), `sourceFileCache` (512), `populatedShardsCache`, `aliasCache`. **Cold on every new Worker isolate; no Cache API / edge cache.**
- `loadNodeViewArtifact` fans out related-node bucket reads with concurrency 8.

**Local (Bun)** — `codeview-ui/src/lib/server/local/{cache.ts,provider.ts}` with a SQLite DB via drizzle. Dynamic parse-on-demand + WebSocket progress. Bun-coupled (`bun:sqlite`, `Bun.file`).

**Drizzle schema** (`codeview-ui/src/lib/server/db/schema.ts`) — SQLite, used by LOCAL mode only:
- `graph_data` (workspace blob), `source_cache`, `crate_status`, `cross_edges`.
- `crate_graphs` (index_json + tree_json blobs + counts) — **blob storage**.
- `node_details` (nodeJson per node), `edges` (normalized), `node_index` (search fields) — **normalized storage**.
- **Dual blob+normalized storage; PK-only (no secondary indexes); `node_index` is not (crate,version)-scoped; search is a table scan.**

**RPC / SSR seam** — `codeview-ui/src/lib/rpc/*.remote.ts` (SvelteKit remote functions) delegate to `Resolver`/provider (`src/lib/rpc/helpers.ts`). `+layout.server.ts` for `[crate]/[version]` awaits `nodeView`, `crateMeta`, `treeRoots`, `crateMap`, and prefetches tree children for ancestors + URL-`ex`-listed expanded ids. Version aliases resolved+redirected server-side.

**URL state today:** route params `[crate]/[version]/[...path]` encode the selected node; `?ex=` (comma-sep node ids) captures the expanded tree. Doc layout (`docLayout`), graph focus, settings axes live in **localStorage/context**, NOT the URL.

## What the user wants (verbatim intent)

1. Improve **how to get + schedule + parse ALL crates** — std/beta/nightly **plus** third-party — with smart **fan-out / scheduling / queueing**.
2. Get it right at **static build time** (hosted dynamic parsing is off for now).
3. **Validate the rustdoc "debug info" JSON correctly** (format_version, structural, robust).
4. **Proper caching**, **most efficient/fastest tables + schema**, **proper drizzle queries**.
5. **Proper SSR**; **minimize frontend logic** (backend does everything fully).
6. **Frontend state always reproducible via the URL**.
7. **Newest SvelteKit + Svelte 5 idioms.**

## Known open forks (for the architecture, not necessarily for research to settle)

- **Corpus scale**: std channels only vs top-N vs top-few-thousand vs full crates.io mirror. (Product/cost call; research should give a tiered cost/time model.)
- **Serving data model**: keep R2 sharded-JSON vs move hosted serving to Cloudflare **D1 (SQLite) + drizzle** vs hybrid (R2 blobs + D1 index). (Technical tradeoff; research should recommend.)
- **Build host/scheduler**: stay on GitHub Actions vs alternative. (Default: stay on GHA; confirm feasibility at scale.)

## Repo pointers
- Rust CLI: `codeview-cli/src/{cron,publisher}/`, parser crate `codeview-rustdoc/`, core types `codeview-core/`.
- UI: `codeview-ui/src/lib/server/{cloudflare,local,db,parser,parsing}/`, `codeview-ui/src/lib/rpc/`, routes `codeview-ui/src/routes/`.
- Workflow: `.github/workflows/parse.yml`.
