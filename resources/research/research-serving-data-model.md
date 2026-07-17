# Serving data model, caching, schema, and queries

Authored as research/design for the codeview parse-all-crates workstream on 2026-07-04. Scope: serving read model only. No source changes or builds were run.

## Executive recommendation

Hosted serving should stay on R2 immutable JSON artifacts, but not in its current chatty form. The best near-term model is:

1. Keep R2 as the source of truth for per-crate/per-version artifacts.
2. Add Cloudflare Cache API caching for artifact reads, keyed by an immutable content-addressed artifact prefix.
3. Stop resolving aliases and concrete versions through repeated R2 `HEAD`/`GET` calls. Publish a small ref/versions index and resolve once per request or isolate.
4. Add catalog/search shards in R2 before adding D1. This keeps the operational model simple and makes cache hits serve from the local Cloudflare data center.
5. Improve the local SQLite schema now with scoped indexes, FTS5/trigram search, prepared statements, and precomputed tree/ancestor read tables. If hosted later needs SQL, use the same schema as a D1 index DB, but keep large node payloads and immutable artifact blobs in R2.

I do not recommend moving hosted serving wholesale to D1 right now. D1 is viable for a compact index and search layer, but it is not the fastest or simplest primary store for immutable, versioned, mostly-static graph payloads. The current product shape maps better to object storage plus edge cache than to row-scan-billed SQL.

## Sources checked

Local code:

- `resources/research/parse-pipeline-current-state.md`
- `codeview-ui/src/lib/server/cloudflare/provider.ts`
- `codeview-ui/src/lib/server/db/schema.ts`
- `codeview-ui/src/lib/rpc/helpers.ts`
- `codeview-cli/src/publisher/shards.rs`
- `codeview-ui/src/lib/server/local/cache.ts`
- `codeview-ui/src/lib/server/local/provider.ts`
- Route/RPC call sites under `codeview-ui/src/routes` and `codeview-ui/src/lib/rpc`

External docs, verified 2026-07-04:

- Cloudflare D1 limits: https://developers.cloudflare.com/d1/platform/limits/
- Cloudflare D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
- Cloudflare D1 read replication: https://developers.cloudflare.com/d1/best-practices/read-replication/
- Cloudflare D1 SQL statements / FTS5 support: https://developers.cloudflare.com/d1/sql-api/sql-statements/
- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/
- Cloudflare R2 limits: https://developers.cloudflare.com/r2/platform/limits/
- Cloudflare Workers Cache API: https://developers.cloudflare.com/workers/runtime-apis/cache/
- Cloudflare Cache-Control behavior: https://developers.cloudflare.com/cache/concepts/cache-control/

Verification notes:

- Cloudflare limits/pricing/cache behavior in this document were checked against official docs on 2026-07-04.
- I did not rely on a current crates.io corpus count; corpus-size conclusions are expressed as design thresholds, not live ecosystem facts.
- D1 FTS5 support is verified in official docs, but specific tokenizer option acceptance should be migration-tested before committing to those exact `CREATE VIRTUAL TABLE` statements.

## Current hosted read patterns

The hot SSR path in `[crate]/[version]/+layout.server.ts` does:

1. `resolveVersion(name, version)` for aliases such as `latest`, then redirects to a concrete version.
2. `getCrateStatus(name, version)`.
3. `nodeView(name, version, nodeId)`.
4. `crateMeta(name, version)`.
5. `treeRoots(name, version)`.
6. `treeChildren(rootId)` and then `treeChildren` for ancestors and `?ex=` expanded IDs.
7. `crateMap(name, version)` on the crate overview route.

Current Cloudflare provider behavior:

| Pattern | Provider methods | Current R2 shape |
| --- | --- | --- |
| Landing/catalog/top crates | `getTopCrates`, `searchRegistry` | Usually one `rust/catalog.json` `GET`, cached only in isolate/module memory. Fallback scans R2 prefixes and reads manifests. |
| Crate meta | `loadCrateIndex`, `getCrateVersions`, `loadTreeMeta` | `manifest.json` for index/kind counts, plus alias resolution and R2 `list` for versions. |
| Tree roots | `loadTreeRootsDirect` | `manifest.json`. |
| Tree children | `loadTreeChildrenDirect` | `manifest.json` first for `rootChildren`; otherwise one `tree-children/{bucket}.json`. |
| Ancestors | `loadTreeAncestorsDirect` | Calls full `loadNodeViewArtifact`, so ancestor-only reads pay node-detail/node/related-node work. |
| Node view | `loadNodeViewDirect` | `node-details/{bucket}.json`, `nodes/{bucket}.json`, optional `aliases.json`, then one `nodes/{bucket}.json` per distinct related-node bucket. |
| In-crate search | `searchNodesDirect` | `search-manifest.json`, then up to 64 `search/{prefix}.json` shards for 1-char queries. Each shard lookup re-resolves the artifact ref. |
| Crate map | `loadCrateMap` | `crate-map.json`. |
| Source file | `loadSourceFile` | Out of scope; remote source fetches plus per-isolate memory cache. |

The main bug in the serving model is not that R2 is the wrong store. It is that artifact reference resolution is outside the JSON LRU and is repeated inside nearly every method. A concrete-version crate page can pay many repeated `HEAD rust/{variant}/{version}/manifest.json` calls. Alias resolution adds `GET rust/{variant}/{alias}.json` plus `HEAD manifest.json`. `getCrateVersions` can add Class A R2 list operations.

## Model comparison

### A. Current R2 sharded JSON plus in-isolate LRU

Strengths:

- Matches the immutable artifact model.
- Very simple operationally: build artifacts offline, upload to R2, hosted workers only read.
- Avoids D1 database-size, row-size, query-duration, and import limits.
- R2 storage and read operations are inexpensive. Standard R2 is $0.015/GB-month, Class A is $4.50/million, Class B is $0.36/million, with 10 GB-month, 1M Class A, and 10M Class B free monthly in the current docs.
- Sharding keeps individual objects small and allows lazy tree/node loading.

Weaknesses:

- Cold isolates pay R2 repeatedly. The current `jsonCache` only helps within an isolate and only for `readJson`, not for `resolveArtifactRef`.
- `HEAD` and `GET` are both R2 Class B operations; `LIST` is Class A. Today `resolveArtifactRef` and version listing can dominate request count before the useful artifact read happens.
- Cache misses fan out: `nodeView` may read detail, node, aliases, and multiple related-node buckets. Search can read many shards.
- No edge cache. Every new isolate/data center can go to R2 even for immutable objects.

Verdict: Keep the model, but fix resolution and add edge caching. Current R2 JSON is structurally close to the right hosted read model.

### B. Cloudflare D1 plus Drizzle

One DB:

- Pros: one SQL read model can answer tree children, ancestors, node detail, catalog, versions, and search without object-bucket fanout. Indexed point queries are fast. D1 supports FTS5 and JSON functions.
- Cons: D1 paid database size is currently 10 GB per database and cannot be increased; max row/string/blob size is 2 MB; max bound parameters per query is 100; max SQL query duration is 30 seconds. Full graph blobs are unsafe; per-node rows are required.
- Cons: D1 bills rows read/written. Full table scans become cost and latency problems. Free tier is 5M rows read/day and 100k rows written/day; paid includes 25B rows read/month and 50M rows written/month, then charges. Indexing is mandatory.
- Cons: each D1 database instance is single-threaded. Read replication can reduce read latency and improve throughput, but only if the worker uses the D1 Sessions API; otherwise queries go to the primary database.
- Cons: importing a full corpus means many rows written, plus index writes. This is an offline problem, but it is still operationally heavier than R2 uploads.

DB-per-crate or DB-per-crate-version:

- Pros: keeps each DB small and localizes indexes.
- Cons: not operationally attractive. D1 paid accounts currently allow many databases, but Workers have binding limits, and normal Worker D1 access is through configured bindings. Managing thousands of D1 DBs and migrations is much harder than deterministic R2 keys. Cross-crate catalog/search still needs a global index.

Verdict: D1 is a good candidate for local-mode normalized storage and an optional hosted index/search layer. It should not replace R2 as the primary hosted graph payload store.

### C. Hybrid: R2 payloads plus D1 index

Shape:

- R2 stores immutable `manifest`, `nodes`, `node-details`, `tree-children`, `crate-map`, and source-like payloads.
- D1 stores catalog, crate aliases, concrete versions, tree edge indexes, search rows, and perhaps node summary rows.

Strengths:

- Removes R2 `HEAD`/`LIST` resolution from request paths.
- SQL is better for catalog search, substring search, and arbitrary future cross-crate queries.
- Keeps large node payloads out of D1.

Weaknesses:

- Adds a second source of truth to publish atomically.
- Every request that uses D1 now pays D1 latency and row-read billing unless endpoint responses are also cached.
- A compact R2 ref index can eliminate most current resolution costs without D1.

Verdict: Good phase-two model if catalog/search grows beyond what R2 shards plus Worker CPU can handle, or if product requirements require relational cross-crate queries. Not necessary for the immediate hosted fast path.

### D. R2 plus Cache API edge caching

Strengths:

- Best match for immutable versioned objects.
- Cache hits avoid R2 operations and JSON object fetch latency across Worker isolates in the same Cloudflare data center.
- Much simpler than D1 for hosted immutable serving.
- Keeps R2 object paths as the durable source of truth and makes cache invalidation easy if keys are content-addressed.

Weaknesses:

- Workers Cache API is per data center; it does not replicate cache contents globally.
- `cache.put` is not compatible with tiered caching. If tiered/global cache behavior matters, fetch through a cacheable custom-domain route rather than only using `cache.put`.
- Cache API `put`/`match` do not support `stale-while-revalidate`; manual stale handling is needed if mutable aliases/catalogs use SWR semantics.

Verdict: Recommended hosted model now.

## Recommended hosted serving model

Use R2 JSON plus Cache API as the primary model, with these artifact and provider changes:

1. Publish immutable artifacts under a content-addressed prefix:

   ```text
   rust/{storageName}/{version}/{artifactHash}/manifest.json
   rust/{storageName}/{version}/{artifactHash}/nodes/{bucket}.json
   rust/{storageName}/{version}/{artifactHash}/node-details/{bucket}.json
   rust/{storageName}/{version}/{artifactHash}/tree-children/{bucket}.json
   rust/{storageName}/{version}/{artifactHash}/search/{prefix}.json
   ```

   The current path `rust/{storageName}/{version}/...` is only truly immutable if a parser/schema rebuild never overwrites a version. The freshness pipeline can rebuild a version when parser/schema revision changes, so long-lived immutable cache needs either content-addressed paths or explicit global purges.

2. Publish small mutable refs last:

   ```json
   // rust/_refs/{storageName}.json
   {
     "schema_version": 1,
     "storageName": "serde",
     "displayName": "serde",
     "aliases": {
       "latest": { "version": "1.0.203", "artifactHash": "..." }
     },
     "versions": [
       { "version": "1.0.203", "artifactHash": "...", "semverSort": "..." }
     ]
   }
   ```

   This replaces repeated alias-pointer reads, manifest `HEAD`s, and R2 `list` calls in `resolveArtifactRef` and `getCrateVersions`.

3. Expand `rust/catalog.json` or add catalog shards:

   ```text
   rust/catalog.json
   rust/catalog-search/{prefix}.json
   ```

   `catalog.json` can remain the top-crates/default landing payload. For a large corpus, `catalog-search/{twoCharPrefix}.json` avoids loading/scanning a huge catalog for every search.

4. Resolve once:

   - `resolveArtifactRef(name, aliasOrVersion)` should consult `rust/_refs/{storageName}.json` through cached JSON.
   - Concrete semver resolution should not `HEAD manifest.json` in the hot path. Trust the ref index; if the manifest `GET` misses, return unavailable and log publisher inconsistency.
   - Cache the resolved ref in an isolate map keyed by normalized name plus input version. Alias entries get a short TTL; concrete version plus artifact hash can be cached for isolate lifetime.

5. Serve all artifact JSON through one `readArtifactJson(prefix, path)` helper:

   - Check in-isolate promise cache.
   - Check `caches.default`.
   - Use per-isolate single-flight for the cache miss.
   - Fetch `env.CRATE_GRAPHS.get(key)` once.
   - Store a `Response` in Cache API with immutable headers.
   - Parse JSON from the response body.

6. Keep route-level alias redirects:

   `latest`, `stable`, `beta`, and `nightly` should resolve to a concrete version first. After redirect, route and RPC calls use the concrete semver. Internal artifact cache keys then use the concrete version plus artifact hash.

## Caching design

### Cache keys

Use synthetic GET URLs for provider-internal Cache API keys:

```text
https://codeview.internal/artifacts/rust/{storageName}/{version}/{artifactHash}/manifest.json
https://codeview.internal/artifacts/rust/{storageName}/{version}/{artifactHash}/nodes/00f.json
https://codeview.internal/refs/rust/{storageName}.json
https://codeview.internal/catalog/rust/catalog.json
```

Do not key immutable artifact cache entries by alias. Alias/ref objects can point to immutable prefixes, but the actual artifact cache key should contain `{version}/{artifactHash}`.

### Headers

Immutable artifact responses:

```http
Content-Type: application/json; charset=utf-8
Cache-Control: public, max-age=31536000, s-maxage=31536000, immutable
ETag: "codeview:{storageName}:{version}:{artifactHash}:{pathHash}"
Cache-Tag: codeview-artifact, crate:{storageName}, crate-version:{storageName}@{version}, artifact:{artifactHash}
```

Mutable ref/catalog responses:

```http
Content-Type: application/json; charset=utf-8
Cache-Control: public, max-age=60, s-maxage=300
ETag: "codeview-ref:{storageName}:{refHash}"
Cache-Tag: codeview-ref, crate:{storageName}
```

If using Cache API directly, implement manual stale-while-revalidate for refs/catalog because Workers Cache API does not support `stale-while-revalidate` on `cache.put`/`cache.match`.

### Single-flight

Keep a module-level map:

```ts
const inflight = new Map<string, Promise<Response | null>>();
```

On Cache API miss:

1. If `inflight` has the cache key, await it.
2. Otherwise set an R2 fetch promise.
3. Delete the key in `finally`.

This only coalesces within one isolate. Cross-isolate coalescing would need a Durable Object or similar coordinator; that is not worth adding for immutable artifact reads.

### Compression

Recommended:

- Compress large JSON artifacts at publish time with gzip. The provider already detects gzip magic bytes and can decompress.
- Keep small refs/catalog entries uncompressed unless size warrants it.
- If artifacts are exposed directly over HTTP, either rely on Cloudflare HTTP compression for JSON responses or serve precompressed variants carefully with `Vary: Accept-Encoding`.

For internal provider reads, compression saves cache/R2 transfer bytes but adds decompression CPU. Use a threshold such as 4-8 KiB and measure.

### Reducing current R2 round trips

Current `resolveArtifactRef` often does:

```text
alias request: GET alias pointer -> HEAD manifest -> maybe HEAD fallback variant
semver request: HEAD manifest for each name variant
versions: alias resolution + R2 LIST for each variant
```

Recommended:

```text
alias request: GET/cache rust/_refs/{storageName}.json -> pick alias -> immutable prefix
semver request: GET/cache rust/_refs/{storageName}.json -> find version -> immutable prefix
versions: same ref object -> versions[]
```

Then page reads become useful artifact reads only:

- Status/meta/roots: one cached manifest read.
- Root children: manifest only for roots; one tree shard for non-root.
- Node view: detail shard + node shard + related node buckets, all through Cache API.
- Search: search manifest + prefix shards, all through Cache API.
- Crate map: one cached `crate-map.json`.

Further optional artifact optimization: build a `node-views/{bucket}.json` read shard that stores the exact `NodeView` payload per node. This can reduce cold node-view fanout to one object, but it duplicates related nodes across entries. I would only do this after measuring Cache API misses on real traffic.

## Current SQLite schema critique

`schema.ts` has the right instinct to normalize nodes and edges, but it is not a good read model yet.

Issues:

- `graph_data` stores a full workspace blob while `crate_graphs` stores `index_json`/`tree_json`, and `node_details`/`edges` store normalized data. That is three storage models at once.
- `crate_graphs.tree_json` is a full tree blob; direct tree queries also use `edges`. This duplicates behavior.
- Secondary indexes are missing. Primary keys alone do not support the hot queries.
- `edges` primary key starts `(ecosystem, crate_name, crate_version, from_id, ...)`, so outgoing edges are tolerable, but incoming edge lookups by `to_id` scan.
- `getEdgesForNode` uses `from_id = ? OR to_id = ?`; split into indexed outgoing and incoming queries or `UNION ALL`.
- `getTreeAncestorsDirect` repeatedly queries `to_id` without a supporting index.
- `getTreeChildrenDirect` checks `hasChildren` once per child, creating N+1 queries.
- `cross_edges` primary key is scoped by source crate before `from_id`/`to_id`, but `getCrossEdgeData` filters by endpoint across the ecosystem. That needs endpoint indexes.
- `node_index` is keyed only by `node_id`. It is not scoped by crate/version, so multiple versions or crates can collide. It also has no search index.
- `source_cache.path` is not scoped by crate/version/source provider.

Minimum fix to current schema:

```sql
CREATE INDEX IF NOT EXISTS edges_from_kind_idx
ON edges (ecosystem, crate_name, crate_version, from_id, kind, to_id);

CREATE INDEX IF NOT EXISTS edges_to_kind_idx
ON edges (ecosystem, crate_name, crate_version, to_id, kind, from_id);

CREATE INDEX IF NOT EXISTS edges_to_idx
ON edges (ecosystem, crate_name, crate_version, to_id);

CREATE INDEX IF NOT EXISTS crate_status_processing_idx
ON crate_status (ecosystem, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS cross_edges_from_idx
ON cross_edges (ecosystem, from_id);

CREATE INDEX IF NOT EXISTS cross_edges_to_idx
ON cross_edges (ecosystem, to_id);

CREATE INDEX IF NOT EXISTS node_index_name_idx
ON node_index (name);
```

Better fix: replace `node_index` with a scoped node/search table and add precomputed tree tables as below.

## Proposed DB read schema

This schema applies to local SQLite immediately and to D1 if hosted adopts a DB index. It is a serving read model, not a parser working table. Use raw migrations for FTS5 virtual tables; Drizzle can model the normal tables and indexes.

### Core tables

```sql
CREATE TABLE crate_versions (
  id INTEGER PRIMARY KEY,
  ecosystem TEXT NOT NULL DEFAULT 'rust',
  storage_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  version TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'crates.io',
  description TEXT,
  is_catalog INTEGER NOT NULL DEFAULT 1,
  catalog_rank INTEGER,
  semver_sort TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  graph_hash TEXT NOT NULL,
  artifact_prefix TEXT,
  node_count INTEGER NOT NULL DEFAULT 0,
  edge_count INTEGER NOT NULL DEFAULT 0,
  kind_counts_json TEXT NOT NULL,
  index_json TEXT NOT NULL,
  crate_map_json TEXT,
  parsed_at INTEGER NOT NULL,
  UNIQUE (ecosystem, storage_name, version)
);

CREATE INDEX crate_versions_catalog_idx
ON crate_versions (ecosystem, is_catalog, catalog_rank, id);

CREATE INDEX crate_versions_name_versions_idx
ON crate_versions (ecosystem, storage_name, semver_sort DESC, id);

CREATE TABLE crate_name_aliases (
  ecosystem TEXT NOT NULL DEFAULT 'rust',
  input_name TEXT NOT NULL,
  storage_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  PRIMARY KEY (ecosystem, input_name)
);

CREATE TABLE crate_version_aliases (
  ecosystem TEXT NOT NULL DEFAULT 'rust',
  storage_name TEXT NOT NULL,
  alias TEXT NOT NULL,
  crate_version_id INTEGER NOT NULL REFERENCES crate_versions(id),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (ecosystem, storage_name, alias)
);
```

### Node, edge, tree, and ancestor tables

Use integer row IDs internally to keep edge/tree indexes smaller while preserving public `node_id`.

```sql
CREATE TABLE nodes (
  id INTEGER PRIMARY KEY,
  crate_version_id INTEGER NOT NULL REFERENCES crate_versions(id),
  node_id TEXT NOT NULL,
  name TEXT NOT NULL,
  search_name TEXT NOT NULL,
  search_text TEXT NOT NULL,
  path_depth INTEGER NOT NULL,
  kind TEXT NOT NULL,
  visibility_key TEXT NOT NULL,
  is_external INTEGER NOT NULL DEFAULT 0,
  is_deprecated INTEGER NOT NULL DEFAULT 0,
  impl_trait TEXT,
  impl_category TEXT,
  summary_json TEXT NOT NULL,
  node_json TEXT NOT NULL,
  UNIQUE (crate_version_id, node_id)
);

CREATE INDEX nodes_crate_search_name_idx
ON nodes (crate_version_id, search_name, path_depth, node_id);

CREATE INDEX nodes_crate_kind_idx
ON nodes (crate_version_id, kind, id);

CREATE TABLE edges (
  crate_version_id INTEGER NOT NULL REFERENCES crate_versions(id),
  from_node_rowid INTEGER NOT NULL REFERENCES nodes(id),
  to_node_rowid INTEGER NOT NULL REFERENCES nodes(id),
  kind TEXT NOT NULL,
  confidence TEXT NOT NULL,
  is_glob INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (crate_version_id, from_node_rowid, to_node_rowid, kind, confidence)
);

CREATE INDEX edges_from_idx
ON edges (crate_version_id, from_node_rowid, kind, to_node_rowid);

CREATE INDEX edges_to_idx
ON edges (crate_version_id, to_node_rowid, kind, from_node_rowid);

CREATE TABLE tree_roots (
  crate_version_id INTEGER NOT NULL REFERENCES crate_versions(id),
  ordinal INTEGER NOT NULL,
  node_rowid INTEGER NOT NULL REFERENCES nodes(id),
  has_children INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (crate_version_id, ordinal)
);

CREATE TABLE tree_children (
  crate_version_id INTEGER NOT NULL REFERENCES crate_versions(id),
  parent_node_rowid INTEGER NOT NULL REFERENCES nodes(id),
  ordinal INTEGER NOT NULL,
  child_node_rowid INTEGER NOT NULL REFERENCES nodes(id),
  child_has_children INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (crate_version_id, parent_node_rowid, ordinal)
);

CREATE INDEX tree_children_child_idx
ON tree_children (crate_version_id, child_node_rowid, parent_node_rowid);

CREATE TABLE node_ancestors (
  crate_version_id INTEGER NOT NULL REFERENCES crate_versions(id),
  node_rowid INTEGER NOT NULL REFERENCES nodes(id),
  depth INTEGER NOT NULL,
  ancestor_node_rowid INTEGER NOT NULL REFERENCES nodes(id),
  PRIMARY KEY (crate_version_id, node_rowid, depth)
);

CREATE TABLE node_aliases (
  crate_version_id INTEGER NOT NULL REFERENCES crate_versions(id),
  public_path TEXT NOT NULL,
  canonical_node_id TEXT NOT NULL,
  PRIMARY KEY (crate_version_id, public_path)
);
```

### Optional precomputed node view table

If `nodeView` is the dominant DB-backed read, precompute the expensive adjacency payload:

```sql
CREATE TABLE node_view_entries (
  crate_version_id INTEGER NOT NULL REFERENCES crate_versions(id),
  node_rowid INTEGER NOT NULL REFERENCES nodes(id),
  edges_json TEXT NOT NULL,
  related_node_rowids_json TEXT NOT NULL,
  ancestors_json TEXT NOT NULL,
  PRIMARY KEY (crate_version_id, node_rowid)
);
```

This is intentional denormalization for a hot endpoint, unlike storing a full graph blob.

### Search tables

For prefix search, the `nodes_crate_search_name_idx` range index is enough.

For token/name search:

```sql
CREATE VIRTUAL TABLE node_search_fts USING fts5(
  name,
  node_id,
  search_text,
  content='nodes',
  content_rowid='id',
  tokenize = "unicode61 tokenchars '_:'",
  prefix = '2 3 4'
);
```

For arbitrary substring search without scanning all crate nodes:

```sql
CREATE TABLE node_name_trigrams (
  crate_version_id INTEGER NOT NULL,
  gram TEXT NOT NULL,
  node_rowid INTEGER NOT NULL REFERENCES nodes(id),
  PRIMARY KEY (crate_version_id, gram, node_rowid)
);
```

D1 supports FTS5 according to current docs, including `fts5vocab`. I did not verify whether every tokenizer option is accepted by D1; use `unicode61` first and treat tokenizer customizations as migration-tested behavior.

For crate catalog search:

```sql
CREATE VIRTUAL TABLE crate_search_fts USING fts5(
  display_name,
  storage_name,
  description,
  content='crate_versions',
  content_rowid='id',
  tokenize = "unicode61 tokenchars '_-'",
  prefix = '2 3 4'
);
```

## Drizzle shape

Representative Drizzle indexes for the hot tables:

```ts
export const nodes = sqliteTable('nodes', {
  id: integer('id').primaryKey(),
  crateVersionId: integer('crate_version_id').notNull(),
  nodeId: text('node_id').notNull(),
  name: text('name').notNull(),
  searchName: text('search_name').notNull(),
  searchText: text('search_text').notNull(),
  pathDepth: integer('path_depth').notNull(),
  kind: text('kind').notNull(),
  visibilityKey: text('visibility_key').notNull(),
  isExternal: integer('is_external', { mode: 'boolean' }).notNull().default(false),
  isDeprecated: integer('is_deprecated', { mode: 'boolean' }).notNull().default(false),
  summaryJson: text('summary_json').notNull(),
  nodeJson: text('node_json').notNull(),
}, (t) => [
  uniqueIndex('nodes_crate_node_uidx').on(t.crateVersionId, t.nodeId),
  index('nodes_crate_search_name_idx').on(t.crateVersionId, t.searchName, t.pathDepth, t.nodeId),
  index('nodes_crate_kind_idx').on(t.crateVersionId, t.kind, t.id),
]);

export const edges = sqliteTable('edges', {
  crateVersionId: integer('crate_version_id').notNull(),
  fromNodeRowid: integer('from_node_rowid').notNull(),
  toNodeRowid: integer('to_node_rowid').notNull(),
  kind: text('kind').notNull(),
  confidence: text('confidence').notNull(),
  isGlob: integer('is_glob', { mode: 'boolean' }).notNull().default(false),
}, (t) => [
  primaryKey({ columns: [t.crateVersionId, t.fromNodeRowid, t.toNodeRowid, t.kind, t.confidence] }),
  index('edges_from_idx').on(t.crateVersionId, t.fromNodeRowid, t.kind, t.toNodeRowid),
  index('edges_to_idx').on(t.crateVersionId, t.toNodeRowid, t.kind, t.fromNodeRowid),
]);
```

FTS5 virtual tables should be created in raw SQL migrations. Query them via ``db.all(sql`...`)`` or the D1 binding directly; Drizzle's table builder is not the right abstraction for `MATCH` and `bm25()`.

## Query map

The examples below assume `crateVersionId` has already been resolved once for the request.

### Resolve crate/version

```ts
const nameRow = await db
  .select({
    storageName: crateNameAliases.storageName,
    displayName: crateNameAliases.displayName,
  })
  .from(crateNameAliases)
  .where(and(
    eq(crateNameAliases.ecosystem, 'rust'),
    eq(crateNameAliases.inputName, normalizedInputName),
  ))
  .get();
```

Alias:

```ts
const row = await db
  .select({
    id: crateVersions.id,
    storageName: crateVersions.storageName,
    version: crateVersions.version,
    graphHash: crateVersions.graphHash,
    artifactPrefix: crateVersions.artifactPrefix,
  })
  .from(crateVersionAliases)
  .innerJoin(crateVersions, eq(crateVersions.id, crateVersionAliases.crateVersionId))
  .where(and(
    eq(crateVersionAliases.ecosystem, 'rust'),
    eq(crateVersionAliases.storageName, storageName),
    eq(crateVersionAliases.alias, alias),
  ))
  .get();
```

Concrete version:

```ts
const row = await db
  .select()
  .from(crateVersions)
  .where(and(
    eq(crateVersions.ecosystem, 'rust'),
    eq(crateVersions.storageName, storageName),
    eq(crateVersions.version, version),
  ))
  .get();
```

### Crate landing / catalog list

Use keyset pagination, not offset:

```ts
const rows = await db
  .select({
    id: crateVersions.id,
    name: crateVersions.displayName,
    version: crateVersions.version,
    description: crateVersions.description,
    rank: crateVersions.catalogRank,
  })
  .from(crateVersions)
  .where(and(
    eq(crateVersions.ecosystem, 'rust'),
    eq(crateVersions.isCatalog, true),
    lastRank === null
      ? sql`1 = 1`
      : sql`(${crateVersions.catalogRank}, ${crateVersions.id}) > (${lastRank}, ${lastId})`,
  ))
  .orderBy(crateVersions.catalogRank, crateVersions.id)
  .limit(limit)
  .all();
```

### Top crates

Same as catalog list with `limit = 10`. Keep `catalog_rank` assigned offline so this is an indexed read.

### Search over crate names

Prefix path:

```ts
const upper = nextPrefix(queryLower);
const rows = await db
  .select({
    name: crateVersions.displayName,
    version: crateVersions.version,
    description: crateVersions.description,
  })
  .from(crateVersions)
  .where(and(
    eq(crateVersions.ecosystem, 'rust'),
    eq(crateVersions.isCatalog, true),
    gte(crateVersions.storageName, queryLower),
    lt(crateVersions.storageName, upper),
  ))
  .orderBy(crateVersions.storageName)
  .limit(20)
  .all();
```

Description/name FTS path:

```sql
SELECT cv.display_name, cv.version, cv.description
FROM crate_search_fts f
JOIN crate_versions cv ON cv.id = f.rowid
WHERE crate_search_fts MATCH ?1
  AND cv.ecosystem = 'rust'
  AND cv.is_catalog = 1
ORDER BY bm25(crate_search_fts), cv.catalog_rank
LIMIT ?2;
```

For hosted R2-only, publish equivalent `catalog-search/{prefix}.json` shards and use the same scoring code currently used by `searchRegistry`.

### Crate meta

```ts
const meta = await db
  .select({
    indexJson: crateVersions.indexJson,
    kindCountsJson: crateVersions.kindCountsJson,
    nodeCount: crateVersions.nodeCount,
    edgeCount: crateVersions.edgeCount,
  })
  .from(crateVersions)
  .where(eq(crateVersions.id, crateVersionId))
  .get();

const versions = await db
  .select({ version: crateVersions.version })
  .from(crateVersions)
  .where(and(
    eq(crateVersions.ecosystem, 'rust'),
    eq(crateVersions.storageName, storageName),
  ))
  .orderBy(desc(crateVersions.semverSort))
  .limit(20)
  .all();
```

### Tree roots

```ts
const rows = await db
  .select({
    summaryJson: nodes.summaryJson,
    hasChildren: treeRoots.hasChildren,
  })
  .from(treeRoots)
  .innerJoin(nodes, eq(nodes.id, treeRoots.nodeRowid))
  .where(eq(treeRoots.crateVersionId, crateVersionId))
  .orderBy(treeRoots.ordinal)
  .all();
```

### Tree children

First resolve the parent node row ID from `(crateVersionId, parentId)`, using the unique index:

```ts
const parent = await db
  .select({ id: nodes.id })
  .from(nodes)
  .where(and(eq(nodes.crateVersionId, crateVersionId), eq(nodes.nodeId, parentId)))
  .get();
```

Then:

```ts
const rows = await db
  .select({
    summaryJson: nodes.summaryJson,
    hasChildren: treeChildren.childHasChildren,
  })
  .from(treeChildren)
  .innerJoin(nodes, eq(nodes.id, treeChildren.childNodeRowid))
  .where(and(
    eq(treeChildren.crateVersionId, crateVersionId),
    eq(treeChildren.parentNodeRowid, parent.id),
    cursorOrdinal === null
      ? sql`1 = 1`
      : gt(treeChildren.ordinal, cursorOrdinal),
  ))
  .orderBy(treeChildren.ordinal)
  .limit(limit)
  .all();
```

This avoids the current N+1 `hasChildren` checks.

### Ancestors

```ts
const node = await nodeByPublicId(crateVersionId, nodeId);

const rows = await db
  .select({ summaryJson: nodes.summaryJson })
  .from(nodeAncestors)
  .innerJoin(nodes, eq(nodes.id, nodeAncestors.ancestorNodeRowid))
  .where(and(
    eq(nodeAncestors.crateVersionId, crateVersionId),
    eq(nodeAncestors.nodeRowid, node.id),
  ))
  .orderBy(nodeAncestors.depth)
  .all();
```

If `node_ancestors` is not populated, use a recursive CTE in SQLite. Precomputing is faster and simpler for immutable artifacts.

### Node view

Fastest DB-backed path with precomputed adjacency:

```ts
const node = await nodeByPublicId(crateVersionId, nodeId);

const view = await db
  .select({
    nodeJson: nodes.nodeJson,
    edgesJson: nodeViewEntries.edgesJson,
    relatedNodeRowidsJson: nodeViewEntries.relatedNodeRowidsJson,
    ancestorsJson: nodeViewEntries.ancestorsJson,
  })
  .from(nodeViewEntries)
  .innerJoin(nodes, eq(nodes.id, nodeViewEntries.nodeRowid))
  .where(and(
    eq(nodeViewEntries.crateVersionId, crateVersionId),
    eq(nodeViewEntries.nodeRowid, node.id),
  ))
  .get();
```

Load related nodes in chunks because D1 has a 100-bound-parameter limit:

```ts
for (const chunk of chunks(relatedRowids, 80)) {
  const related = await db
    .select({ nodeJson: nodes.nodeJson })
    .from(nodes)
    .where(inArray(nodes.id, chunk))
    .all();
}
```

Normalized fallback without `node_view_entries`:

```sql
SELECT e.kind, e.confidence, e.is_glob,
       from_node.node_id AS from_id,
       to_node.node_id AS to_id
FROM edges e
JOIN nodes from_node ON from_node.id = e.from_node_rowid
JOIN nodes to_node ON to_node.id = e.to_node_rowid
WHERE e.crate_version_id = ?1 AND e.from_node_rowid = ?2
UNION
SELECT e.kind, e.confidence, e.is_glob,
       from_node.node_id AS from_id,
       to_node.node_id AS to_id
FROM edges e
JOIN nodes from_node ON from_node.id = e.from_node_rowid
JOIN nodes to_node ON to_node.id = e.to_node_rowid
WHERE e.crate_version_id = ?1 AND e.to_node_rowid = ?2;
```

Use `UNION` rather than `OR` so both `edges_from_idx` and `edges_to_idx` can be used.

### In-crate search

Prefix:

```ts
const q = normalizeSearch(query);
const upper = nextPrefix(q);

const rows = await db
  .select({ summaryJson: nodes.summaryJson })
  .from(nodes)
  .where(and(
    eq(nodes.crateVersionId, crateVersionId),
    eq(nodes.isExternal, false),
    gte(nodes.searchName, q),
    lt(nodes.searchName, upper),
  ))
  .orderBy(
    sql`CASE WHEN ${nodes.searchName} = ${q} THEN 0 ELSE 1 END`,
    nodes.pathDepth,
    nodes.nodeId,
  )
  .limit(limit)
  .all();
```

FTS token prefix:

```sql
SELECT n.summary_json
FROM node_search_fts f
JOIN nodes n ON n.id = f.rowid
WHERE node_search_fts MATCH ?1
  AND n.crate_version_id = ?2
  AND n.is_external = 0
ORDER BY bm25(node_search_fts), n.path_depth, n.node_id
LIMIT ?3;
```

Substring with trigrams for queries of length >= 3:

```sql
WITH wanted(gram) AS (
  VALUES (?1), (?2), (?3)
),
candidates AS (
  SELECT ng.node_rowid
  FROM node_name_trigrams ng
  JOIN wanted w ON w.gram = ng.gram
  WHERE ng.crate_version_id = ?4
  GROUP BY ng.node_rowid
  HAVING COUNT(DISTINCT ng.gram) = ?5
)
SELECT n.summary_json
FROM candidates c
JOIN nodes n ON n.id = c.node_rowid
WHERE instr(n.search_text, ?6) > 0
  AND n.is_external = 0
ORDER BY
  CASE WHEN n.search_name = ?6 THEN 0
       WHEN n.search_name LIKE ?6 || '%' THEN 1
       ELSE 2 END,
  n.path_depth,
  n.node_id
LIMIT ?7;
```

For one- and two-character substring queries, prefer prefix-only results or a tight capped scan. Arbitrary two-character substring search is too broad to optimize cheaply without a large n-gram index.

### Crate map

If precomputed:

```ts
const row = await db
  .select({ crateMapJson: crateVersions.crateMapJson })
  .from(crateVersions)
  .where(eq(crateVersions.id, crateVersionId))
  .get();
```

If multiple map option sets are required:

```sql
CREATE TABLE crate_maps (
  crate_version_id INTEGER NOT NULL REFERENCES crate_versions(id),
  options_hash TEXT NOT NULL,
  map_json TEXT NOT NULL,
  PRIMARY KEY (crate_version_id, options_hash)
);
```

## D1 versus Bun SQLite notes

- D1 queries are async and remote from the Worker isolate; Bun SQLite is in-process and sync.
- D1 currently limits bound parameters to 100. Keep `IN` chunks under that even locally to preserve parity.
- D1 bills rows scanned. Avoid `LIKE '%needle%'` scans and unindexed `OR` queries.
- D1 supports FTS5 per current docs, but raw migrations and raw SQL are safer than trying to represent virtual tables through Drizzle.
- Bun SQLite commonly supports more local pragmas and may have different extension availability. Do not assume a query plan that is fast locally is cheap in D1; check D1 query `meta.rows_read`.
- Prepared statements matter in both modes. Cache hot statements per process/isolate where the driver permits it.
- D1 read replication can lower read latency and improve read throughput, but only with the D1 Sessions API. Plain D1 binding queries continue to hit the primary.
- D1 is a poor fit for full graph blobs because of the 2 MB row/blob limit. Store per-node payloads or keep blobs in R2.

## Operational sequencing

Recommended implementation order:

1. Add content-addressed artifact prefixes or cache-tag purging. Prefer content-addressing.
2. Publish `rust/_refs/{storageName}.json` and stop using R2 `HEAD`/`LIST` in hot paths.
3. Add `readJson` Cache API support and single-flight.
4. Add catalog-search/version shards in R2 if catalog size makes `catalog.json` scanning expensive.
5. Add local SQLite indexes immediately.
6. Replace local schema with the normalized read model when touching parser storage.
7. Consider D1 hybrid only when R2 catalog/search shards are not enough or when relational hosted queries become product requirements.

## Open questions for the architect

1. Is a crate version truly immutable after first publish, or can parser/schema revisions overwrite the same `rust/{storageName}/{version}` prefix? If overwrites are possible, content-addressed artifact prefixes are required before long-lived immutable caching.
2. What corpus size is the hosted product targeting first: std plus top 30, top few thousand, or full crates.io? This determines whether R2 catalog-search shards are enough or a D1/other search index is needed.
3. Does the UI really need full `Node` payloads for every related node in `nodeView`, or would `NodeSummary` satisfy the related-node list? This affects whether a one-object `node-view` artifact is feasible.
4. Should hosted route/RPC responses themselves be cached, or only the underlying artifacts? Route-level caching could avoid repeated JSON parse/serialization for hot crate pages.
5. Should `latest` redirects use a short cache TTL, or should the UI always ask a ref endpoint before redirect? This is a freshness versus cache-hit tradeoff.
6. Are std channel aliases (`stable`, `beta`, `nightly`) expected to be historical channel docs or just current pointers? The current stopgap maps bare nightly to all aliases, which affects cache/ref semantics.
7. If D1 is used later, should it be populated from the same Rust publisher directly, or generated from R2 artifacts as a separate import step? Direct publishing is simpler to reason about; artifact-derived import is easier to backfill.
