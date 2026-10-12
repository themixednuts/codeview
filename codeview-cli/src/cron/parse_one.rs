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
    CrateSource, Outcome, PublishOptions, hyphenate_crate_name, normalise_crate_name, publish_one,
};

use super::CronContext;
use super::parse_shard::{RunDeltaOutcome, append_run_delta, delta_for_result};
use super::plan::{WorkItem, WorkKind};

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

    /// Record the outcome (success or failure) as a run delta under
    /// `rust/_runs/<run-id>/deltas/direct.jsonl`, so a following
    /// `freshness-merge --run-id <run-id>` can update just this crate in
    /// the aggregate index instead of re-listing every freshness record.
    #[arg(long)]
    pub run_id: Option<String>,
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
            throttle: None,
        },
        aliases: &aliases,
    })
    .await;

    let exit_code = match &outcome {
        Ok(Outcome::AlreadyFresh) => {
            eprintln!("[parse-one] OK (fresh, no work needed)");
            0
        }
        Ok(Outcome::ParserBumpedSameOutput) => {
            eprintln!("[parse-one] OK (parser bumped, output identical, registry refreshed)");
            0
        }
        Ok(Outcome::Published { nodes, edges }) => {
            eprintln!("[parse-one] OK ({nodes} nodes, {edges} edges published)");
            0
        }
        Err(err) => {
            eprintln!("[parse-one] {err}");
            err.exit_code()
        }
    };

    if let Some(run_id) = args.run_id.as_deref() {
        let item = WorkItem {
            work_id: format!("direct:{canonical}@{}", args.version),
            kind: WorkKind::Crate,
            name: args.name.clone(),
            version: args.version.clone(),
            channel: args
                .docsrs_target
                .clone()
                .unwrap_or_else(|| "default".to_string()),
            priority_tier: "direct".to_string(),
            download_rank: None,
            reason: "direct request".to_string(),
        };
        let delta = delta_for_result(&ctx, &item, &canonical, outcome).await;
        if delta.outcome == RunDeltaOutcome::Transient && exit_code == 0 {
            eprintln!(
                "[parse-one] warning: {}",
                delta.error.as_deref().unwrap_or("transient delta")
            );
        }
        append_run_delta(&ctx, run_id, "direct", &delta).await?;
    }

    std::process::exit(exit_code);
}
