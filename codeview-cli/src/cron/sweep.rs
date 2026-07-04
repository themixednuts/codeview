//! `codeview cron sweep` — produce the matrix of stale `(name, version)`
//! pairs that the parse job should process.
//!
//! Inputs:
//!   - `STATIC_R2_TARGET` — local | remote
//!   - `--watchlist` — `catalog` (default), `top:N`, or path to a file
//!     with one crate name per line
//!   - `--metadata-source` — `db-dump` (default) or `api` fallback
//!   - `--max-crates` — cap on emitted matrix size
//!   - `--force` — comma-separated names that bypass the freshness check
//!
//! Outputs:
//!   - `stdout` (or `$MATRIX_OUT` file) → JSON `{ include: [{name, version, reason}…] }`
//!   - `$GITHUB_OUTPUT` (if set) → `matrix=...\ncount=N`
//!
//! Pure-ish: reads R2 + bulk crates.io metadata, writes only local dump
//! and snapshot cache files. Catalog and freshness mutations belong to
//! `parse-one` and `catalog` so the sweep is replayable.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use clap::Args;
use serde::{Deserialize, Serialize};

use crate::publisher::crates_dump::{
    self, CrateCandidate, CrateCatalogSnapshot, DEFAULT_DB_DUMP_PATH, DEFAULT_DB_DUMP_URL,
    MetadataSource, SnapshotBuildOptions, SnapshotLoad,
};
use crate::publisher::crates_io::{self, CrateInfo};
use crate::publisher::r2::{self, read_json};

use super::CronContext;

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

    /// Source for crate newest-version/rank metadata.
    #[arg(long, value_enum, default_value_t = MetadataSource::DbDump)]
    pub metadata_source: MetadataSource,

    /// crates.io db-dump URL used by `--metadata-source db-dump`.
    #[arg(long, default_value = DEFAULT_DB_DUMP_URL)]
    pub db_dump_url: String,

    /// Local cache path for `db-dump.tar.gz`.
    #[arg(long, default_value = DEFAULT_DB_DUMP_PATH)]
    pub db_dump_path: PathBuf,

    /// Reuse a local dump/snapshot up to this age.
    #[arg(long, default_value_t = 30)]
    pub metadata_max_age_hours: u64,

    /// Suppress human-readable logs (matrix JSON still goes to stdout).
    #[arg(long)]
    pub quiet: bool,

    /// Inspect-only: log the matrix to stderr without writing
    /// `$GITHUB_OUTPUT`, `$MATRIX_OUT`, or stdout. Useful for
    /// answering "what would today's cron do?" from a dev box.
    #[arg(long)]
    pub dry_run: bool,
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

    let ctx = CronContext::build(&args.bucket).await?;
    let schema = codeview_core::SCHEMA_VERSION;
    log(&format!(
        "[sweep] parser={} schema=v{}{}",
        ctx.parser_revision_short(),
        schema,
        if args.dry_run { " (dry-run)" } else { "" },
    ));

    let force: HashSet<String> = args
        .force
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    if args.metadata_source == MetadataSource::Sparse {
        anyhow::bail!(
            "--metadata-source sparse is accepted by the CLI but is not implemented yet; use db-dump or api"
        );
    }

    let mut matrix = Vec::<MatrixEntry>::new();
    let mut skipped = 0usize;

    if args.metadata_source == MetadataSource::Api {
        let candidates = load_watchlist_api(&args.watchlist, &ctx.r2, &ctx.http).await?;
        log(&format!(
            "[sweep] watchlist={} size={} metadata=api",
            args.watchlist,
            candidates.len()
        ));

        for candidate in candidates {
            if matrix.len() >= args.max_crates {
                break;
            }
            let latest = match crates_io::newest_version(&ctx.http, &candidate).await {
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
            let staleness = ctx
                .freshness
                .check(
                    &candidate,
                    &latest.newest_version,
                    &ctx.parser_revision,
                    schema,
                )
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
    } else {
        let metadata_http = crates_dump::http_client()?;
        let snapshot_path = crates_dump::snapshot_path_for_dump(&args.db_dump_path);
        let (snapshot, load) = crates_dump::load_or_refresh_snapshot(
            &metadata_http,
            &args.db_dump_url,
            &args.db_dump_path,
            &snapshot_path,
            SnapshotBuildOptions::default(),
            crates_dump::max_age_duration(args.metadata_max_age_hours),
        )
        .await?;
        match load {
            SnapshotLoad::ReusedSnapshot => {
                log(&format!(
                    "[sweep] metadata=db-dump reused {}",
                    snapshot_path.display()
                ));
            }
            SnapshotLoad::BuiltFromDump => {
                log(&format!(
                    "[sweep] metadata=db-dump built {} crates from {}",
                    snapshot.crates.len(),
                    args.db_dump_path.display()
                ));
            }
        }

        let resolved = load_watchlist_snapshot(&args.watchlist, &ctx.r2, &snapshot).await?;
        log(&format!(
            "[sweep] watchlist={} size={} metadata=db-dump",
            args.watchlist,
            resolved.candidates.len()
        ));
        for missing in &resolved.missing {
            log(&format!("[sweep] snapshot missing crate: {missing}"));
        }

        for candidate in resolved.candidates {
            if matrix.len() >= args.max_crates {
                break;
            }
            let Some(version) = &candidate.newest_non_yanked else {
                log(&format!(
                    "[sweep] snapshot has no non-yanked version: {}",
                    candidate.name
                ));
                continue;
            };
            let force_this = force.contains(&candidate.name);
            let staleness = ctx
                .freshness
                .check(&candidate.name, version, &ctx.parser_revision, schema)
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
                name: candidate.name.clone(),
                version: version.clone(),
                reason,
            });
        }
    }

    log(&format!(
        "[sweep] {} stale, {} fresh/skipped",
        matrix.len(),
        skipped
    ));
    for m in &matrix {
        log(&format!(
            "  STALE  {}@{}  ({})",
            m.name, m.version, m.reason
        ));
    }

    let json = serde_json::to_string(&Matrix {
        include: matrix.clone(),
    })?;

    if args.dry_run {
        // Don't write anywhere — caller is just inspecting.  Print the
        // matrix to stderr so it shows alongside the per-crate STALE
        // lines without polluting stdout.
        log(&format!("[sweep] dry-run matrix: {json}"));
        return Ok(());
    }

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

async fn load_watchlist_api(
    spec: &str,
    r2: &Arc<dyn r2::R2>,
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
    let text = fs::read_to_string(spec).with_context(|| format!("read watchlist file {spec}"))?;
    Ok(text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(String::from)
        .collect())
}

struct SnapshotWatchlist<'a> {
    candidates: Vec<&'a CrateCandidate>,
    missing: Vec<String>,
}

async fn load_watchlist_snapshot<'a>(
    spec: &str,
    r2: &Arc<dyn r2::R2>,
    snapshot: &'a CrateCatalogSnapshot,
) -> Result<SnapshotWatchlist<'a>> {
    if let Some(n_str) = spec.strip_prefix("top:") {
        let n: usize = n_str.parse().context("top:N parse")?;
        return Ok(SnapshotWatchlist {
            candidates: snapshot.crates.iter().take(n).collect(),
            missing: Vec::new(),
        });
    }

    let names: Vec<String> = if spec == "catalog" {
        let Some(catalog) = read_json::<CatalogFile>(r2, r2::CATALOG_KEY).await? else {
            return Ok(SnapshotWatchlist {
                candidates: Vec::new(),
                missing: Vec::new(),
            });
        };
        catalog.crates.into_iter().map(|c| c.name).collect()
    } else {
        fs::read_to_string(spec)
            .with_context(|| format!("read watchlist file {spec}"))?
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .map(String::from)
            .collect()
    };

    let by_name: HashMap<&str, &CrateCandidate> = snapshot
        .crates
        .iter()
        .map(|candidate| (candidate.name.as_str(), candidate))
        .collect();
    let mut candidates = Vec::with_capacity(names.len());
    let mut missing = Vec::new();
    for name in names {
        match by_name.get(name.as_str()) {
            Some(candidate) => candidates.push(*candidate),
            None => missing.push(name),
        }
    }
    Ok(SnapshotWatchlist {
        candidates,
        missing,
    })
}
