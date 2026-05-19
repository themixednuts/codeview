//! `codeview cron *` — the production parse pipeline.
//!
//! All the work the TS scripts used to do, in one binary.  Same flow
//! whether you're running on a GHA runner against production R2 or
//! locally against miniflare-SQLite via `wrangler dev --persist-to`.
//!
//! Subcommand map:
//!
//! - `sweep`     — scan R2 catalog + crates.io, emit a matrix JSON of
//!                  stale `(name, version)` pairs.
//! - `parse-one` — fetch one crate's rustdoc JSON from docs.rs, parse,
//!                  build artifacts, upload, record freshness.
//! - `catalog`   — derive `rust/catalog.json` from the freshness index.
//! - `mimic`     — dev-time loop: sweep + parse-one over a small set,
//!                  against local R2.

pub mod catalog;
pub mod mimic;
pub mod parse_one;
pub mod sweep;

use clap::{Args, Subcommand};

#[derive(Debug, Subcommand)]
pub enum CronCommand {
    /// Emit a matrix of stale crates (the GHA `freshness` job)
    Sweep(sweep::Sweep),
    /// Parse + publish one crate (the GHA `parse` matrix shard)
    ParseOne(parse_one::ParseOne),
    /// Rebuild `rust/catalog.json` from the freshness index
    Catalog(catalog::Catalog),
    /// Local dev: sweep + parse a small set against local R2
    Mimic(mimic::Mimic),
}

#[derive(Debug, Args)]
pub struct CronArgs {
    #[command(subcommand)]
    pub command: CronCommand,
}

pub async fn dispatch(args: CronArgs) -> anyhow::Result<()> {
    match args.command {
        CronCommand::Sweep(s) => sweep::run(s).await,
        CronCommand::ParseOne(s) => parse_one::run(s).await,
        CronCommand::Catalog(s) => catalog::run(s).await,
        CronCommand::Mimic(s) => mimic::run(s).await,
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
