//! `codeview cron sweep` — produce the matrix of stale `(name, version)`
//! pairs that the parse job should process.
//!
//! Inputs:
//!   - `STATIC_R2_TARGET` — local | remote
//!   - `--watchlist`     — `catalog` (default), `top:N`, or path to a
//!                          file with one crate name per line
//!   - `--max-crates`    — cap on emitted matrix size
//!   - `--force`         — comma-separated names that bypass the
//!                          freshness check
//!
//! Outputs:
//!   - `stdout` (or `$MATRIX_OUT` file) → JSON `{ include: [{name, version, reason}…] }`
//!   - `$GITHUB_OUTPUT` (if set) → `matrix=...\ncount=N`
//!
//! Pure-ish: reads R2 + crates.io, writes nothing back to R2.  Catalog
//! and freshness mutations belong to `parse-one` and `catalog` so the
//! sweep is replayable.

use std::collections::HashSet;
use std::fs;
use std::io::Write;

use anyhow::{Context, Result};
use clap::Args;
use serde::{Deserialize, Serialize};

use crate::publisher::crates_io::{self, CrateInfo};
use crate::publisher::docs_rs;
use crate::publisher::freshness::FreshnessRegistry;
use crate::publisher::r2::{self, Target, build_backend, read_json};

use super::parser_revision;

#[derive(Debug, Args)]
pub struct Sweep {
    /// Watchlist source: `catalog`, `top:N`, or a path to a file listing crate names.
    #[arg(long, default_value = "catalog")]
    pub watchlist: String,

    /// Maximum matrix entries emitted.
    #[arg(long, default_value_t = 50)]
    pub max_crates: usize,

    /// Comma-separated names to include regardless of freshness.
    #[arg(long, default_value = "")]
    pub force: String,

    /// R2 bucket (default: `crate-graphs`).
    #[arg(long, default_value = "crate-graphs")]
    pub bucket: String,

    /// Suppress human-readable logs (matrix JSON still goes to stdout).
    #[arg(long)]
    pub quiet: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatrixEntry {
    pub name: String,
    pub version: String,
    pub reason: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct Matrix {
    include: Vec<MatrixEntry>,
}

#[derive(Debug, Deserialize)]
struct CatalogFile {
    crates: Vec<CatalogCrate>,
}

#[derive(Debug, Deserialize)]
struct CatalogCrate {
    name: String,
    // We don't trust the catalog's version field as the source of
    // freshness truth — always re-query crates.io for the newest.
}

pub async fn run(args: Sweep) -> Result<()> {
    let log = |s: &str| {
        if !args.quiet {
            eprintln!("{s}");
        }
    };

    let target = Target::from_env()?;
    let r2 = build_backend(target, &args.bucket).await?;
    let freshness = FreshnessRegistry::new(r2.clone());
    let parser = parser_revision();
    let schema = codeview_core::SCHEMA_VERSION;
    log(&format!(
        "[sweep] parser={} schema=v{}",
        &parser[..parser.len().min(8)],
        schema
    ));

    let force: HashSet<String> = args
        .force
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    let http = docs_rs::http_client()?;
    let candidates = load_watchlist(&args.watchlist, &r2, &http).await?;
    log(&format!(
        "[sweep] watchlist={} size={}",
        args.watchlist,
        candidates.len()
    ));

    let mut matrix = Vec::<MatrixEntry>::new();
    let mut skipped = 0usize;

    for candidate in candidates {
        if matrix.len() >= args.max_crates {
            break;
        }
        let latest = match crates_io::newest_version(&http, &candidate).await {
            Ok(Some(info)) => info,
            Ok(None) => {
                log(&format!("[sweep] crates.io 404: {candidate}"));
                continue;
            }
            Err(e) => {
                log(&format!("[sweep] crates.io error for {candidate}: {e:#}"));
                continue;
            }
        };
        let force_this = force.contains(&candidate);
        let staleness = freshness
            .check(&candidate, &latest.newest_version, &parser, schema)
            .await?;
        if !staleness.is_stale() && !force_this {
            skipped += 1;
            continue;
        }
        let reason = if force_this {
            format!("forced (otherwise: {})", staleness.describe())
        } else {
            staleness.describe()
        };
        matrix.push(MatrixEntry {
            name: latest.name.clone(),
            version: latest.newest_version,
            reason,
        });
    }

    log(&format!(
        "[sweep] {} stale, {} fresh/skipped",
        matrix.len(),
        skipped
    ));
    for m in &matrix {
        log(&format!("  STALE  {}@{}  ({})", m.name, m.version, m.reason));
    }

    let json = serde_json::to_string(&Matrix { include: matrix.clone() })?;

    // GHA matrix output
    if let Ok(out_path) = std::env::var("GITHUB_OUTPUT") {
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&out_path)
            .with_context(|| format!("open GITHUB_OUTPUT={out_path}"))?;
        writeln!(f, "matrix={json}")?;
        writeln!(f, "count={}", matrix.len())?;
    }

    // Optional file-write
    if let Ok(matrix_out) = std::env::var("MATRIX_OUT") {
        fs::write(&matrix_out, &json).with_context(|| format!("write {matrix_out}"))?;
    }

    // Always print to stdout so callers can pipe it
    println!("{json}");
    Ok(())
}

async fn load_watchlist(
    spec: &str,
    r2: &std::sync::Arc<dyn r2::R2>,
    http: &reqwest::Client,
) -> Result<Vec<String>> {
    if spec == "catalog" {
        let Some(catalog) = read_json::<CatalogFile>(r2, r2::CATALOG_KEY).await? else {
            return Ok(Vec::new());
        };
        return Ok(catalog.crates.into_iter().map(|c| c.name).collect());
    }
    if let Some(n_str) = spec.strip_prefix("top:") {
        let n: usize = n_str.parse().context("top:N parse")?;
        let top: Vec<CrateInfo> = crates_io::top(http, n).await?;
        return Ok(top.into_iter().map(|c| c.name).collect());
    }
    // Treat as a file path
    let text = fs::read_to_string(spec)
        .with_context(|| format!("read watchlist file {spec}"))?;
    Ok(text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(String::from)
        .collect())
}
