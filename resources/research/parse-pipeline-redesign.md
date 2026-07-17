# Codeview parse / schedule / cache redesign — target architecture

> Architect synthesis (Claude), 2026-07-04. Reconciles the four research docs
> ([acquisition-validation](research-acquisition-validation.md), [scheduling-fanout](research-scheduling-fanout.md),
> [serving-data-model](research-serving-data-model.md), [ssr-svelte5-urlstate](research-ssr-svelte5-urlstate.md))
> with the current-state brief ([parse-pipeline-current-state.md](parse-pipeline-current-state.md)) and the
> user's steer: **parsing is a build-time activity, driven equally by GitHub Actions OR a local machine — not a
> runtime/dynamic activity, and not coupled to any cloud-only queue.**

## Unifying principle

**Build-time parse → validate → immutable content-addressed artifacts → read-only serving (thin, URL-reproducible frontend).**
One logical data model, one read-only serving path, one runner-agnostic build orchestration in the `codeview` CLI.
No runtime parsing anywhere. GitHub Actions and a local machine are two *drivers* of the identical CLI + R2
(`STATIC_R2_TARGET=local|remote`); cloud queues are an optional accelerator, never load-bearing.

```
                       ┌──────────────── build time (GHA *or* local) ─────────────────┐
 crates.io db-dump ──▶ plan (tiers, priority, sharding) ──▶ parse-shard × N (runner-agnostic)
 rustup/​src (std)  ──▶                                          │  fetch docs.rs/sysroot (HEAD→GET, gz/zst)
                                                                │  validate (6 typed gates, format policy)
                                                                │  extract graph → build artifacts
                                                                ▼
                          R2 (local Miniflare | remote S3):  rust/{name}/{ver}/{hash}/…  +  rust/_refs/{name}.json
                                                                │  run-deltas ──▶ freshness-merge (single writer)
                                                                ▼
                       ┌──────────────────────── serve time (read-only) ──────────────────────────┐
       hosted (CF):  R2 shards + rust/_refs + Cache API (immutable) + single-flight
       local (Bun):  build-time-populated normalized SQLite (drizzle, indexed, FTS5)   ← same provider interface
                                                                │
                                                                ▼
                       SvelteKit SSR (thin) — server builds DTOs; client renders + drives URL;
                       ALL view state in the URL; preferences in SSR-safe cookies.
```

---

## Layer 1 — Acquisition + Validation (Rust) — from R1

**Validation becomes explicit + typed, living in `codeview-rustdoc`, not substring-matched in `artifacts.rs`.** Six gates:

0. **Acquisition envelope** (`docs_rs.rs`): HEAD-before-GET; classify HTTP status (`404/410/451`→permanent `NoJsonAvailable`; `408/429/5xx/timeout`→transient); record provenance (ETag, Last-Modified, sizes, SHA-256, resolved version, target).
1. **Decode integrity**: gzip **and zstd** (docs.rs's new default), read-to-end so CRC/frame validates, compressed+decompressed size caps, reject empty, UTF-8 (invalid = *permanent* corrupt, not transient).
2. **Shallow preflight + format policy**: root is object; `format_version` is `u32`; `root`/`index`/`paths`/`external_crates` present; ≥1 index item. Format policy as **data** (`RustdocFormatPolicy { min, max, allow_newer_best_effort, allow_older_compat }`); default hosted = `min=35..=max=FORMAT_VERSION`, **reject newer by default** (typed `UnsupportedFormatVersion`), local escape-hatch flags.
3. **Typed parse**: `serde_path_to_error`; typed `RustdocError` enum + `ValidatedRustdoc { krate, report }` (report carries parser + rustdoc-types format version → feeds freshness invalidation).
4. **Structural integrity**: `index` contains `root`; paths resolve; external crate ids named; local name matches requested (hyphen/underscore-normalized).
5. **Graph quality guard**: every edge endpoint exists post-prune; crate-root node exists; ≥1 local node; hard-fail all-external/empty (extends today's `validate()`); **quarantine** suspicious-but-not-corrupt.

`artifacts.rs` becomes orchestration-only: maps typed outcomes → `Permanent | Transient | Quarantine`.
Reality check: parser is pinned to `rustdoc-types 0.57` (FORMAT_VERSION 57); latest is 60; bumps are bursty → the format gate + parser-revision freshness invalidation matter.

**std, per-channel, honest** (see Fork B): `rust-docs-json` is empirically **nightly-only** (stable/beta = `available=false`). No more faking nightly as stable/beta. Versioned keys (`rust/std/nightly-YYYY-MM-DD/…`), aliases only point at real same-channel artifacts, strict failure if a channel can't be sourced.

**Bulk metadata**: one shared job pulls the **crates.io db-dump** (~1.5 GB daily) → compact snapshot (newest-non-yanked + download rank); **sparse index** as freshness overlay; API only for diagnostics (1 req/s). No per-crate API in `sweep`.

## Layer 2 — Scheduling / fan-out (Rust CLI, runner-agnostic) — from R2 + user steer

**Deterministic hash-sharding in the CLI** (`work_id = "{kind}:{name}:{version}:{channel}"`; `bucket = fnv1a64(work_id) % n`). Same logic runs as a local loop, across GHA jobs, or across machines. New/changed `codeview cron` verbs:

- `plan --mode daily|backfill --corpus … --tier … --shard-count N --max-per-shard N` → shard matrix + a plan object in R2 (reads the **aggregate** index, never `list_all()`).
- `parse-shard --shard-index k --shard-count n --max-items … --max-duration-minutes … --docsrs-min-delay-ms …` → drains its bucket, rate-limited, writes artifacts + a **run-delta**.
- `freshness-merge --run-id …` → **single-writer finalizer**: applies run-deltas to the sharded aggregate index (`rust/_index/manifest.json` → 256 shard objects), writes new-generation shards, then swaps the pointer **last** (R2 strong read-after-write makes this safe). Rebuilds `catalog.json` from the merged aggregate.
- `std-plan` / `parse-std-one` (strict channels); `failures list|requeue|suppress` (dead-letter after 7 transient / 30 days).
- Keep `sweep`/`catalog`/`seed-std` as thin compat wrappers.

**Freshness at scale**: sharded aggregate index + append-only run-deltas + single finalizer — kills the O(N) R2 GETs. **Drivers**: rewritten `parse.yml` (build CLI **once** as an artifact → `plan` → N worker jobs each `parse-shard` → `finalize`) and a **local driver** (`codeview cron parse-shard` in a loop, or a `parse-all` convenience) against local R2. Cloudflare Queues = optional phase-later accelerator for full-corpus backfill only.

## Layer 3 — Serving + caching + schema — from R3 + user steer

**Hosted stays R2-JSON (not a wholesale D1 move)** — the immutable-versioned-artifact shape beats row-billed SQL — but de-chattified:

- **Content-addressed prefixes** `rust/{name}/{version}/{artifactHash}/…` — fixes the real bug that a parser/schema rebuild *overwrites* a version's prefix, which breaks safe immutable caching.
- Small mutable **`rust/_refs/{name}.json`** (aliases + versions + hashes) → resolve once per request; **kills** the repeated `HEAD`/`LIST` in `resolveArtifactRef`/`getCrateVersions`.
- **Cache API** edge caching keyed by content-addressed synthetic URLs, `Cache-Control: immutable, max-age=1y`; per-isolate **single-flight**. This is "cache right."

**The schema / drizzle work lands on the LOCAL build-time read model** (and an *optional* later D1 index) — normalized, indexed, FTS5:
`crate_versions`, `crate_name_aliases`/`crate_version_aliases`, `nodes` (int rowid + `search_name`/`search_text`), `edges` (from+to indexes, `UNION` not `OR`), `tree_roots`, `tree_children`, `node_ancestors` (precomputed), optional `node_view_entries` (denormalized hot path), `node_search_fts` (FTS5). Keyset pagination, prepared statements, chunked `IN` (≤100 for D1 parity). Replaces today's dual blob+normalized, PK-only, unscoped-`node_index` schema.

**Local unification (Fork C)**: local mode moves from *runtime on-demand parse* → **build-time parse → populate normalized SQLite → read-only serve**, behind the **same provider interface + DTOs** as hosted. One serving path; the divergent dynamic-parse code retires (or `codeview ui` runs the build-time parse as a first-visit convenience, but serving is always from the built store).

## Layer 4 — SSR + URL-state + thin frontend — from R4

- **Dynamic SSR** for the huge corpus (never route-prerender all crates); remote `prerender(..,{dynamic:true})` for immutable per-arg reads; optional `prerender='auto' + entries` for a curated std/top-N subset.
- **Route restructure**: node data moves from `[crate]/[version]/+layout.server.ts` into `[...path]/+page.server.ts` (+ a root `+page.server.ts`); layout owns crate chrome, page owns node/view data → load re-runs align with route params.
- **URL is the single source of truth for view state.** One typed `src/lib/url-state.ts` parser/serializer. Schema: path `= /:crate/:version/:path…`; query `view=docs|graph`, `layout=classic|reading|split`, `q`, repeated `k`, `ex`, `gbi`, `viz/td/sd`, `src`, pinned `peek/rel`; hash = doc sections. Derive from `page.url` (not duplicate `$state`); event-driven updates; `goto` (rerun load) vs `replaceState` (shallow, e.g. `ex`) vs `pushState` (URL-backed modals with Back).
- **Preferences** (theme/accent/density/code-theme/link-mode/source-provider…) move to **SSR-safe cookies** (fix the localStorage first-paint), with localStorage as a client mirror; `docLayout` becomes the `layout=` view param.
- **Thin frontend**: move doc-model, relationship groups, focus-graph model+layout, tree filter/flatten/`TreeIndex`, kind facets, crate-overview layouts (treemap/sunburst/force), in-crate search → **server DTOs**; client renders DTOs + dispatches URL changes. Svelte 5 discipline (`$derived`/`onMount`/`@attach`; `$effect` only for true side effects — SSE/progress, DOM dataset).

---

## Decisions & forks

**Resolved by research (confirm):**
- **D1. Hosted serving = R2-JSON + Cache API**, *not* a wholesale DB move. D1 only as an optional later index. ✅
- **D2. Validation = 6 typed gates in `codeview-rustdoc`**; `artifacts.rs` orchestration-only. ✅
- **D3. Bulk metadata via crates.io db-dump snapshot**; sparse overlay; no per-crate API in sweep. ✅
- **D4. Runner-agnostic CLI orchestration** (deterministic sharding); GHA + local both first-class; cloud queue optional. ✅

**Resolved by the user (2026-07-04):**
- **Build driver = LOCAL.** The build/parse pipeline runs on the user's machine and **uploads artifacts to Cloudflare R2** (`STATIC_R2_TARGET=remote`, `S3Backend`). GitHub Actions is optional/secondary, not required. The runner-agnostic CLI stands; local is the primary driver. Corpus scale is per-run (`--tier`/`--corpus`) with no CI-cost constraint — the limiter is local machine time + docs.rs politeness.
- **std = ALL channels (stable, beta, nightly), built locally, uploaded.** Nightly via the `rust-docs-json` rustup component (trivial). Stable/beta via **local Rust source build** (`./x doc library`) — heavy machine time/disk; phased after nightly, with the exact JSON flag wiring verified in implementation. Honest per-channel versioned keys/aliases; no faking nightly as stable/beta.
- **Local dev KEEPS its on-demand dynamic parse.** Not retired — it doubles as the interactive parse/build tool. Two serving paths remain by design: local dynamic-parse (dev) + hosted static R2 (prod). The normalized read schema work therefore targets the **local SQLite** (indexes, FTS5, better drizzle queries), not a unification.

---

## Phased implementation plan (each phase independently verifiable; dispatched to codex, architected+reviewed by Claude)

- **P0 — Foundations** (no user-visible change)
  - P0.1 Typed 6-gate validation in `codeview-rustdoc` + `artifacts.rs` orchestration-only (+ zstd, format policy). *Verify:* cargo test + fixtures.
  - P0.2 Content-addressed artifact prefixes + provenance in freshness + publish `rust/_refs/{name}.json`. *Verify:* cargo test; artifacts land; back-compat/migration path.
- **P1 — Hosted serving fast-path**
  - P1.1 Provider resolves via `_refs` (kill HEAD/LIST) + Cache API + single-flight + immutable headers. *Verify:* cf:dev, round-trip count down, pages load.
- **P2 — Build-time scheduling/fan-out (runner-agnostic)**
  - P2.1 db-dump snapshot + bulk metadata; `sweep`→`plan` with tiers/sharding.
  - P2.2 `parse-shard` + deterministic sharding; sharded aggregate freshness index + `freshness-merge`; `failures`.
  - P2.3 std strict per-channel (`std-plan`/`parse-std-one`, honest labeling) + `std.yml`.
  - P2.4 `parse.yml` rewrite (build-once → plan → N workers → finalize) + local driver. *Verify:* local shard run against local R2; dry-run matrices.
- **P3 — Local SQLite read-model optimization** (local dynamic parse stays)
  - P3.1 Normalized drizzle read schema for the local cache (scoped `nodes`/`edges`/`tree_*`/`node_ancestors` + secondary/covering indexes + FTS5 search), replacing today's dual blob+normalized PK-only schema; keep the on-demand parse populating it. *Verify:* local mode queries hit indexes; `vp check`; crate/node/search pages work.
- **P4 — SSR + URL-state + thin frontend**
  - P4.1 Route restructure (node→page load) + typed `url-state.ts` + URL schema.
  - P4.2 Cookie-backed SSR preferences; prefs-vs-view-state split.
  - P4.3 Thin-frontend DTO migration (doc-model, relationship, tree, facets, overview, focus-graph → server). *Verify:* cf:dev + `vp check`, URLs reproduce screens.

Ordering rationale: P0 unblocks safe caching (P1) and correct artifacts for everything downstream; P2 is the scheduling core the user asked for; P3 unifies serving; P4 makes the frontend thin + URL-driven. P1 and P2 are largely independent and can interleave. Nothing here parses at runtime.
