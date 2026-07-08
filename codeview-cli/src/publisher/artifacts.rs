//! End-to-end publish of one crate.
//!
//! `publish_one(name, version, ...)` is the unit of work invoked by
//! `cron parse-one`.  Pipeline:
//!
//! 1. Idempotency check against the freshness registry. Skip if fresh.
//! 2. Fetch rustdoc JSON from docs.rs.
//! 3. Parse via `codeview-rustdoc::extract_graph`.
//! 4. Hash the input + output.  Skip R2 upload if the graph is
//!    byte-identical to what's already there (parser bumped but output
//!    didn't change).
//! 5. Build all static artifacts via `shards::build_all`.
//! 6. Upload to R2.
//! 7. Record freshness entry.
//!
//! Errors classify into transient / permanent so the cron caller picks
//! the right retry strategy.

use std::io::Cursor;
use std::sync::Arc;

use anyhow::{Context, Result};
use codeview_rustdoc::{RustdocError, RustdocFormatPolicy};
use flate2::read::GzDecoder;
use futures::StreamExt;
use sha2::{Digest as _, Sha256};
use tar::Archive;

use super::freshness::{FreshnessEntry, FreshnessRegistry, Source};
use super::r2::R2;
use super::shards;
use super::{docs_rs, hosted_artifacts};

const CRATES_IO_CRATE_CAP_BYTES: u64 = 512 * 1024 * 1024;

/// Outcome of `publish_one` — distinguishes a no-op skip from real work
/// so the CLI logs read cleanly.
#[derive(Debug)]
pub enum Outcome {
    /// Freshness check said nothing needed doing.
    AlreadyFresh,
    /// We parsed but the graph hash matched the previous entry; only
    /// the freshness record was refreshed.
    ParserBumpedSameOutput,
    /// Full re-publish — new artifacts in R2, new freshness entry.
    Published { nodes: usize, edges: usize },
}

#[derive(Debug, thiserror::Error)]
pub enum PublishError {
    #[error("transient: {0:#}")]
    Transient(#[from] anyhow::Error),
    #[error("permanent: {0}")]
    Permanent(String),
    #[error("quarantine: {0}")]
    Quarantine(String),
}

impl PublishError {
    /// Exit code matching the GHA matrix-script contract:
    /// 0 ok, 64 transient, 65 permanent, 70 internal.
    pub fn exit_code(&self) -> i32 {
        match self {
            PublishError::Transient(_) => 64,
            PublishError::Permanent(_) | PublishError::Quarantine(_) => 65,
        }
    }
}

pub struct PublishOptions<'a> {
    /// Original package name used by registries/docs.rs, e.g. `windows-sys`.
    pub package_name: &'a str,
    /// Canonical Rust crate id used by rustdoc and internal graph ids, e.g. `windows_sys`.
    pub name: &'a str,
    pub version: &'a str,
    pub storage_name: &'a str,
    pub r2: Arc<dyn R2>,
    pub freshness: &'a FreshnessRegistry,
    pub parser_revision: &'a str,
    pub schema_version: u32,
    /// Skip the idempotency check.  Set when the user passes `--force`.
    pub force: bool,
    /// Where to obtain the rustdoc JSON.  Defaults to docs.rs.
    pub source: CrateSource<'a>,
    /// Aliases to write alongside the version (`latest`, `stable`, …).
    pub aliases: &'a [&'a str],
}

/// Where `publish_one` should obtain the raw rustdoc JSON.
///
/// `DocsRs` — the production path: gzipped fetch from docs.rs, identified
/// by `(name, version)`.  `LocalFile` — the std-seed path: read straight
/// from `share/doc/rust/json/{crate}.json` in a rustup-installed
/// `rust-docs-json` toolchain (docs.rs doesn't host std).
pub enum CrateSource<'a> {
    DocsRs {
        /// Optional target triple override.
        target: Option<&'a str>,
    },
    LocalFile {
        path: &'a std::path::Path,
        /// What gets recorded in the freshness entry — `Source::Sysroot`
        /// for std crates, `Source::Cargo` for cargo-resolved local
        /// dependencies.
        freshness_source: Source,
    },
}

impl Default for CrateSource<'_> {
    fn default() -> Self {
        CrateSource::DocsRs { target: None }
    }
}

pub async fn publish_one(opts: PublishOptions<'_>) -> Result<Outcome, PublishError> {
    let PublishOptions {
        package_name,
        name,
        version,
        storage_name,
        r2,
        freshness,
        parser_revision,
        schema_version,
        force,
        source,
        aliases,
    } = opts;

    // ─── 1. Freshness check ──────────────────────────────────────
    if !force {
        let staleness = freshness
            .check(name, version, parser_revision, schema_version)
            .await
            .map_err(PublishError::Transient)?;
        if !staleness.is_stale() {
            if hosted_artifacts_exist(&r2, storage_name, version)
                .await
                .map_err(PublishError::Transient)?
            {
                return Ok(Outcome::AlreadyFresh);
            }
            eprintln!("[parse-one] stale: hosted artifacts missing");
        } else {
            eprintln!("[parse-one] stale: {}", staleness.describe());
        }
    } else {
        eprintln!("[parse-one] force: skipping freshness check");
    }

    // ─── 2. Load rustdoc JSON ────────────────────────────────────
    let (json_bytes, recorded_source) = match source {
        CrateSource::DocsRs {
            target: docsrs_target,
        } => {
            let http = docs_rs::http_client().map_err(PublishError::Transient)?;
            match docs_rs::fetch_rustdoc_json(&http, package_name, version, docsrs_target).await {
                Ok(download) => {
                    eprintln!(
                        "[parse-one] docs.rs JSON: {:.2} MB {} → {:.2} MB raw",
                        download.compressed_bytes as f64 / 1024.0 / 1024.0,
                        download.encoding,
                        download.json.len() as f64 / 1024.0 / 1024.0,
                    );
                    (download.json, Source::DocsRs)
                }
                Err(docs_rs::DocsRsError::Permanent { status, url })
                    if docsrs_target.is_none() && matches!(status, 404 | 410) =>
                {
                    eprintln!(
                        "[parse-one] docs.rs JSON unavailable ({status} {url}); building docs.rs-style rustdoc JSON from crates.io source"
                    );
                    let json =
                        build_rustdoc_json_from_crates_io_source(&http, package_name, version)
                            .await?;
                    eprintln!(
                        "[parse-one] crates.io rustdoc JSON: {:.2} MB raw",
                        json.len() as f64 / 1024.0 / 1024.0,
                    );
                    (json, Source::Cargo)
                }
                Err(docs_rs::DocsRsError::Permanent { status, url }) => {
                    return Err(PublishError::Permanent(format!(
                        "docs.rs {url} returned {status}"
                    )));
                }
                Err(docs_rs::DocsRsError::Corrupt(e)) => {
                    return Err(PublishError::Permanent(format!("docs.rs artifact: {e:#}")));
                }
                Err(docs_rs::DocsRsError::Transient(e)) => {
                    return Err(PublishError::Transient(e));
                }
            }
        }
        CrateSource::LocalFile {
            path,
            freshness_source,
        } => {
            let bytes = std::fs::read(path)
                .with_context(|| format!("read rustdoc JSON from {}", path.display()))
                .map_err(PublishError::Transient)?;
            eprintln!(
                "[parse-one] local JSON: {} ({:.2} MB)",
                path.display(),
                bytes.len() as f64 / 1024.0 / 1024.0,
            );
            (bytes, freshness_source)
        }
    };

    // ─── 3. Parse via codeview-rustdoc ───────────────────────────
    let rustdoc_hash = hex::encode(Sha256::digest(&json_bytes));
    eprintln!("[parse-one] rustdoc input hash: {}", &rustdoc_hash[..12]);

    let json_str = std::str::from_utf8(&json_bytes)
        .context("rustdoc JSON not UTF-8")
        .map_err(|e| PublishError::Permanent(format!("rustdoc JSON not UTF-8: {e}")))?;
    let (graph, validation) =
        codeview_rustdoc::extract_graph_validated(json_str, name, &RustdocFormatPolicy::strict())
            .map_err(classify_rustdoc_error)?;
    eprintln!(
        "[parse-one] rustdoc validation: format={} parser_format={} raw_items={} local_paths={} external_paths={} pruned_edges={}",
        validation.source_format_version,
        validation.parser_format_version,
        validation.raw_items,
        validation.local_path_items,
        validation.external_path_items,
        validation.pruned_edges,
    );
    for warning in &validation.warnings {
        eprintln!("[parse-one] rustdoc warning: {warning}");
    }
    if let Some(reason) = validation.quarantine_reason {
        return Err(PublishError::Quarantine(format!(
            "{name}@{version}: {reason}"
        )));
    }

    // Convert internal Graph → CrateGraph for the static-artifact builders.
    let crate_graph = codeview_core::CrateGraph {
        id: graph
            .nodes
            .iter()
            .find(|n| n.kind == codeview_core::NodeKind::Crate)
            .map(|n| n.id.clone())
            .unwrap_or_else(|| name.to_string()),
        name: name.to_string(),
        version: version.to_string(),
        nodes: graph.nodes,
        edges: graph.edges,
        aliases: graph.aliases,
    };

    let graph_hash = shards::graph_hash(&crate_graph);
    eprintln!(
        "[parse-one] graph: nodes={} edges={} hash={}",
        crate_graph.nodes.len(),
        crate_graph.edges.len(),
        &graph_hash[..12],
    );

    // ─── 4. Idempotent skip if same output ───────────────────────
    if !force
        && let Some(existing) = freshness
            .latest(name)
            .await
            .map_err(PublishError::Transient)?
        && existing.graph_hash == graph_hash
        && existing.version == version
    {
        if !hosted_artifacts_exist(&r2, storage_name, version)
            .await
            .map_err(PublishError::Transient)?
        {
            eprintln!(
                "[parse-one] graph unchanged but hosted artifacts missing; rebuilding artifacts"
            );
        } else {
            eprintln!("[parse-one] graph unchanged — refreshing registry only");
            let refreshed = FreshnessEntry {
                parsed_at: chrono::Utc::now().to_rfc3339(),
                parser_revision: parser_revision.to_string(),
                schema_version,
                rustdoc_hash: Some(rustdoc_hash),
                ..existing
            };
            freshness
                .record(&refreshed)
                .await
                .map_err(PublishError::Transient)?;
            return Ok(Outcome::ParserBumpedSameOutput);
        }
    }

    // ─── 5. Build artifacts ──────────────────────────────────────
    let mut artifacts = shards::build_all(&crate_graph, storage_name, aliases)
        .map_err(|e| PublishError::Permanent(format!("artifact build: {e:#}")))?;
    let hosted_set = hosted_artifacts::build_all(&crate_graph, storage_name)
        .map_err(|e| PublishError::Permanent(format!("hosted artifact build: {e:#}")))?;
    eprintln!(
        "[parse-one] hosted artifacts: entries={} buckets={} bytes={} largest={} id={}",
        hosted_set.report.node_view_entries,
        hosted_set.report.node_view_bucket_count,
        hosted_set.report.artifact_total_raw_bytes,
        hosted_set.report.node_view_largest_entry_raw_bytes,
        hosted_set
            .report
            .node_view_largest_entry_id
            .as_deref()
            .unwrap_or("-"),
    );
    artifacts.extend(hosted_set.artifacts);
    eprintln!("[parse-one] artifacts: {}", artifacts.len());

    // ─── 6. Upload to R2 ─────────────────────────────────────────
    //
    // Concurrency is per-backend: S3Backend = 8 (Cloudflare R2 fans out
    // fine), LocalMiniflareBackend = 1 (wrangler subprocess contention
    // on miniflare's SQLite locks).  Trait default is 8.
    use futures::stream::StreamExt;
    let concurrency = r2.concurrency_hint().max(1);
    let total = artifacts.len();
    let r2_for_upload = r2.clone();
    let mut completed = 0usize;
    let mut stream = futures::stream::iter(artifacts.into_iter().map(|art| {
        let r2 = r2_for_upload.clone();
        async move {
            r2.put(&art.key, art.body, art.content_type)
                .await
                .with_context(|| format!("upload {}", art.key))
        }
    }))
    .buffer_unordered(concurrency);
    while let Some(result) = stream.next().await {
        result.map_err(PublishError::Transient)?;
        completed += 1;
        if completed % 25 == 0 || completed == total {
            eprint!(".");
        }
    }
    eprintln!();

    // ─── 7. Record freshness ─────────────────────────────────────
    let entry = FreshnessEntry {
        name: name.to_string(),
        storage_name: if storage_name != name {
            Some(storage_name.to_string())
        } else {
            None
        },
        version: version.to_string(),
        parsed_at: chrono::Utc::now().to_rfc3339(),
        source: recorded_source,
        parser_revision: parser_revision.to_string(),
        schema_version,
        graph_hash,
        rustdoc_hash: Some(rustdoc_hash),
        nodes: crate_graph.nodes.len(),
        edges: crate_graph.edges.len(),
    };
    freshness
        .record(&entry)
        .await
        .map_err(PublishError::Transient)?;

    Ok(Outcome::Published {
        nodes: crate_graph.nodes.len(),
        edges: crate_graph.edges.len(),
    })
}

async fn build_rustdoc_json_from_crates_io_source(
    client: &reqwest::Client,
    package_name: &str,
    version: &str,
) -> Result<Vec<u8>, PublishError> {
    let crate_url = format!(
        "https://crates.io/api/v1/crates/{}/{}/download",
        urlencoding::encode(package_name),
        urlencoding::encode(version)
    );
    let resp =
        client.get(&crate_url).send().await.map_err(|e| {
            PublishError::Transient(anyhow::Error::new(e).context("download crate"))
        })?;
    let status = resp.status();
    if !status.is_success() {
        if status.as_u16() == 408 || status.as_u16() == 429 || status.is_server_error() {
            return Err(PublishError::Transient(anyhow::anyhow!(
                "crates.io {crate_url}: {status}"
            )));
        }
        return Err(PublishError::Permanent(format!(
            "crates.io {crate_url} returned {status}"
        )));
    }
    if let Some(content_length) = resp.content_length()
        && content_length > CRATES_IO_CRATE_CAP_BYTES
    {
        return Err(PublishError::Permanent(format!(
            "crates.io crate archive for {package_name}@{version} is {content_length} bytes, above cap {CRATES_IO_CRATE_CAP_BYTES}"
        )));
    }

    let archive_bytes = read_response_with_cap(resp, CRATES_IO_CRATE_CAP_BYTES)
        .await
        .map_err(PublishError::Transient)?;
    let temp = tempfile::Builder::new()
        .prefix("codeview-crate-")
        .tempdir()
        .map_err(|e| PublishError::Transient(anyhow::Error::new(e).context("create tempdir")))?;

    let gzip = GzDecoder::new(Cursor::new(archive_bytes));
    let mut archive = Archive::new(gzip);
    archive
        .unpack(temp.path())
        .map_err(|e| PublishError::Permanent(format!("unpack crates.io archive: {e}")))?;

    let crate_dir = find_unpacked_crate_dir(temp.path()).ok_or_else(|| {
        PublishError::Permanent("crates.io archive did not contain Cargo.toml".into())
    })?;
    let manifest_path = crate_dir.join("Cargo.toml");
    let rustdoc = codeview_rustdoc::generate_docs_rs_rustdoc_json(&manifest_path)
        .map_err(classify_rustdoc_error)?;
    std::fs::read(&rustdoc.json_path).map_err(|e| {
        PublishError::Transient(
            anyhow::Error::new(e).context(format!("read {}", rustdoc.json_path.display())),
        )
    })
}

async fn read_response_with_cap(
    resp: reqwest::Response,
    cap_bytes: u64,
) -> Result<Vec<u8>, anyhow::Error> {
    let cap = usize::try_from(cap_bytes).unwrap_or(usize::MAX);
    let mut body = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("read response body")?;
        if body.len().saturating_add(chunk.len()) > cap {
            anyhow::bail!("response body exceeded cap {cap_bytes}");
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn find_unpacked_crate_dir(root: &std::path::Path) -> Option<std::path::PathBuf> {
    let expected = std::fs::read_dir(root).ok()?.flatten().find_map(|entry| {
        let path = entry.path();
        if path.join("Cargo.toml").is_file() {
            Some(path)
        } else {
            None
        }
    });
    expected.or_else(|| {
        if root.join("Cargo.toml").is_file() {
            Some(root.to_path_buf())
        } else {
            None
        }
    })
}

async fn hosted_artifacts_exist(
    r2: &Arc<dyn R2>,
    storage_name: &str,
    version: &str,
) -> anyhow::Result<bool> {
    Ok(r2
        .get(&hosted_artifacts::meta_key(storage_name, version))
        .await?
        .is_some())
}

/// crates.io and Rust both prefer hyphenated display names but the
/// parser canonicalises to underscores. This matches `normalizeCrateName`
/// / `hyphenateCrateName` in the deleted TS code.
pub fn normalise_crate_name(s: &str) -> String {
    s.replace('-', "_").to_lowercase()
}
pub fn hyphenate_crate_name(s: &str) -> String {
    s.replace('_', "-").to_lowercase()
}

fn classify_rustdoc_error(err: RustdocError) -> PublishError {
    let msg = err.to_string();
    match err {
        RustdocError::Json(_)
        | RustdocError::JsonSyntax(_)
        | RustdocError::UnsupportedFormatVersion { .. }
        | RustdocError::ShallowShape(_)
        | RustdocError::Deserialize { .. }
        | RustdocError::Structural(_)
        | RustdocError::Graph(_) => PublishError::Permanent(format!("parser rejected: {msg}")),
        RustdocError::Io(e) => PublishError::Transient(anyhow::Error::new(e).context("parser io")),
        RustdocError::Metadata(e) => {
            PublishError::Transient(anyhow::Error::new(e).context("parser cargo metadata"))
        }
        RustdocError::Syn(e) => {
            PublishError::Transient(anyhow::Error::new(e).context("parser source parse"))
        }
        RustdocError::RustdocFailed(status) => {
            PublishError::Transient(anyhow::anyhow!("cargo rustdoc failed with status {status}"))
        }
        RustdocError::MissingRootPackage => {
            PublishError::Transient(anyhow::anyhow!("parser missing root package"))
        }
    }
}
