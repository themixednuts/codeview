//! `codeview cron parse-one` — fetch + parse + publish one crate.
//!
//! Exit codes (the GHA matrix script branches on these):
//!   0  ok
//!   64 transient (retry next sweep)
//!   65 permanent (don't retry until parser/schema revision changes)
//!   70 internal bug — page a human

use anyhow::Result;
use clap::Args;

use crate::publisher::artifacts::{
    CrateSource, PublishOptions, hyphenate_crate_name, normalise_crate_name, publish_one,
};

use super::CronContext;

#[derive(Debug, Args)]
pub struct ParseOne {
    /// Crate name (e.g. `tokio`, `serde-json`).
    #[arg(long, env = "NAME")]
    pub name: String,

    /// Crate version (e.g. `1.40.0`).
    #[arg(long, env = "VERSION")]
    pub version: String,

    /// Bypass the freshness idempotency check.
    #[arg(long)]
    pub force: bool,

    /// Override the docs.rs target triple.
    #[arg(long)]
    pub docsrs_target: Option<String>,

    /// R2 bucket (default: `crate-graphs`).
    #[arg(long, default_value = "crate-graphs")]
    pub bucket: String,

    /// Comma-separated version aliases to write alongside the version.
    /// Default `latest,stable` matches what the worker resolves.
    #[arg(long, default_value = "latest,stable")]
    pub aliases: String,
}

pub async fn run(args: ParseOne) -> Result<()> {
    let ctx = CronContext::build(&args.bucket).await?;

    let canonical = normalise_crate_name(&args.name);
    let storage = hyphenate_crate_name(&args.name);
    let aliases_owned: Vec<String> = args
        .aliases
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let aliases: Vec<&str> = aliases_owned.iter().map(String::as_str).collect();

    eprintln!(
        "[parse-one] {}@{}  parser={} schema=v{}",
        args.name,
        args.version,
        ctx.parser_revision_short(),
        codeview_core::SCHEMA_VERSION,
    );

    let outcome = publish_one(PublishOptions {
        package_name: &args.name,
        name: &canonical,
        version: &args.version,
        storage_name: &storage,
        r2: ctx.r2.clone(),
        freshness: &ctx.freshness,
        parser_revision: &ctx.parser_revision,
        schema_version: codeview_core::SCHEMA_VERSION,
        force: args.force,
        source: CrateSource::DocsRs {
            target: args.docsrs_target.as_deref(),
        },
        aliases: &aliases,
    })
    .await;

    match outcome {
        Ok(crate::publisher::artifacts::Outcome::AlreadyFresh) => {
            eprintln!("[parse-one] OK (fresh, no work needed)");
            std::process::exit(0);
        }
        Ok(crate::publisher::artifacts::Outcome::ParserBumpedSameOutput) => {
            eprintln!("[parse-one] OK (parser bumped, output identical, registry refreshed)");
            std::process::exit(0);
        }
        Ok(crate::publisher::artifacts::Outcome::Published { nodes, edges }) => {
            eprintln!("[parse-one] OK ({nodes} nodes, {edges} edges published)");
            std::process::exit(0);
        }
        Err(err) => {
            eprintln!("[parse-one] {err}");
            std::process::exit(err.exit_code());
        }
    }
}
