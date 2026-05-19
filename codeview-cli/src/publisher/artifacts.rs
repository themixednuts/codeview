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

use std::sync::Arc;

use anyhow::{Context, Result};
use sha2::{Digest as _, Sha256};

use super::docs_rs;
use super::freshness::{FreshnessEntry, FreshnessRegistry, Source};
use super::r2::R2;
use super::shards;

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
}

impl PublishError {
    /// Exit code matching the GHA matrix-script contract:
    /// 0 ok, 64 transient, 65 permanent, 70 internal.
    pub fn exit_code(&self) -> i32 {
        match self {
            PublishError::Transient(_) => 64,
            PublishError::Permanent(_) => 65,
        }
    }
}

pub struct PublishOptions<'a> {
    pub name: &'a str,
    pub version: &'a str,
    pub storage_name: &'a str,
    pub r2: Arc<dyn R2>,
    pub freshness: &'a FreshnessRegistry,
    pub parser_revision: &'a str,
    pub schema_version: u32,
    /// Skip the idempotency check.  Set when the user passes `--force`.
    pub force: bool,
    /// Optional docs.rs target override (e.g. `x86_64-unknown-linux-gnu`).
    pub docsrs_target: Option<&'a str>,
    /// Aliases to write alongside the version (`latest`, `stable`, …).
    pub aliases: &'a [&'a str],
}

pub async fn publish_one(opts: PublishOptions<'_>) -> Result<Outcome, PublishError> {
    let PublishOptions {
        name,
        version,
        storage_name,
        r2,
        freshness,
        parser_revision,
        schema_version,
        force,
        docsrs_target,
        aliases,
    } = opts;

    // ─── 1. Freshness check ──────────────────────────────────────
    if !force {
        let staleness = freshness
            .check(name, version, parser_revision, schema_version)
            .await
            .map_err(PublishError::Transient)?;
        if !staleness.is_stale() {
            return Ok(Outcome::AlreadyFresh);
        }
        eprintln!("[parse-one] stale: {}", staleness.describe());
    } else {
        eprintln!("[parse-one] force: skipping freshness check");
    }

    // ─── 2. Fetch rustdoc JSON ───────────────────────────────────
    let http = docs_rs::http_client().map_err(PublishError::Transient)?;
    let download = match docs_rs::fetch_rustdoc_json(&http, name, version, docsrs_target).await {
        Ok(d) => d,
        Err(docs_rs::DocsRsError::Permanent { status, url }) => {
            return Err(PublishError::Permanent(format!(
                "docs.rs {url} returned {status}"
            )));
        }
        Err(docs_rs::DocsRsError::MalformedGzip(e)) => {
            return Err(PublishError::Permanent(format!("docs.rs gzip: {e:#}")));
        }
        Err(docs_rs::DocsRsError::Transient(e)) => return Err(PublishError::Transient(e)),
    };
    eprintln!(
        "[parse-one] docs.rs JSON: {:.2} MB gz → {:.2} MB raw",
        download.compressed_bytes as f64 / 1024.0 / 1024.0,
        download.json.len() as f64 / 1024.0 / 1024.0,
    );

    // ─── 3. Parse via codeview-rustdoc ───────────────────────────
    let rustdoc_hash = hex::encode(Sha256::digest(&download.json));
    eprintln!("[parse-one] rustdoc input hash: {}", &rustdoc_hash[..12]);

    let json_str = std::str::from_utf8(&download.json)
        .context("rustdoc JSON not UTF-8")
        .map_err(PublishError::Transient)?;
    let graph = codeview_rustdoc::extract_graph(json_str, name).map_err(|err| {
        // Parser errors are typed; "unsupported rustdoc" / "unknown variant"
        // are permanent — won't change until parser revision bumps. Other
        // failures may be transient (memory pressure, etc.).
        let msg = err.to_string();
        if msg.contains("unsupported rustdoc")
            || msg.contains("format_version")
            || msg.contains("unknown variant")
        {
            PublishError::Permanent(format!("parser rejected: {msg}"))
        } else {
            PublishError::Transient(anyhow::anyhow!("parser internal: {msg}"))
        }
    })?;

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
    if !force {
        if let Some(existing) = freshness
            .latest(name)
            .await
            .map_err(PublishError::Transient)?
            && existing.graph_hash == graph_hash
            && existing.version == version
        {
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
    let artifacts = shards::build_all(&crate_graph, storage_name, aliases)
        .map_err(|e| PublishError::Permanent(format!("artifact build: {e:#}")))?;
    eprintln!("[parse-one] artifacts: {}", artifacts.len());

    // ─── 6. Upload to R2 ─────────────────────────────────────────
    let total = artifacts.len();
    let r2_for_upload = r2.clone();
    for (i, art) in artifacts.into_iter().enumerate() {
        if i % 25 == 0 || i == total - 1 {
            eprint!(".");
        }
        r2_for_upload
            .put(&art.key, art.body, art.content_type)
            .await
            .with_context(|| format!("upload {}", art.key))
            .map_err(PublishError::Transient)?;
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
        source: Source::DocsRs,
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

/// crates.io and Rust both prefer hyphenated display names but the
/// parser canonicalises to underscores. This matches `normalizeCrateName`
/// / `hyphenateCrateName` in the deleted TS code.
pub fn normalise_crate_name(s: &str) -> String {
    s.replace('-', "_").to_lowercase()
}
pub fn hyphenate_crate_name(s: &str) -> String {
    s.replace('_', "-").to_lowercase()
}
