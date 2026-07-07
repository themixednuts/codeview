//! `codeview cron parse-shard` — drain one deterministic plan shard.

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use clap::Args;
use serde::{Deserialize, Serialize};

use crate::publisher::artifacts::{
    CrateSource, Outcome, PublishError, PublishOptions, hyphenate_crate_name, normalise_crate_name,
    publish_one,
};
use crate::publisher::r2::{R2, read_json};
use crate::publisher::shards;

use super::CronContext;
use super::plan::{WorkKind, WorkPlan};

#[derive(Debug, Args)]
pub struct ParseShard {
    /// Plan source. `r2:<key>`, `r2://<key>`, and `rust/...` read from
    /// R2; other values are local paths.
    #[arg(long)]
    pub plan: String,

    /// Zero-based shard index to process.
    #[arg(long)]
    pub shard_index: usize,

    /// Total shard count used by `cron plan`.
    #[arg(long)]
    pub shard_count: usize,

    /// Maximum items to process from this shard.
    #[arg(long)]
    pub max_items: Option<usize>,

    /// Wall-clock budget for this worker.
    #[arg(long)]
    pub max_duration_minutes: Option<u64>,

    /// Minimum delay between docs.rs publish attempts.
    #[arg(long, default_value_t = 15_000)]
    pub docsrs_min_delay_ms: u64,

    /// Override the plan run id for delta output.
    #[arg(long)]
    pub run_id: Option<String>,

    /// Bypass per-item freshness checks.
    #[arg(long)]
    pub force: bool,

    /// R2 bucket.
    #[arg(long, default_value = "crate-graphs")]
    pub bucket: String,
}

/// One line in `rust/_runs/{run_id}/deltas/{shard_index}.jsonl`.
///
/// Each line is a standalone JSON object. Success lines use
/// `outcome=published|fresh|parser-bumped` and should include
/// `nodes`, `edges`, and `graph_hash` when freshness metadata is
/// available. Failure lines use
/// `outcome=transient|permanent|quarantine` and carry `error`. A later
/// single-writer `freshness-merge` command will consume these lines to
/// update aggregate freshness shards; parse workers must not mutate that
/// aggregate directly.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RunDelta {
    pub work_id: String,
    pub name: String,
    pub version: String,
    pub outcome: RunDeltaOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nodes: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edges: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graph_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority_tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_rank: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RunDeltaOutcome {
    Published,
    Fresh,
    ParserBumped,
    Transient,
    Permanent,
    Quarantine,
}

enum PlanSource {
    Local(PathBuf),
    R2(String),
}

#[derive(Debug, Clone)]
pub(crate) struct ShardDrainConfig {
    pub(crate) run_id: String,
    pub(crate) shard_index: usize,
    pub(crate) shard_count: usize,
    pub(crate) max_items: Option<usize>,
    pub(crate) max_duration_minutes: Option<u64>,
    pub(crate) docsrs_min_delay_ms: u64,
    pub(crate) force: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ShardDrainReport {
    pub(crate) shard_index: usize,
    pub(crate) selected: usize,
    pub(crate) processed: usize,
    pub(crate) published: usize,
    pub(crate) fresh: usize,
    pub(crate) failed: usize,
}

pub async fn run(args: ParseShard) -> Result<()> {
    if args.shard_count == 0 {
        anyhow::bail!("--shard-count must be greater than zero");
    }
    if args.shard_index >= args.shard_count {
        anyhow::bail!(
            "--shard-index {} must be less than --shard-count {}",
            args.shard_index,
            args.shard_count
        );
    }

    let ctx = CronContext::build(&args.bucket).await?;
    let plan = load_plan(&ctx, &args.plan).await?;
    if plan.shard_count != args.shard_count {
        anyhow::bail!(
            "plan shard_count {} does not match --shard-count {}",
            plan.shard_count,
            args.shard_count
        );
    }
    let run_id = args.run_id.clone().unwrap_or_else(|| plan.run_id.clone());
    drain_shard(
        &ctx,
        &plan,
        ShardDrainConfig {
            run_id,
            shard_index: args.shard_index,
            shard_count: args.shard_count,
            max_items: args.max_items,
            max_duration_minutes: args.max_duration_minutes,
            docsrs_min_delay_ms: args.docsrs_min_delay_ms,
            force: args.force,
        },
    )
    .await?;
    Ok(())
}

pub(crate) async fn drain_shard(
    ctx: &CronContext,
    plan: &WorkPlan,
    config: ShardDrainConfig,
) -> Result<ShardDrainReport> {
    if config.shard_count == 0 {
        anyhow::bail!("shard_count must be greater than zero");
    }
    if config.shard_index >= config.shard_count {
        anyhow::bail!(
            "shard_index {} must be less than shard_count {}",
            config.shard_index,
            config.shard_count
        );
    }
    if plan.shard_count != config.shard_count {
        anyhow::bail!(
            "plan shard_count {} does not match shard_count {}",
            plan.shard_count,
            config.shard_count
        );
    }

    let deadline = config
        .max_duration_minutes
        .map(|minutes| Instant::now() + Duration::from_secs(minutes.saturating_mul(60)));
    let delay = Duration::from_millis(config.docsrs_min_delay_ms);

    let shard_work: Vec<_> = plan
        .work
        .iter()
        .filter(|item| shards::work_bucket(&item.work_id, config.shard_count) == config.shard_index)
        .cloned()
        .collect();

    eprintln!(
        "[parse-shard] run={} shard={}/{} selected={} parser={} schema=v{}",
        config.run_id,
        config.shard_index,
        config.shard_count,
        shard_work.len(),
        ctx.parser_revision_short(),
        codeview_core::SCHEMA_VERSION,
    );

    let mut report = ShardDrainReport {
        shard_index: config.shard_index,
        selected: shard_work.len(),
        processed: 0,
        published: 0,
        fresh: 0,
        failed: 0,
    };
    for item in shard_work {
        if let Some(max_items) = config.max_items
            && report.processed >= max_items
        {
            break;
        }
        if let Some(deadline) = deadline
            && Instant::now() >= deadline
        {
            eprintln!("[parse-shard] stopping at duration budget");
            break;
        }

        let delta = process_item(ctx, &item, config.force).await;
        match &delta.outcome {
            RunDeltaOutcome::Published | RunDeltaOutcome::ParserBumped => report.published += 1,
            RunDeltaOutcome::Fresh => report.fresh += 1,
            RunDeltaOutcome::Transient
            | RunDeltaOutcome::Permanent
            | RunDeltaOutcome::Quarantine => report.failed += 1,
        }
        append_run_delta(ctx, &config.run_id, config.shard_index, &delta).await?;
        report.processed += 1;

        if delay > Duration::ZERO
            && config
                .max_items
                .is_none_or(|max_items| report.processed < max_items)
        {
            if let Some(deadline) = deadline
                && Instant::now() + delay >= deadline
            {
                break;
            }
            tokio::time::sleep(delay).await;
        }
    }

    eprintln!(
        "[parse-shard] done processed={} published_or_bumped={} fresh={} failed={}",
        report.processed, report.published, report.fresh, report.failed
    );
    Ok(report)
}

pub(crate) fn shard_work_count(plan: &WorkPlan, shard_index: usize, shard_count: usize) -> usize {
    plan.work
        .iter()
        .filter(|item| shards::work_bucket(&item.work_id, shard_count) == shard_index)
        .count()
}

pub(crate) fn shard_work_counts(plan: &WorkPlan, shard_count: usize) -> Vec<usize> {
    (0..shard_count)
        .map(|shard_index| shard_work_count(plan, shard_index, shard_count))
        .collect()
}

async fn process_item(ctx: &CronContext, item: &super::plan::WorkItem, force: bool) -> RunDelta {
    if item.kind != WorkKind::Crate {
        return error_delta(
            item,
            RunDeltaOutcome::Permanent,
            "parse-shard currently supports crate work only; use seed-std for std artifacts"
                .to_string(),
        );
    }

    let canonical = normalise_crate_name(&item.name);
    let storage = hyphenate_crate_name(&item.name);
    let docsrs_target = if item.channel == "default" || item.channel.is_empty() {
        None
    } else {
        Some(item.channel.as_str())
    };
    let aliases = ["latest", "stable"];

    eprintln!("[parse-shard] processing {}@{}", item.name, item.version);
    let outcome = publish_one(PublishOptions {
        package_name: &item.name,
        name: &canonical,
        version: &item.version,
        storage_name: &storage,
        r2: ctx.r2.clone(),
        freshness: &ctx.freshness,
        parser_revision: &ctx.parser_revision,
        schema_version: codeview_core::SCHEMA_VERSION,
        force,
        source: CrateSource::DocsRs {
            target: docsrs_target,
        },
        aliases: &aliases,
    })
    .await;

    match outcome {
        Ok(outcome) => success_delta(ctx, item, &canonical, outcome).await,
        Err(PublishError::Transient(err)) => {
            error_delta(item, RunDeltaOutcome::Transient, format!("{err:#}"))
        }
        Err(PublishError::Permanent(err)) => error_delta(item, RunDeltaOutcome::Permanent, err),
        Err(PublishError::Quarantine(err)) => error_delta(item, RunDeltaOutcome::Quarantine, err),
    }
}

async fn success_delta(
    ctx: &CronContext,
    item: &super::plan::WorkItem,
    canonical_name: &str,
    outcome: Outcome,
) -> RunDelta {
    let latest = match ctx.freshness.version(canonical_name, &item.version).await {
        Ok(entry) => entry,
        Err(err) => {
            return RunDelta {
                work_id: item.work_id.clone(),
                name: item.name.clone(),
                version: item.version.clone(),
                outcome: RunDeltaOutcome::Transient,
                nodes: None,
                edges: None,
                graph_hash: None,
                priority_tier: Some(item.priority_tier.clone()),
                download_rank: item.download_rank,
                error: Some(format!("read freshness after publish: {err:#}")),
            };
        }
    };
    let (outcome, published_counts) = match outcome {
        Outcome::AlreadyFresh => (RunDeltaOutcome::Fresh, None),
        Outcome::ParserBumpedSameOutput => (RunDeltaOutcome::ParserBumped, None),
        Outcome::Published { nodes, edges } => (RunDeltaOutcome::Published, Some((nodes, edges))),
    };
    let nodes = latest
        .as_ref()
        .map(|entry| entry.nodes)
        .or_else(|| published_counts.map(|(nodes, _)| nodes));
    let edges = latest
        .as_ref()
        .map(|entry| entry.edges)
        .or_else(|| published_counts.map(|(_, edges)| edges));
    let graph_hash = latest.map(|entry| entry.graph_hash);

    RunDelta {
        work_id: item.work_id.clone(),
        name: item.name.clone(),
        version: item.version.clone(),
        outcome,
        nodes,
        edges,
        graph_hash,
        priority_tier: Some(item.priority_tier.clone()),
        download_rank: item.download_rank,
        error: None,
    }
}

fn error_delta(item: &super::plan::WorkItem, outcome: RunDeltaOutcome, error: String) -> RunDelta {
    RunDelta {
        work_id: item.work_id.clone(),
        name: item.name.clone(),
        version: item.version.clone(),
        outcome,
        nodes: None,
        edges: None,
        graph_hash: None,
        priority_tier: Some(item.priority_tier.clone()),
        download_rank: item.download_rank,
        error: Some(error),
    }
}

async fn append_run_delta(
    ctx: &CronContext,
    run_id: &str,
    shard_index: usize,
    delta: &RunDelta,
) -> Result<()> {
    let key = format!("rust/_runs/{run_id}/deltas/{shard_index}.jsonl");
    append_jsonl(&ctx.r2, &key, delta).await
}

async fn append_jsonl<T: Serialize>(
    r2: &std::sync::Arc<dyn R2>,
    key: &str,
    value: &T,
) -> Result<()> {
    let mut bytes = r2.get(key).await?.unwrap_or_default();
    bytes.extend(serde_json::to_vec(value)?);
    bytes.push(b'\n');
    r2.put(key, bytes, "application/x-ndjson; charset=utf-8")
        .await
}

async fn load_plan(ctx: &CronContext, raw: &str) -> Result<WorkPlan> {
    match parse_plan_source(raw) {
        PlanSource::Local(path) => {
            let bytes = fs::read(&path).with_context(|| format!("read {}", path.display()))?;
            serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))
        }
        PlanSource::R2(key) => read_json(&ctx.r2, &key)
            .await?
            .with_context(|| format!("R2 plan object missing: {key}")),
    }
}

fn parse_plan_source(raw: &str) -> PlanSource {
    if let Some(key) = raw.strip_prefix("r2://") {
        return PlanSource::R2(key.to_string());
    }
    if let Some(key) = raw.strip_prefix("r2:") {
        return PlanSource::R2(key.to_string());
    }
    if raw.starts_with("rust/") {
        return PlanSource::R2(raw.to_string());
    }
    PlanSource::Local(PathBuf::from(raw))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_delta_round_trips_as_json_line_schema() {
        let delta = RunDelta {
            work_id: "crate:serde:1.0.228:default".to_string(),
            name: "serde".to_string(),
            version: "1.0.228".to_string(),
            outcome: RunDeltaOutcome::ParserBumped,
            nodes: Some(42),
            edges: Some(17),
            graph_hash: Some("abc123".to_string()),
            priority_tier: Some("top-download-stale".to_string()),
            download_rank: Some(12),
            error: None,
        };

        let mut line = serde_json::to_string(&delta).unwrap();
        line.push('\n');
        let parsed: RunDelta = serde_json::from_str(line.trim_end()).unwrap();

        assert_eq!(parsed, delta);
        assert!(line.contains("\"outcome\":\"parser-bumped\""));
        assert!(line.contains("\"graph_hash\":\"abc123\""));
        assert!(line.contains("\"priority_tier\":\"top-download-stale\""));
        assert!(line.contains("\"download_rank\":12"));
    }
}
