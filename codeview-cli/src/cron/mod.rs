//! `codeview cron *` — the production parse pipeline.
//!
//! All the work the TS scripts used to do, in one binary.  Same flow
//! whether you're running on a GHA runner against production R2 or
//! locally against miniflare-SQLite via `wrangler dev --persist-to`.
//!
//! Subcommand map:
//!
//! - `sweep` — scan R2 catalog + crates.io, emit a matrix JSON of stale
//!   `(name, version)` pairs.
//! - `parse-one` — fetch one crate's rustdoc JSON from docs.rs, parse,
//!   build artifacts, upload, record freshness.
//! - `catalog` — derive `rust/catalog.json` from the freshness index.
//! - `metadata` — build/publish a compact crates.io db-dump snapshot.
//! - `plan` — build a runner-agnostic sharded work plan.
//! - `parse-shard` — process one deterministic shard from a work plan.
//! - `seed-std` — populate R2 with std/core/alloc/proc_macro/test from
//!   a rustup-installed `rust-docs-json` component (nightly-only).
//! - `mimic` — dev-time loop: sweep + parse-one over a small set,
//!   against local R2.

pub mod catalog;
pub mod metadata;
pub mod mimic;
pub mod parse_shard;
pub mod parse_one;
pub mod plan;
pub mod seed_std;
pub mod sweep;

use std::sync::Arc;

use anyhow::Result;
use clap::{Args, Subcommand};

use crate::publisher::docs_rs;
use crate::publisher::freshness::FreshnessRegistry;
use crate::publisher::r2::{R2, Target, build_backend};

#[derive(Debug, Subcommand)]
pub enum CronCommand {
    /// Emit a matrix of stale crates (the GHA `freshness` job)
    Sweep(sweep::Sweep),
    /// Parse + publish one crate (the GHA `parse` matrix shard)
    ParseOne(parse_one::ParseOne),
    /// Rebuild `rust/catalog.json` from the freshness index
    Catalog(catalog::Catalog),
    /// Build or publish a bulk crates.io metadata snapshot
    Metadata(metadata::Metadata),
    /// Build a runner-agnostic sharded parse plan
    Plan(plan::Plan),
    /// Process one deterministic shard from a parse plan
    ParseShard(parse_shard::ParseShard),
    /// Seed std/core/alloc/proc_macro/test from a rust-docs-json toolchain
    SeedStd(seed_std::SeedStd),
    /// Local dev: sweep + parse a small set against local R2
    Mimic(mimic::Mimic),
}

#[derive(Debug, Args)]
pub struct CronArgs {
    #[command(subcommand)]
    pub command: CronCommand,
}

pub async fn dispatch(args: CronArgs) -> Result<()> {
    match args.command {
        CronCommand::Sweep(s) => sweep::run(s).await,
        CronCommand::ParseOne(s) => parse_one::run(s).await,
        CronCommand::Catalog(s) => catalog::run(s).await,
        CronCommand::Metadata(s) => metadata::run(s).await,
        CronCommand::Plan(s) => plan::run(s).await,
        CronCommand::ParseShard(s) => parse_shard::run(s).await,
        CronCommand::SeedStd(s) => seed_std::run(s).await,
        CronCommand::Mimic(s) => mimic::run(s).await,
    }
}

// ─── Shared cron context ──────────────────────────────────────────────

/// Common setup every cron subcommand needs: an R2 backend (local or
/// remote), a `FreshnessRegistry` over the same backend, an HTTP client
/// with sensible timeouts/UA, and the parser revision the freshness
/// check predicates on.
///
/// Subcommands construct this once via [`CronContext::build`] instead of
/// each repeating the four-line setup. Pure DRY — same wire shape per
/// subcommand, just different inputs.
pub struct CronContext {
    pub r2: Arc<dyn R2>,
    pub freshness: FreshnessRegistry,
    pub http: reqwest::Client,
    pub parser_revision: String,
}

impl CronContext {
    /// `bucket` is the R2 bucket name (typically `"crate-graphs"`).
    /// Reads `STATIC_R2_TARGET` to decide local vs. remote.
    pub async fn build(bucket: &str) -> Result<Self> {
        let target = Target::from_env()?;
        let r2 = build_backend(target, bucket).await?;
        let freshness = FreshnessRegistry::new(r2.clone());
        let http = docs_rs::http_client()?;
        let parser_revision = parser_revision();
        Ok(Self {
            r2,
            freshness,
            http,
            parser_revision,
        })
    }

    /// Short hash for log lines.
    pub fn parser_revision_short(&self) -> &str {
        let max = self.parser_revision.len().min(8);
        &self.parser_revision[..max]
    }
}

/// Resolve the parser revision used by the freshness check.  Order:
/// `PARSER_REVISION` env var (set by GHA) → `git rev-parse HEAD` →
/// fallback to a literal `"unknown"`.
pub fn parser_revision() -> String {
    if let Ok(v) = std::env::var("PARSER_REVISION") {
        return v;
    }
    if let Ok(out) = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .output()
        && out.status.success()
    {
        return String::from_utf8_lossy(&out.stdout).trim().to_string();
    }
    "unknown".to_string()
}
