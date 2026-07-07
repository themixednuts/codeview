//! `codeview cron publish-run` — local run-all driver for static publishing.
//!
//! This is the ergonomic local entry point over the runner-agnostic
//! pieces: build a plan, drain every shard in-process, then run the
//! single-writer freshness finalizer once.

use std::collections::HashSet;
use std::future::Future;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::Result;
use clap::Args;
use futures::stream::{self, StreamExt, TryStreamExt};

use crate::publisher::crates_dump::{DEFAULT_DB_DUMP_PATH, DEFAULT_DB_DUMP_URL, MetadataSource};
use crate::publisher::r2::run_delta_prefix;

use super::CronContext;
use super::freshness_merge::{self, FinalizeConfig, FreshnessMergeReport};
use super::parse_shard::{self, ShardDrainConfig, ShardDrainReport};
use super::plan::{self, CorpusTier, PlanBuildConfig, PlanMode, WorkPlan};

const DEFAULT_SHARD_COUNT: usize = 8;
const DEFAULT_CONCURRENCY: usize = 4;
const DEFAULT_DOCSRS_MIN_DELAY_MS: u64 = 15_000;

#[derive(Debug, Args)]
pub struct PublishRun {
    /// Scheduling mode used while building the plan.
    #[arg(long, value_enum, default_value_t = PlanMode::Daily)]
    pub mode: PlanMode,

    /// Corpus source: `catalog`, `top:N`, `file:<path>`, `all`, or a file path.
    #[arg(long, default_value = "catalog")]
    pub corpus: String,

    /// Tier shortcut. When present, this overrides `--corpus`.
    #[arg(long, value_enum)]
    pub tier: Option<CorpusTier>,

    /// Number of deterministic worker shards to plan and drain.
    #[arg(long, default_value_t = DEFAULT_SHARD_COUNT)]
    pub shard_count: usize,

    /// Maximum work items across the full plan.
    #[arg(long)]
    pub max_total: Option<usize>,

    /// Maximum work items planned and drained per deterministic shard.
    #[arg(long)]
    pub max_per_shard: Option<usize>,

    /// Wall-clock budget for each shard drain.
    #[arg(long)]
    pub max_duration_minutes: Option<u64>,

    /// Include prerelease versions when refreshing the metadata snapshot.
    #[arg(long)]
    pub include_prerelease: bool,

    /// Re-parse selected plan items even when freshness says they are current.
    #[arg(long)]
    pub force: bool,

    /// Minimum delay each active shard waits between docs.rs requests.
    ///
    /// Raising `--concurrency` raises concurrent docs.rs request load:
    /// every active shard applies this delay independently.
    #[arg(long, default_value_t = DEFAULT_DOCSRS_MIN_DELAY_MS)]
    pub docsrs_min_delay_ms: u64,

    /// Number of shards to drain concurrently.
    #[arg(long, default_value_t = DEFAULT_CONCURRENCY)]
    pub concurrency: usize,

    /// Stable run id. Defaults to `GITHUB_RUN_ID`, then a generated-at timestamp.
    #[arg(long)]
    pub run_id: Option<String>,

    /// RFC3339 timestamp used for deterministic plan/finalize generation.
    #[arg(long)]
    pub generated_at: Option<String>,

    /// R2 bucket.
    #[arg(long, default_value = "crate-graphs")]
    pub bucket: String,

    /// Build and print the plan plus per-shard counts, but skip publishing/finalize.
    #[arg(long)]
    pub dry_run: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct PublishRunDriverConfig {
    pub(crate) shard_count: usize,
    pub(crate) concurrency: usize,
    pub(crate) dry_run: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct PublishRunReport {
    pub(crate) dry_run: bool,
    pub(crate) shard_counts: Vec<usize>,
    pub(crate) shard_reports: Vec<ShardDrainReport>,
    pub(crate) finalizer_report: Option<FreshnessMergeReport>,
    pub(crate) elapsed: Duration,
}

pub async fn run(args: PublishRun) -> Result<()> {
    if args.shard_count == 0 {
        anyhow::bail!("--shard-count must be greater than zero");
    }
    if args.concurrency == 0 {
        anyhow::bail!("--concurrency must be greater than zero");
    }

    let ctx = CronContext::build(&args.bucket).await?;
    let plan = plan::build_plan(
        &ctx,
        PlanBuildConfig {
            mode: args.mode,
            corpus: args.corpus.clone(),
            tier: args.tier,
            shard_count: args.shard_count,
            max_total: args.max_total,
            max_per_shard: args.max_per_shard,
            include_retries: false,
            force_names: HashSet::new(),
            force_all: args.force,
            include_prerelease: args.include_prerelease,
            plan_out: None,
            run_id: args.run_id.clone(),
            generated_at: args.generated_at.clone(),
            metadata_source: MetadataSource::DbDump,
            db_dump_url: DEFAULT_DB_DUMP_URL.to_string(),
            db_dump_path: PathBuf::from(DEFAULT_DB_DUMP_PATH),
            metadata_max_age_hours: 30,
            quiet: false,
        },
    )
    .await?;

    let run_id = plan.run_id.clone();
    let generated_at = plan.generated_at.clone();
    eprintln!(
        "[publish-run] run={} shards={} concurrency={} docsrs_min_delay_ms={} dry_run={}",
        run_id, args.shard_count, args.concurrency, args.docsrs_min_delay_ms, args.dry_run
    );
    eprintln!(
        "[publish-run] docs.rs politeness: each active shard applies its own delay; raising --concurrency raises concurrent docs.rs request load"
    );

    let report = run_publish_plan_with(
        plan.clone(),
        PublishRunDriverConfig {
            shard_count: args.shard_count,
            concurrency: args.concurrency,
            dry_run: args.dry_run,
        },
        |shard_index| {
            let ctx = &ctx;
            let plan = &plan;
            let run_id = run_id.clone();
            async move {
                parse_shard::drain_shard(
                    ctx,
                    plan,
                    ShardDrainConfig {
                        run_id,
                        shard_index,
                        shard_count: args.shard_count,
                        max_items: args.max_per_shard,
                        max_duration_minutes: args.max_duration_minutes,
                        docsrs_min_delay_ms: args.docsrs_min_delay_ms,
                        force: args.force,
                    },
                )
                .await
            }
        },
        || {
            let ctx = &ctx;
            let run_id = run_id.clone();
            let generated_at = generated_at.clone();
            async move {
                freshness_merge::finalize(
                    ctx,
                    FinalizeConfig {
                        run_id: run_id.clone(),
                        delta_prefix: run_delta_prefix(&run_id),
                        index_shards: 256,
                        write_catalog: true,
                        write_refs: true,
                        bootstrap: false,
                        generation: run_id,
                        generated_at,
                    },
                )
                .await
            }
        },
    )
    .await?;

    if report.dry_run {
        print_dry_run(&plan, &report)?;
    }
    print_summary(&plan, &report);
    Ok(())
}

pub(crate) async fn run_publish_plan_with<D, DFut, F, FFut>(
    plan: WorkPlan,
    config: PublishRunDriverConfig,
    drain: D,
    finalize: F,
) -> Result<PublishRunReport>
where
    D: Fn(usize) -> DFut + Clone,
    DFut: Future<Output = Result<ShardDrainReport>>,
    F: FnOnce() -> FFut,
    FFut: Future<Output = Result<FreshnessMergeReport>>,
{
    if config.shard_count == 0 {
        anyhow::bail!("shard_count must be greater than zero");
    }
    if config.concurrency == 0 {
        anyhow::bail!("concurrency must be greater than zero");
    }
    if plan.shard_count != config.shard_count {
        anyhow::bail!(
            "plan shard_count {} does not match shard_count {}",
            plan.shard_count,
            config.shard_count
        );
    }

    let started = Instant::now();
    let shard_counts = parse_shard::shard_work_counts(&plan, config.shard_count);
    if config.dry_run {
        return Ok(PublishRunReport {
            dry_run: true,
            shard_counts,
            shard_reports: Vec::new(),
            finalizer_report: None,
            elapsed: started.elapsed(),
        });
    }

    let shard_reports =
        drain_all_shards_with(config.shard_count, config.concurrency, drain).await?;
    let finalizer_report = finalize().await?;

    Ok(PublishRunReport {
        dry_run: false,
        shard_counts,
        shard_reports,
        finalizer_report: Some(finalizer_report),
        elapsed: started.elapsed(),
    })
}

pub(crate) async fn drain_all_shards_with<D, DFut>(
    shard_count: usize,
    concurrency: usize,
    drain: D,
) -> Result<Vec<ShardDrainReport>>
where
    D: Fn(usize) -> DFut + Clone,
    DFut: Future<Output = Result<ShardDrainReport>>,
{
    if shard_count == 0 {
        anyhow::bail!("shard_count must be greater than zero");
    }
    if concurrency == 0 {
        anyhow::bail!("concurrency must be greater than zero");
    }

    let mut reports = stream::iter(0..shard_count)
        .map(|shard_index| {
            let drain = drain.clone();
            async move {
                let report = drain(shard_index).await?;
                Ok::<_, anyhow::Error>(report)
            }
        })
        .buffer_unordered(concurrency)
        .try_collect::<Vec<_>>()
        .await?;
    reports.sort_by_key(|report| report.shard_index);
    Ok(reports)
}

fn print_dry_run(plan: &WorkPlan, report: &PublishRunReport) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(plan)?);
    println!("[publish-run] dry-run shard work counts");
    for (shard_index, count) in report.shard_counts.iter().enumerate() {
        println!("shard {shard_index}: {count}");
    }
    Ok(())
}

fn print_summary(plan: &WorkPlan, report: &PublishRunReport) {
    if report.dry_run {
        eprintln!(
            "[publish-run] dry-run run={} planned={} shards={} elapsed={:.1}s",
            plan.run_id,
            plan.work.len(),
            plan.shard_count,
            report.elapsed.as_secs_f64()
        );
        return;
    }

    let mut total = ShardDrainReport {
        shard_index: usize::MAX,
        selected: 0,
        processed: 0,
        published: 0,
        fresh: 0,
        failed: 0,
    };
    for shard in &report.shard_reports {
        total.selected += shard.selected;
        total.processed += shard.processed;
        total.published += shard.published;
        total.fresh += shard.fresh;
        total.failed += shard.failed;
        eprintln!(
            "[publish-run] shard={}/{} selected={} processed={} published={} fresh={} failed={}",
            shard.shard_index,
            plan.shard_count,
            shard.selected,
            shard.processed,
            shard.published,
            shard.fresh,
            shard.failed
        );
    }

    if let Some(finalizer) = &report.finalizer_report {
        eprintln!(
            "[publish-run] finalizer deltas={} entries={} changed_shards={} catalog={} refs={}",
            finalizer.deltas_applied,
            finalizer.aggregate_entries,
            finalizer.changed_shards,
            finalizer.catalog_written,
            finalizer.refs_written
        );
    }
    eprintln!(
        "[publish-run] done run={} processed={} published={} fresh={} failed={} elapsed={:.1}s",
        plan.run_id,
        total.processed,
        total.published,
        total.fresh,
        total.failed,
        report.elapsed.as_secs_f64()
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    fn empty_plan(shard_count: usize) -> WorkPlan {
        WorkPlan {
            run_id: "run-test".to_string(),
            generated_at: "2026-07-04T00:00:00Z".to_string(),
            mode: PlanMode::Daily,
            shard_count,
            work: Vec::new(),
        }
    }

    #[tokio::test]
    async fn drain_all_shards_covers_all_indices_and_respects_concurrency() {
        let active = Arc::new(AtomicUsize::new(0));
        let max_active = Arc::new(AtomicUsize::new(0));
        let seen = Arc::new(Mutex::new(Vec::new()));

        let reports = drain_all_shards_with(8, 3, {
            let active = active.clone();
            let max_active = max_active.clone();
            let seen = seen.clone();
            move |shard_index| {
                let active = active.clone();
                let max_active = max_active.clone();
                let seen = seen.clone();
                async move {
                    let now_active = active.fetch_add(1, Ordering::SeqCst) + 1;
                    max_active.fetch_max(now_active, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    seen.lock().expect("seen mutex").push(shard_index);
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok(ShardDrainReport {
                        shard_index,
                        selected: 1,
                        processed: 1,
                        published: 1,
                        fresh: 0,
                        failed: 0,
                    })
                }
            }
        })
        .await
        .expect("drain shards");

        assert_eq!(
            reports
                .iter()
                .map(|report| report.shard_index)
                .collect::<Vec<_>>(),
            (0..8).collect::<Vec<_>>()
        );
        let mut seen = seen.lock().expect("seen mutex").clone();
        seen.sort_unstable();
        assert_eq!(seen, (0..8).collect::<Vec<_>>());
        assert!(max_active.load(Ordering::SeqCst) <= 3);
    }

    #[tokio::test]
    async fn dry_run_skips_drain_and_finalize_writes() {
        let calls = Arc::new(AtomicUsize::new(0));
        let plan = empty_plan(4);

        let report = run_publish_plan_with(
            plan,
            PublishRunDriverConfig {
                shard_count: 4,
                concurrency: 2,
                dry_run: true,
            },
            {
                let calls = calls.clone();
                move |shard_index| {
                    let calls = calls.clone();
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        Ok(ShardDrainReport {
                            shard_index,
                            selected: 0,
                            processed: 0,
                            published: 0,
                            fresh: 0,
                            failed: 0,
                        })
                    }
                }
            },
            {
                let calls = calls.clone();
                move || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    unreachable!("dry-run must not finalize")
                }
            },
        )
        .await
        .expect("dry run");

        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(report.dry_run);
        assert_eq!(report.shard_counts, vec![0, 0, 0, 0]);
        assert!(report.shard_reports.is_empty());
        assert!(report.finalizer_report.is_none());
    }
}
