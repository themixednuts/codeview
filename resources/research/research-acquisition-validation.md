# Research: Acquisition and Validation of rustdoc JSON

Date: 2026-07-04

This note covers acquisition and validation for rustdoc JSON artifacts used by `codeview-cli` before the UI serves static graph artifacts. It is grounded in `resources/research/parse-pipeline-current-state.md`, the current publisher and std seeding code, and the `codeview-rustdoc` parser crate.

## Executive Findings

- `rustdoc-types::FORMAT_VERSION` is the schema compatibility number for rustdoc JSON. It is incremented for breaking JSON-format changes, returned in the JSON as `Crate::format_version`, and consumers are expected to assert compatibility before processing the payload ([rustdoc-types latest docs](https://docs.rs/rustdoc-types/latest/rustdoc_types/constant.FORMAT_VERSION.html), [rust source docs](https://github.com/rust-lang/rust/blob/main/src/rustdoc-json-types/lib.rs)).
- The checked-in parser depends on `rustdoc-types = "0.57.0"`, whose `FORMAT_VERSION` is 57 ([rustdoc-types 0.57.0 docs](https://docs.rs/rustdoc-types/0.57.0/rustdoc_types/constant.FORMAT_VERSION.html)). The latest observed crate release is `rustdoc-types 0.60.0`, format 60. Release history in the crates.io sparse index shows quiet periods and bursty breaking bumps: `0.48.0` through `0.53.0` were all published in June 2025, and `0.58.0` through `0.60.0` landed within six days in June 2026.
- docs.rs now builds and hosts rustdoc JSON for crates published after 2025-05-23 and also hosts selected older rebuilt artifacts. Older docs.rs JSON can preserve old `format_version` values; newer requested formats can be addressed by URL when available ([docs.rs rustdoc JSON page](https://docs.rs/about/rustdoc-json)).
- The current code treats rustdoc JSON decoding/parsing as a mostly untyped operation. `artifacts.rs` maps parser failures by substring matching on messages such as `unsupported rustdoc`, `format_version`, and `unknown variant`; invalid UTF-8 is currently classified as transient. That is too weak for hosted static artifacts.
- As of 2026-07-04, rustup distribution manifests show the `rust-docs-json` package is available for nightly x86_64 but not for stable or beta x86_64. The current `seed_std` stable/beta aliasing of nightly artifacts should be replaced if stable/beta are first-class product targets.
- For scheduling many crates, the crates.io API should not be used one crate at a time. Use the daily crates.io database dump for global ranking and newest non-yanked version calculation, with sparse-index overlays for freshness or smaller watchlists.

## 1. rustdoc JSON Format and Validation

### Findings

`FORMAT_VERSION` is a `u32` constant in `rustdoc-types`. Its documentation says it is incremented whenever the JSON output contains a breaking change, and that it is returned in `Crate::format_version` so downstream users can assert the version they support ([latest docs](https://docs.rs/rustdoc-types/latest/rustdoc_types/constant.FORMAT_VERSION.html), [rust source docs](https://github.com/rust-lang/rust/blob/main/src/rustdoc-json-types/lib.rs)). In `rustdoc-types 0.57.0`, the value is 57; in the latest observed docs it is 60.

The format number is tied to the `rustdoc-types` crate because that crate is generated from the rustdoc JSON schema definitions in the Rust repository. A parser compiled against `rustdoc-types 0.57.0` has data structures matching format 57. It can often deserialize older or newer JSON by ignoring extra fields or filling defaults, but that is best-effort compatibility, not a guarantee.

docs.rs explicitly warns that rustdoc JSON output from old builds may have old `format_version` values. It also supports URLs for specific requested format versions, for example `https://docs.rs/crate/clap/latest/json/42`, when that converted format is available ([docs.rs rustdoc JSON page](https://docs.rs/about/rustdoc-json)).

### Current codeview behavior

The current parser is intentionally lenient:

- [codeview-rustdoc/src/lib.rs](../../codeview-rustdoc/src/lib.rs) depends on `rustdoc-types = "0.57.0"`.
- `parse_rustdoc_lenient` first tries `serde_json::from_str::<rdt::Crate>`.
- On failure it parses to `serde_json::Value`, reads `format_version`, logs a warning if the source version is newer than `rdt::FORMAT_VERSION`, applies compatibility rewrites, then deserializes.
- Compatibility currently injects defaults for older target and attribute shapes, and normalizes unknown attribute variants.
- `extract_graph` skips external nodes, builds a graph, materializes missing external edge stubs, and prunes dangling edges.

The publisher error boundary is weaker than the parser intent. In [codeview-cli/src/publisher/artifacts.rs](../../codeview-cli/src/publisher/artifacts.rs), UTF-8 failure is marked transient, and parser failure classification relies on message substrings:

- `msg.contains("unsupported rustdoc")`
- `msg.contains("format_version")`
- `msg.contains("unknown variant")`

That means validation policy is implicit, brittle, and spread across string contents rather than typed errors.

### Recommended validation gates

Validation should be explicit and staged. The goal is to classify each artifact as one of:

- valid and graphable;
- permanently invalid for this crate/version/source;
- temporarily unavailable because acquisition failed;
- quarantined because the graph is structurally suspicious but not clearly corrupt.

#### Gate 0: acquisition envelope

Validate the HTTP or local-file envelope before reading the whole payload.

- Resolve crate versions before fetch. Hosted batch jobs should request exact versions such as `/crate/{name}/{version}/json.gz`, not `latest` or `~4`, except for ad-hoc diagnostics.
- Record source metadata: source kind, URL or path, target triple, resolved version, HTTP status, `ETag`, `Last-Modified`, `Content-Type`, `Content-Disposition`, compressed size, raw size, SHA-256, and acquisition timestamp.
- Classify HTTP status before body parse:
  - `200`: proceed.
  - `404`, `410`, `451`: permanent `NoJsonAvailable` for that source key.
  - `408`, `429`, all `5xx`, network timeout, connection reset: transient.
  - redirects: follow a small bounded count and record the final URL.
- Require a codeview user agent with contact information, and honor `Retry-After`.

#### Gate 1: compression, truncation, size, and UTF-8

Decode with streaming limits and integrity checks.

- Support gzip and zstd. docs.rs says zstd is the default rustdoc JSON compression and `.gz` remains available ([docs.rs rustdoc JSON page](https://docs.rs/about/rustdoc-json)).
- Read to end through the decoder so gzip CRC/trailer or zstd frame-end validation actually runs.
- Enforce both compressed and decompressed byte caps. Proposed defaults:
  - compressed cap: 512 MiB;
  - decompressed cap: 2 GiB;
  - both configurable by CLI and environment.
- Reject empty or whitespace-only payloads.
- Validate UTF-8 after decompression. Invalid UTF-8 is a permanent corrupt-artifact error for a completed response, not a transient parser error.
- If the network body read itself fails before the decoder receives a complete response, classify that as transient. If a completed response fails CRC/frame validation, classify it as permanent or quarantine depending on whether a retry with conditional headers reproduces it.

#### Gate 2: shallow JSON preflight

Before deserializing to `rustdoc_types::Crate`, inspect the root shape.

Required checks:

- root JSON value is an object;
- `format_version` exists, is an unsigned integer, and fits `u32`;
- `root` exists and is an item id;
- `index`, `paths`, and `external_crates` exist and are objects;
- payload has at least one index item;
- optional metadata such as `crate_version`, `includes_private`, and `target` is recorded when present.

Format policy should be data, not scattered conditionals:

```rust
pub struct RustdocFormatPolicy {
    pub min_supported: u32,
    pub max_supported: u32,
    pub allow_newer_best_effort: bool,
    pub allow_older_compat: bool,
}
```

Recommended hosted default:

- `min_supported = 35`, because current parser comments report docs.rs artifacts observed in the v35-v57 range;
- `max_supported = rustdoc_types::FORMAT_VERSION`;
- `allow_newer_best_effort = false` for production publishing;
- `allow_older_compat = true` only for versions covered by fixtures and compatibility rewrites.

For local research commands, allow an escape hatch:

- `--allow-newer-rustdoc-json`
- `--min-rustdoc-format <u32>`
- `--max-rustdoc-format <u32>`

Any newer-than-compiled format should be a typed `UnsupportedFormatVersion { found, max_supported }` by default. The current behavior of warning and continuing can remain behind the local flag.

#### Gate 3: typed parse with typed failures

`codeview-rustdoc` should expose typed validation and parse errors instead of relying on publisher substring matching.

Proposed shape:

```rust
pub enum RustdocError {
    Io(std::io::Error),
    Utf8(std::str::Utf8Error),
    JsonSyntax(serde_json::Error),
    UnsupportedFormatVersion {
        found: u32,
        min_supported: u32,
        max_supported: u32,
    },
    JsonShape(RustdocShapeError),
    Deserialize {
        path: String,
        source: serde_json::Error,
    },
    Structural(RustdocStructuralError),
    Graph(RustdocGraphError),
    RustdocFailed(String),
    MissingRootPackage,
}

pub struct ValidatedRustdoc {
    pub krate: rustdoc_types::Crate,
    pub report: RustdocValidationReport,
}
```

Use `serde_path_to_error` for deserialization paths. Store the parser crate version and `rustdoc_types::FORMAT_VERSION` in the validation report so artifacts can be invalidated when parser compatibility changes.

#### Gate 4: structural integrity after typed parse

After deserialization, validate rustdoc-specific invariants:

- `krate.index` contains `krate.root`;
- the root item is a module-like root item;
- every local `paths` entry refers to an item present in `index`;
- local module child ids exist in `index`;
- nonzero crate ids referenced by `paths` have `external_crates` names;
- local crate name is compatible with the requested crate name after hyphen/underscore normalization;
- `crate_version`, if present for docs.rs exact-version fetches, is recorded and compared to the requested version as a warning or hard gate decided by policy.

#### Gate 5: graph semantic guard

After graph extraction:

- assert every edge endpoint exists after pruning;
- assert a crate root node exists;
- assert there is at least one local node;
- hard-fail if the graph is all external;
- quarantine or warn if local rustdoc items existed but the output graph contains only the crate node;
- record counts: raw index items, local path items, external path items, graph nodes, graph edges, external graph nodes, pruned edges.

This prevents publishing artifacts that are technically parseable but useless, such as empty graphs or all-external graphs caused by schema drift.

### Where validation should live

- `docs_rs.rs`: HTTP status classification, headers, redirects, compression selection, streaming byte caps, checksum, gzip/zstd integrity.
- `artifacts.rs`: orchestration only. It should map typed acquisition and parser errors to `Permanent`, `Transient`, or `Quarantine` without inspecting message text.
- `codeview-rustdoc`: shallow JSON preflight, format-version policy, typed deserialization, structural rustdoc validation, graph validation.
- freshness metadata: persist format version, parser validation version, `rustdoc_types` format version, source target, source URL/path, hash, raw size, and acquisition metadata.

## 2. docs.rs Sourcing Semantics

### Findings

docs.rs exposes rustdoc JSON under:

- `https://docs.rs/crate/{name}/{version}/json`
- `https://docs.rs/crate/{name}/{version}/json.gz`
- `https://docs.rs/crate/{name}/{version}/{target}/json`
- `https://docs.rs/crate/{name}/{version}/json/{format_version}`

The docs.rs page says zstd is the default compression and `.gz` requests gzip ([docs.rs rustdoc JSON page](https://docs.rs/about/rustdoc-json)). It also documents `latest`, exact version, semver selectors, target-specific JSON, and requested format-version URLs.

docs.rs builds crates published to crates.io in a sandbox with nightly rustc. The current build page reports nightly rustc, target cross-compilation for non-default targets, and build limits including memory and rustdoc execution time ([docs.rs build limits](https://docs.rs/about/builds)). Per-target build behavior is controlled by package metadata such as `default-target` and `targets`; docs.rs lists default targets including `x86_64-unknown-linux-gnu`, `aarch64-apple-darwin`, `x86_64-pc-windows-msvc`, `aarch64-unknown-linux-gnu`, and `i686-pc-windows-msvc` ([docs.rs metadata](https://docs.rs/about/metadata)).

docs.rs URL resolution uses semver-like redirects. `docs.rs/clap`, `latest`, `newest`, `*`, `~2`, and exact versions are documented as accepted forms ([docs.rs redirections](https://docs.rs/about/redirections)).

Empirical probes on 2026-07-04:

- `HEAD https://docs.rs/crate/clap/latest/json.gz` returned `200`, `Content-Type: application/gzip`, and a `Content-Disposition` filename containing `clap_4.6.1_x86_64-unknown-linux-gnu_latest.json.gz`.
- `HEAD https://docs.rs/crate/clap/~4/json.gz` returned `302` to `/crate/clap/4.6.1/json.gz`.
- `HEAD https://docs.rs/crate/clap/latest/i686-pc-windows-msvc/json.gz` returned `200`.
- `HEAD https://docs.rs/crate/clap/latest/json/57` returned `200` with zstd content.
- `HEAD https://docs.rs/crate/clap/latest/json/999` returned `404`.
- nonexistent crates, build-failed crate versions, and exact versions without JSON all returned `404`.
- No `Vary` or schema-version response header was observed. The authoritative format signal is the JSON `format_version` field, plus any requested format-version URL.

Yanked crate versions are not deleted from crates.io; yanking prevents new dependency resolution but does not remove the crate data ([Cargo yank docs](https://doc.rust-lang.org/cargo/commands/cargo-yank.html)). Therefore docs.rs JSON for an already-built yanked version may still exist, but the scheduler should normally skip yanked versions unless explicitly asked.

### Recommended docs.rs acquisition design

- Scheduler resolves the exact newest non-yanked version before calling docs.rs.
- Fetch default target first unless product requirements call for target-specific graphs.
- Use `HEAD` to cheaply detect no JSON:
  - `200`: enqueue GET;
  - `404`: mark `NoJsonAvailable` for `(crate, version, target, requested_format)`;
  - `429` or `5xx`: retry later.
- Store `ETag` and `Last-Modified` for conditional refetch and provenance.
- Add zstd support. Prefer zstd when requesting `/json` or `.json.zst`; keep `.json.gz` fallback for compatibility.
- Do not trust URL selectors as validation. Always read the body `format_version`.
- Treat docs.rs format-version URLs as an optimization only. If requesting `/json/{format}` returns `404`, fall back to the default JSON and validate locally.
- Rate-limit per host with low concurrency, for example 2-4 concurrent docs.rs requests, exponential backoff, and `Retry-After` support. I did not find a docs.rs rustdoc-JSON-specific published rate limit; this should be treated as a politeness policy.

## 3. std, core, alloc, proc_macro, and test Across Channels

### Findings

The rustdoc unstable-features page documents the `rust-docs-json` rustup component and shows the files under `share/doc/rust/json/`, with a nightly example ([rustdoc unstable features](https://doc.rust-lang.org/beta/rustdoc/unstable-features.html)). rustup documentation explains that stable, beta, and nightly are distinct channels, that exact toolchain versions and nightly dates can be installed, and that components can be unavailable on some toolchains ([rustup channels](https://rust-lang.github.io/rustup/concepts/channels.html), [rustup components](https://rust-lang.github.io/rustup/concepts/components.html)).

Distribution manifest checks on 2026-07-04:

- stable manifest date `2026-06-30`: `rust-docs-json-preview` package metadata exists, but `x86_64-unknown-linux-gnu` is `available = false`;
- beta manifest date `2026-07-02`: package metadata exists, but `x86_64-unknown-linux-gnu` is `available = false`;
- nightly manifest date `2026-07-04`: `rust-docs-json` is available for `x86_64-unknown-linux-gnu` and points to a nightly tarball.

So the current source comment that `rust-docs-json` is nightly-only is practically correct for rustup-installed components today. What is not correct for product semantics is aliasing nightly artifacts as stable and beta.

The rustc dev guide says rustdoc and the standard library are built from the Rust repository, and `./x doc library` generates standard-library docs under the build directory ([rustc dev guide rustdoc chapter](https://rustc-dev-guide.rust-lang.org/rustdoc.html)). The standard library docs are hosted on `doc.rust-lang.org`, not docs.rs. docs.rs builds crates with its current nightly rustdoc; it is not the source for std/core/alloc/proc_macro/test JSON.

### Recommended per-channel std design

Model std acquisition as first-class channel artifacts, not aliases.

```rust
pub enum StdChannel {
    Stable,
    Beta,
    Nightly,
    NightlyDate(String),
    Version(String),
}

pub enum StdJsonAcquisition {
    RustupComponent {
        toolchain: String,
        host_triple: String,
        sysroot: PathBuf,
        rustc_version: String,
        manifest_date: Option<String>,
    },
    RustSourceBuild {
        channel: StdChannel,
        rust_version: String,
        git_commit_hash: String,
        source_url: String,
        source_sha256: String,
        output_dir: PathBuf,
    },
}
```

Acquisition policy:

- Nightly: use the rustup `rust-docs-json` component when available.
- Stable and beta: do not alias to nightly. Use one of:
  - source build from the exact Rust release source or commit for that channel;
  - a future rustup component if manifests mark it available.
- Pin exact versions:
  - stable by release version, for example `1.x.y`;
  - beta by beta version and manifest date;
  - nightly by `nightly-YYYY-MM-DD`, not moving `nightly`, for reproducibility.
- Store artifacts under versioned keys and then update aliases:
  - `rust/std/1.x.y/...`
  - `rust/std/beta-YYYY-MM-DD/...`
  - `rust/std/nightly-YYYY-MM-DD/...`
  - alias `stable` to the real stable artifact;
  - alias `beta` to the real beta artifact;
  - alias `nightly` to the pinned nightly artifact.
- The `latest` alias needs an architect decision. My recommendation is that `latest` for std means latest stable, because users normally expect stable standard-library docs unless they ask for beta or nightly.

CLI changes:

```text
codeview-cli cron seed-std \
  --channels stable,beta,nightly \
  --std-source auto|rustup|source-build \
  --toolchain stable|beta|nightly-YYYY-MM-DD|1.x.y \
  --host-triple x86_64-unknown-linux-gnu \
  --manifest-date YYYY-MM-DD \
  --no-channel-alias-fallback
```

Implementation note to verify: the exact source-build command for JSON output should be proven in CI against the Rust repository. The rustc dev guide confirms `./x doc library` for std docs, but this research did not run the Rust source build or verify the precise JSON flag wiring.

## 4. crates.io Bulk Metadata at Scale

### Sparse index

The Cargo registry index has one file per package and one JSON object per version. Records include `name`, `vers`, dependencies, checksum, `features`, `yanked`, schema version, `rust_version`, and `pubtime` ([Cargo registry index reference](https://doc.rust-lang.org/cargo/reference/registry-index.html)). The sparse protocol fetches those files over HTTP from `index.crates.io`, supports conditional requests with `ETag` and `Last-Modified`, and returns `404`, `410`, or `451` for missing or unavailable crates.

The sparse index is good for:

- resolving a small or medium watchlist without calling the crates.io API;
- checking whether selected crates have newly published versions since the last sweep;
- getting exact version lists and yanked flags with CDN-friendly conditional GETs.

It is not ideal for ranking all crates by downloads, because index files do not contain crate download totals.

### Daily database dump

The crates.io database dump is published at `https://static.crates.io/db-dump.tar.gz`, updated every 24 hours, and contains the data exposed by the crates.io API in bulk ([db-dump README](https://github.com/dtolnay/db-dump)). The `db-dump` crate documents tables including `crates.csv`, `versions.csv`, `default_versions.csv`, `crate_downloads.csv`, and `version_downloads.csv` ([db-dump crate docs](https://docs.rs/db-dump)).

The dump is large. A HEAD request on 2026-07-04 showed:

- final CDN URL under `cloudfront-static.crates.io`;
- `Content-Type: application/gzip`;
- `Content-Length: 1534390104`;
- `Last-Modified: Sat, 04 Jul 2026 02:07:02 GMT`.

The dump is the right source for global scheduling because it provides ranking inputs and all version rows in one CDN download.

### API policy

The crates.io API should not be used for one request per crate in sweep jobs. The official ecosystem guidance requires a user agent and conservative rate limiting; the `crates_io_api` crate documents the crawler-policy requirement and uses a one-second default interval ([crates_io_api docs](https://docs.rs/crates_io_api/latest/crates_io_api/)). Use the API for ad-hoc diagnostics only, not bulk scheduling.

### Recommended sweep metadata plan

Primary path:

1. Download or reuse the daily db dump using `ETag` / `Last-Modified`.
2. Stream the relevant CSVs rather than extracting the whole archive to random-access files.
3. Build a compact scheduling snapshot:

```rust
pub struct CrateCatalogSnapshot {
    pub generated_at: String,
    pub source: CrateCatalogSource,
    pub crates: Vec<CrateCandidate>,
}

pub struct CrateCandidate {
    pub name: String,
    pub newest_non_yanked: Option<String>,
    pub newest_pubtime: Option<String>,
    pub all_time_downloads: u64,
    pub recent_downloads: Option<u64>,
    pub all_time_rank: Option<u32>,
    pub recent_rank: Option<u32>,
}
```

4. For each crate, choose the newest non-yanked version from `versions.csv`.
5. For ranking, use `crates.csv.downloads` for parity with the current `sort=downloads` API behavior. Optionally compute recent ranks from `crate_downloads.csv` or `version_downloads.csv`.
6. Persist the compact snapshot to R2/local state and let `cron sweep` read that snapshot instead of calling `/api/v1/crates/{name}` per crate.

Sparse overlay:

- For watchlists or crates selected from a slightly stale dump, optionally fetch sparse index files with HTTP/2 and conditional GET.
- Use the sparse rows to update newest non-yanked version and yanked state.
- Do not use sparse index for download ranking.

CLI changes:

```text
codeview-cli cron sweep \
  --metadata-source db-dump|sparse|api \
  --db-dump-url https://static.crates.io/db-dump.tar.gz \
  --db-dump-path <cache-path> \
  --rank all-time|recent-90d|recent-30d \
  --include-prerelease \
  --sparse-overlay \
  --metadata-max-age-hours 30
```

Default should be `--metadata-source db-dump --rank all-time --sparse-overlay`.

## Recommended End-to-End Design

### Acquisition

- Resolve crate candidates from a bulk metadata snapshot.
- Fetch docs.rs JSON by exact crate version and target.
- Use HEAD before GET for no-JSON detection.
- Support gzip and zstd.
- Record complete source provenance and content hashes.
- Treat docs.rs `404` as `NoJsonAvailable`, not parser failure.

### Validation

- Move validation into a `codeview-rustdoc::validate` path that returns typed reports.
- Gate `format_version` before typed parse.
- Use explicit compatibility policy with fixture-backed supported ranges.
- Convert parser and validation failures to typed permanent/transient/quarantine outcomes.
- Add graph quality guards before publishing artifacts.

### std artifacts

- Remove stable/beta aliasing to nightly as the default path.
- Seed nightly from rustup component.
- Seed stable and beta from exact Rust source builds until rustup components are available.
- Store versioned artifacts and update channel aliases only to artifacts from that channel.

### bulk scheduling

- Replace per-crate API newest-version lookups with a compact snapshot derived from the crates.io db dump.
- Use sparse-index conditional GETs only as a freshness overlay or watchlist source.
- Keep API calls out of steady-state sweep jobs.

## Open Questions for the Architect

- What exact `format_version` range should production accept: current-only, `35..=current`, or a smaller fixture-backed historical range?
- Should newer-than-compiled rustdoc JSON ever be published in hosted mode, or only accepted for local diagnostics?
- What are the real compressed and decompressed size caps after measuring std plus the largest docs.rs crates?
- Should graph-quality failures be hard failures, or should suspicious artifacts be quarantined for manual review?
- For std, should the `latest` alias mean latest stable or latest nightly?
- Should sweep treat prerelease crate versions as candidates for "newest non-yanked"?
- Which docs.rs targets are product requirements: default target only, configured docs.rs targets, or a fixed target matrix?
- Is a daily 1.5+ GiB crates.io dump download acceptable in the intended runner, or should one shared metadata job publish a compact snapshot for all sweep jobs?
- Who owns the stable/beta Rust source-build cache and runtime cost?
- Is adding zstd and `serde_path_to_error` to the CLI/parser dependency set acceptable?
