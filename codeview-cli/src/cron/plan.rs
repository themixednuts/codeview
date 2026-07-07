//! `codeview cron plan` — build a runner-agnostic parse work plan.
//!
//! The plan is a full JSON artifact in local disk or R2. GitHub Actions
//! receives only a compact shard matrix, so job output stays small even
//! when the plan contains thousands of crate work items.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Args, ValueEnum};
use serde::{Deserialize, Serialize};

use crate::publisher::artifacts::normalise_crate_name;
use crate::publisher::crates_dump::{
    self, CrateCandidate, CrateCatalogSnapshot, DEFAULT_DB_DUMP_PATH, DEFAULT_DB_DUMP_URL,
    MetadataSource, SnapshotBuildOptions, SnapshotLoad,
};
use crate::publisher::freshness::Staleness;
use crate::publisher::r2::{self, read_json, write_json};
use crate::publisher::shards;

use super::CronContext;

const DEFAULT_CHANNEL: &str = "default";
const QUEUE_PENDING_PREFIX: &str = "rust/_queue/pending/";

#[derive(Debug, Args)]
pub struct Plan {
    /// Scheduling mode.
    #[arg(long, value_enum, default_value_t = PlanMode::Daily)]
    pub mode: PlanMode,

    /// Corpus source: `queue`, `catalog`, `top:N`, `file:<path>`, `all`, or a file path.
    #[arg(long, default_value = "catalog")]
    pub corpus: String,

    /// Tier shortcut. When present, this overrides `--corpus`.
    #[arg(long, value_enum)]
    pub tier: Option<CorpusTier>,

    /// Number of deterministic worker shards.
    #[arg(long, default_value_t = 1)]
    pub shard_count: usize,

    /// Maximum work items across the full plan.
    #[arg(long)]
    pub max_total: Option<usize>,

    /// Maximum work items assigned to each deterministic shard bucket.
    #[arg(long)]
    pub max_per_shard: Option<usize>,

    /// Include eligible retry work. Retry index support lands in a later step.
    #[arg(long)]
    pub include_retries: bool,

    /// Comma-separated crate names to include regardless of freshness.
    #[arg(long, default_value = "")]
    pub force: String,

    /// Include prerelease versions when refreshing the metadata snapshot.
    #[arg(long)]
    pub include_prerelease: bool,

    /// Plan destination. `r2:<key>`, `r2://<key>`, and `rust/...`
    /// write to R2; other values are local paths.
    #[arg(long)]
    pub plan_out: String,

    /// Matrix destination. Omit to write matrix JSON to stdout. Passing
    /// `$GITHUB_OUTPUT` appends `worker_matrix`, `run_id`, and `shard_count`.
    #[arg(long)]
    pub matrix_out: Option<String>,

    /// R2 bucket.
    #[arg(long, default_value = "crate-graphs")]
    pub bucket: String,

    /// Stable run id. Defaults to `GITHUB_RUN_ID`, then a generated-at timestamp.
    #[arg(long)]
    pub run_id: Option<String>,

    /// RFC3339 timestamp used for deterministic plan generation and fallback run ids.
    #[arg(long)]
    pub generated_at: Option<String>,

    /// Bulk metadata source. `db-dump` is the production path.
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

    /// Suppress human-readable logs.
    #[arg(long)]
    pub quiet: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlanMode {
    Daily,
    Backfill,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum CorpusTier {
    Std,
    #[value(name = "top-500")]
    Top500,
    #[value(name = "top-5000")]
    Top5000,
    Full,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkPlan {
    pub run_id: String,
    pub generated_at: String,
    pub mode: PlanMode,
    pub shard_count: usize,
    pub work: Vec<WorkItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkItem {
    pub work_id: String,
    pub kind: WorkKind,
    pub name: String,
    pub version: String,
    pub channel: String,
    pub priority_tier: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_rank: Option<u32>,
    pub reason: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorkKind {
    Crate,
    Std,
}

#[derive(Debug, Serialize, Deserialize)]
struct ShardMatrix {
    include: Vec<ShardMatrixEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ShardMatrixEntry {
    shard_index: usize,
}

#[derive(Debug, Deserialize)]
struct CatalogFile {
    crates: Vec<CatalogCrate>,
}

#[derive(Debug, Deserialize)]
struct CatalogCrate {
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueueItemFile {
    #[serde(default)]
    schema_version: u32,
    name: String,
    version: String,
    #[serde(default)]
    force: bool,
}

#[derive(Debug, Clone)]
struct SelectedCandidate {
    candidate: CrateCandidate,
    forced: bool,
    requested_version: Option<String>,
    queued: bool,
}

#[derive(Debug, Clone)]
struct EvaluatedCandidate {
    candidate: CrateCandidate,
    version: String,
    staleness: Staleness,
    forced: bool,
    queued: bool,
}

#[derive(Debug, Clone)]
struct PlanAssembly {
    run_id: String,
    generated_at: String,
    mode: PlanMode,
    shard_count: usize,
    max_total: Option<usize>,
    max_per_shard: Option<usize>,
}

#[derive(Debug, Clone)]
pub(crate) struct PlanBuildConfig {
    pub(crate) mode: PlanMode,
    pub(crate) corpus: String,
    pub(crate) tier: Option<CorpusTier>,
    pub(crate) shard_count: usize,
    pub(crate) max_total: Option<usize>,
    pub(crate) max_per_shard: Option<usize>,
    pub(crate) include_retries: bool,
    pub(crate) force_names: HashSet<String>,
    pub(crate) force_all: bool,
    pub(crate) include_prerelease: bool,
    pub(crate) plan_out: Option<String>,
    pub(crate) run_id: Option<String>,
    pub(crate) generated_at: Option<String>,
    pub(crate) metadata_source: MetadataSource,
    pub(crate) db_dump_url: String,
    pub(crate) db_dump_path: PathBuf,
    pub(crate) metadata_max_age_hours: u64,
    pub(crate) quiet: bool,
}

impl PlanBuildConfig {
    fn from_args(args: &Plan) -> Self {
        Self {
            mode: args.mode,
            corpus: args.corpus.clone(),
            tier: args.tier,
            shard_count: args.shard_count,
            max_total: args.max_total,
            max_per_shard: args.max_per_shard,
            include_retries: args.include_retries,
            force_names: parse_force(&args.force),
            force_all: false,
            include_prerelease: args.include_prerelease,
            plan_out: Some(args.plan_out.clone()),
            run_id: args.run_id.clone(),
            generated_at: args.generated_at.clone(),
            metadata_source: args.metadata_source,
            db_dump_url: args.db_dump_url.clone(),
            db_dump_path: args.db_dump_path.clone(),
            metadata_max_age_hours: args.metadata_max_age_hours,
            quiet: args.quiet,
        }
    }

    fn log(&self, message: impl AsRef<str>) {
        if !self.quiet {
            eprintln!("{}", message.as_ref());
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PriorityTier {
    Forced,
    Queued,
    TopDownloadStale,
    NewerVersion,
    CatalogStale,
    CatalogNewer,
    NeverParsedBackfill,
    LongTailBackfill,
}

impl PriorityTier {
    fn sort_rank(self) -> u8 {
        match self {
            Self::Forced => 0,
            Self::Queued => 1,
            Self::TopDownloadStale => 2,
            Self::NewerVersion => 3,
            Self::CatalogStale => 4,
            Self::CatalogNewer => 5,
            Self::NeverParsedBackfill => 7,
            Self::LongTailBackfill => 8,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Forced => "forced",
            Self::Queued => "queued",
            Self::TopDownloadStale => "top-download-stale",
            Self::NewerVersion => "newer-version",
            Self::CatalogStale => "catalog-stale",
            Self::CatalogNewer => "catalog-newer",
            Self::NeverParsedBackfill => "never-parsed-backfill",
            Self::LongTailBackfill => "long-tail-backfill",
        }
    }
}

enum PlanDestination {
    Local(PathBuf),
    R2(String),
}

pub async fn run(args: Plan) -> Result<()> {
    let ctx = CronContext::build(&args.bucket).await?;
    let matrix_out = args.matrix_out.clone();
    let plan = build_plan(&ctx, PlanBuildConfig::from_args(&args)).await?;
    let matrix = shard_matrix(plan.shard_count);
    write_matrix(matrix_out.as_deref(), &matrix, &plan)?;
    Ok(())
}

pub(crate) async fn build_plan(ctx: &CronContext, config: PlanBuildConfig) -> Result<WorkPlan> {
    if config.shard_count == 0 {
        anyhow::bail!("--shard-count must be greater than zero");
    }
    if config.metadata_source != MetadataSource::DbDump {
        anyhow::bail!(
            "--metadata-source {:?} is accepted by the CLI but only db-dump snapshots are implemented for plan",
            config.metadata_source
        );
    }
    if matches!(config.tier, Some(CorpusTier::Std)) {
        config.log("[plan] --tier std is accepted but std parsing is still handled by seed-std");
    }
    if config.include_retries {
        config.log(
            "[plan] --include-retries is accepted; retry index support lands with freshness-merge",
        );
    }

    let generated_at = config
        .generated_at
        .clone()
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
    let run_id = config
        .run_id
        .clone()
        .or_else(|| std::env::var("GITHUB_RUN_ID").ok())
        .unwrap_or_else(|| format!("local-{}", sanitise_run_id_timestamp(&generated_at)));

    config.log(format!(
        "[plan] parser={} schema=v{} mode={:?} shards={}",
        ctx.parser_revision_short(),
        codeview_core::SCHEMA_VERSION,
        config.mode,
        config.shard_count,
    ));

    let metadata_http = crates_dump::http_client()?;
    let snapshot_path = crates_dump::snapshot_path_for_dump(&config.db_dump_path);
    let snapshot_options = SnapshotBuildOptions {
        include_prerelease: config.include_prerelease,
    };
    let (snapshot, load) = crates_dump::load_or_refresh_snapshot(
        &metadata_http,
        &config.db_dump_url,
        &config.db_dump_path,
        &snapshot_path,
        snapshot_options,
        crates_dump::max_age_duration(config.metadata_max_age_hours),
    )
    .await?;
    match load {
        SnapshotLoad::ReusedSnapshot => {
            config.log(format!(
                "[plan] metadata reused {}",
                snapshot_path.display()
            ));
        }
        SnapshotLoad::BuiltFromDump => {
            config.log(format!(
                "[plan] metadata built {} crates from {}",
                snapshot.crates.len(),
                config.db_dump_path.display()
            ));
        }
    }

    let corpus_names = resolve_corpus_names(&config, ctx, &snapshot).await?;
    let mut selected = selected_candidates(
        &snapshot,
        &corpus_names,
        &config.force_names,
        config.force_all,
    );
    if config.corpus == "queue" {
        selected.extend(
            resolve_queue_candidates(ctx, &snapshot, &config.force_names, config.force_all).await?,
        );
    }
    let mut evaluated = Vec::with_capacity(selected.len());
    for item in selected {
        let Some(version) = item
            .requested_version
            .clone()
            .or_else(|| item.candidate.newest_non_yanked.clone())
        else {
            config.log(format!(
                "[plan] snapshot has no non-yanked version: {}",
                item.candidate.name
            ));
            continue;
        };
        let staleness = ctx
            .freshness
            .check(
                &normalise_crate_name(&item.candidate.name),
                &version,
                &ctx.parser_revision,
                codeview_core::SCHEMA_VERSION,
            )
            .await?;
        evaluated.push(EvaluatedCandidate {
            candidate: item.candidate,
            version,
            staleness,
            forced: item.forced,
            queued: item.queued,
        });
    }

    let plan = assemble_work_plan(
        PlanAssembly {
            run_id,
            generated_at,
            mode: config.mode,
            shard_count: config.shard_count,
            max_total: config.max_total,
            max_per_shard: config.max_per_shard,
        },
        evaluated,
    )?;

    let wrote_plan = config.plan_out.is_some();
    if let Some(plan_out) = config.plan_out.as_deref() {
        write_plan(ctx, plan_out, &plan).await?;
    }

    config.log(format!(
        "[plan] {} {} work items across {} shards",
        if wrote_plan { "wrote" } else { "built" },
        plan.work.len(),
        plan.shard_count
    ));
    Ok(plan)
}

async fn resolve_corpus_names(
    config: &PlanBuildConfig,
    ctx: &CronContext,
    snapshot: &CrateCatalogSnapshot,
) -> Result<Vec<String>> {
    if let Some(tier) = config.tier {
        return match tier {
            CorpusTier::Std => Ok(Vec::new()),
            CorpusTier::Top500 => Ok(snapshot
                .crates
                .iter()
                .take(500)
                .map(|candidate| candidate.name.clone())
                .collect()),
            CorpusTier::Top5000 => Ok(snapshot
                .crates
                .iter()
                .take(5000)
                .map(|candidate| candidate.name.clone())
                .collect()),
            CorpusTier::Full => Ok(snapshot
                .crates
                .iter()
                .map(|candidate| candidate.name.clone())
                .collect()),
        };
    }

    if config.corpus == "queue" {
        return Ok(Vec::new());
    }
    if config.corpus == "catalog" {
        let Some(catalog) = read_json::<CatalogFile>(&ctx.r2, r2::CATALOG_KEY).await? else {
            return Ok(Vec::new());
        };
        return Ok(catalog.crates.into_iter().map(|entry| entry.name).collect());
    }
    if config.corpus == "all" {
        return Ok(snapshot
            .crates
            .iter()
            .map(|candidate| candidate.name.clone())
            .collect());
    }
    if let Some(n_str) = config.corpus.strip_prefix("top:") {
        let n: usize = n_str.parse().context("parse --corpus top:N")?;
        return Ok(snapshot
            .crates
            .iter()
            .take(n)
            .map(|candidate| candidate.name.clone())
            .collect());
    }
    let path = config
        .corpus
        .strip_prefix("file:")
        .unwrap_or(config.corpus.as_str());
    read_name_file(path)
}

fn selected_candidates(
    snapshot: &CrateCatalogSnapshot,
    corpus_names: &[String],
    force_names: &HashSet<String>,
    force_all: bool,
) -> Vec<SelectedCandidate> {
    let by_name: HashMap<String, &CrateCandidate> = snapshot
        .crates
        .iter()
        .map(|candidate| (normalise_crate_name(&candidate.name), candidate))
        .collect();
    let mut seen = HashSet::<String>::new();
    let mut selected = Vec::new();

    for name in corpus_names {
        let lookup = normalise_crate_name(name);
        if !seen.insert(lookup.clone()) {
            continue;
        }
        if let Some(candidate) = by_name.get(&lookup) {
            selected.push(SelectedCandidate {
                candidate: (*candidate).clone(),
                forced: force_all || force_names.contains(&lookup),
                requested_version: None,
                queued: false,
            });
        }
    }

    for forced in force_names {
        if seen.contains(forced) {
            continue;
        }
        if let Some(candidate) = by_name.get(forced) {
            seen.insert(forced.clone());
            selected.push(SelectedCandidate {
                candidate: (*candidate).clone(),
                forced: true,
                requested_version: None,
                queued: false,
            });
        }
    }

    selected
}

async fn resolve_queue_candidates(
    ctx: &CronContext,
    snapshot: &CrateCatalogSnapshot,
    force_names: &HashSet<String>,
    force_all: bool,
) -> Result<Vec<SelectedCandidate>> {
    let by_name: HashMap<String, &CrateCandidate> = snapshot
        .crates
        .iter()
        .map(|candidate| (normalise_crate_name(&candidate.name), candidate))
        .collect();
    let mut keys = ctx.r2.list_prefix(QUEUE_PENDING_PREFIX).await?;
    keys.retain(|key| key.ends_with(".json"));
    keys.sort();

    let mut seen = HashSet::<String>::new();
    let mut selected = Vec::new();
    for key in keys {
        let Some(item) = read_json::<QueueItemFile>(&ctx.r2, &key).await? else {
            continue;
        };
        if !is_valid_queue_item(&item) {
            continue;
        }
        let lookup = normalise_crate_name(&item.name);
        let dedupe_key = format!("{lookup}@{}", item.version);
        if !seen.insert(dedupe_key) {
            continue;
        }

        let candidate = by_name
            .get(&lookup)
            .map(|candidate| (*candidate).clone())
            .unwrap_or_else(|| CrateCandidate {
                name: item.name.clone(),
                newest_non_yanked: Some(item.version.clone()),
                newest_pubtime: None,
                all_time_downloads: 0,
                recent_downloads: None,
                all_time_rank: None,
                recent_rank: None,
            });
        selected.push(SelectedCandidate {
            candidate,
            forced: force_all || item.force || force_names.contains(&lookup),
            requested_version: Some(item.version),
            queued: true,
        });
    }
    Ok(selected)
}

fn is_valid_queue_item(item: &QueueItemFile) -> bool {
    let _schema = item.schema_version;
    !item.name.trim().is_empty() && !item.version.trim().is_empty()
}

fn assemble_work_plan(
    options: PlanAssembly,
    evaluated: Vec<EvaluatedCandidate>,
) -> Result<WorkPlan> {
    if options.shard_count == 0 {
        anyhow::bail!("shard_count must be greater than zero");
    }

    let mut planned = Vec::<(PriorityTier, WorkItem)>::new();
    for item in evaluated {
        let Some(priority) = priority_for(&item, options.mode) else {
            continue;
        };
        let canonical_name = normalise_crate_name(&item.candidate.name);
        let work_id = shards::work_id("crate", &canonical_name, &item.version, DEFAULT_CHANNEL);
        planned.push((
            priority,
            WorkItem {
                work_id,
                kind: WorkKind::Crate,
                name: item.candidate.name,
                version: item.version,
                channel: DEFAULT_CHANNEL.to_string(),
                priority_tier: priority.as_str().to_string(),
                download_rank: item.candidate.all_time_rank,
                reason: reason_for(item.forced, item.queued, &item.staleness),
            },
        ));
    }

    planned.sort_by(|(left_priority, left), (right_priority, right)| {
        left_priority
            .sort_rank()
            .cmp(&right_priority.sort_rank())
            .then_with(|| {
                left.download_rank
                    .unwrap_or(u32::MAX)
                    .cmp(&right.download_rank.unwrap_or(u32::MAX))
            })
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| left.version.cmp(&right.version))
    });

    let mut per_shard = vec![0usize; options.shard_count];
    let mut work = Vec::new();
    for (_, item) in planned {
        let bucket = shards::work_bucket(&item.work_id, options.shard_count);
        if let Some(max_per_shard) = options.max_per_shard
            && per_shard[bucket] >= max_per_shard
        {
            continue;
        }
        per_shard[bucket] += 1;
        work.push(item);
        if let Some(max_total) = options.max_total
            && work.len() >= max_total
        {
            break;
        }
    }

    Ok(WorkPlan {
        run_id: options.run_id,
        generated_at: options.generated_at,
        mode: options.mode,
        shard_count: options.shard_count,
        work,
    })
}

fn priority_for(item: &EvaluatedCandidate, mode: PlanMode) -> Option<PriorityTier> {
    if item.forced {
        return Some(PriorityTier::Forced);
    }
    if item.queued && item.staleness.is_stale() {
        return Some(PriorityTier::Queued);
    }

    let is_top_download = item
        .candidate
        .all_time_rank
        .is_some_and(|rank| rank <= 5_000);
    match item.staleness {
        Staleness::Fresh => None,
        Staleness::ParserRevisionChanged { .. } | Staleness::SchemaVersionChanged { .. } => {
            Some(if is_top_download {
                PriorityTier::TopDownloadStale
            } else {
                PriorityTier::CatalogStale
            })
        }
        Staleness::NewerVersion { .. } => Some(if is_top_download {
            PriorityTier::NewerVersion
        } else {
            PriorityTier::CatalogNewer
        }),
        Staleness::NeverParsed => Some(if mode == PlanMode::Backfill && !is_top_download {
            PriorityTier::LongTailBackfill
        } else {
            PriorityTier::NeverParsedBackfill
        }),
    }
}

fn reason_for(forced: bool, queued: bool, staleness: &Staleness) -> String {
    if forced {
        format!("forced (otherwise: {})", staleness.describe())
    } else if queued {
        format!("queued ({})", staleness.describe())
    } else {
        staleness.describe()
    }
}

fn shard_matrix(shard_count: usize) -> ShardMatrix {
    ShardMatrix {
        include: (0..shard_count)
            .map(|shard_index| ShardMatrixEntry { shard_index })
            .collect(),
    }
}

async fn write_plan(ctx: &CronContext, raw: &str, plan: &WorkPlan) -> Result<()> {
    match parse_destination(raw) {
        PlanDestination::Local(path) => {
            if let Some(parent) = path.parent()
                && !parent.as_os_str().is_empty()
            {
                fs::create_dir_all(parent)
                    .with_context(|| format!("create {}", parent.display()))?;
            }
            let bytes = serde_json::to_vec_pretty(plan)?;
            fs::write(&path, bytes).with_context(|| format!("write {}", path.display()))?;
        }
        PlanDestination::R2(key) => {
            write_json(&ctx.r2, &key, plan).await?;
        }
    }
    Ok(())
}

fn write_matrix(path: Option<&str>, matrix: &ShardMatrix, plan: &WorkPlan) -> Result<()> {
    let json = serde_json::to_string(matrix)?;
    let Some(raw_path) = path else {
        println!("{json}");
        return Ok(());
    };

    let github_output = if raw_path == "$GITHUB_OUTPUT" {
        std::env::var("GITHUB_OUTPUT").ok()
    } else {
        std::env::var("GITHUB_OUTPUT")
            .ok()
            .filter(|env_path| env_path == raw_path)
    };

    if let Some(out_path) = github_output {
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&out_path)
            .with_context(|| format!("open GITHUB_OUTPUT={out_path}"))?;
        writeln!(f, "worker_matrix={json}")?;
        writeln!(f, "run_id={}", plan.run_id)?;
        writeln!(f, "shard_count={}", plan.shard_count)?;
        return Ok(());
    }

    fs::write(raw_path, json).with_context(|| format!("write {raw_path}"))
}

fn parse_destination(raw: &str) -> PlanDestination {
    if let Some(key) = raw.strip_prefix("r2://") {
        return PlanDestination::R2(key.to_string());
    }
    if let Some(key) = raw.strip_prefix("r2:") {
        return PlanDestination::R2(key.to_string());
    }
    if raw.starts_with("rust/") {
        return PlanDestination::R2(raw.to_string());
    }
    PlanDestination::Local(PathBuf::from(raw))
}

fn read_name_file(path: &str) -> Result<Vec<String>> {
    Ok(fs::read_to_string(path)
        .with_context(|| format!("read corpus file {path}"))?
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(ToString::to_string)
        .collect())
}

fn parse_force(raw: &str) -> HashSet<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(normalise_crate_name)
        .collect()
}

fn sanitise_run_id_timestamp(generated_at: &str) -> String {
    generated_at
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' {
                ch
            } else {
                '-'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::publisher::crates_dump::{CrateCatalogSource, MetadataSource, RankMode};

    fn candidate(name: &str, version: &str, downloads: u64, rank: u32) -> CrateCandidate {
        CrateCandidate {
            name: name.to_string(),
            newest_non_yanked: Some(version.to_string()),
            newest_pubtime: None,
            all_time_downloads: downloads,
            recent_downloads: None,
            all_time_rank: Some(rank),
            recent_rank: None,
        }
    }

    fn snapshot() -> CrateCatalogSnapshot {
        CrateCatalogSnapshot {
            schema_version: 1,
            generated_at: "2026-07-04T00:00:00Z".to_string(),
            include_prerelease: false,
            source: CrateCatalogSource {
                kind: MetadataSource::DbDump,
                url: None,
                cache_path: None,
                etag: None,
                last_modified: None,
                checked_at: None,
            },
            rank: RankMode::AllTime,
            crates: vec![
                candidate("alpha", "1.0.0", 500, 1),
                candidate("beta", "2.0.0", 400, 2),
                candidate("gamma", "3.0.0", 300, 3),
                candidate("delta", "4.0.0", 200, 4),
                candidate("epsilon", "5.0.0", 100, 5),
            ],
        }
    }

    #[test]
    fn plan_selection_priority_and_total_cap_are_deterministic() {
        let snapshot = snapshot();
        let corpus = vec![
            "alpha".to_string(),
            "beta".to_string(),
            "gamma".to_string(),
            "delta".to_string(),
            "epsilon".to_string(),
        ];
        let force = parse_force("alpha");
        let selected = selected_candidates(&snapshot, &corpus, &force, false);
        let freshness = HashMap::from([
            ("alpha", Staleness::Fresh),
            (
                "beta",
                Staleness::ParserRevisionChanged {
                    recorded: "old".to_string(),
                    current: "new".to_string(),
                },
            ),
            (
                "gamma",
                Staleness::NewerVersion {
                    observed: "3.0.0".to_string(),
                    recorded: "2.9.0".to_string(),
                },
            ),
            ("delta", Staleness::NeverParsed),
            ("epsilon", Staleness::Fresh),
        ]);
        let evaluated: Vec<EvaluatedCandidate> = selected
            .into_iter()
            .map(|item| {
                let version = item.candidate.newest_non_yanked.clone().unwrap();
                let staleness = freshness[item.candidate.name.as_str()].clone();
                EvaluatedCandidate {
                    candidate: item.candidate,
                    version,
                    staleness,
                    forced: item.forced,
                    queued: item.queued,
                }
            })
            .collect();

        let plan = assemble_work_plan(
            PlanAssembly {
                run_id: "run-123".to_string(),
                generated_at: "2026-07-04T00:00:00Z".to_string(),
                mode: PlanMode::Daily,
                shard_count: 4,
                max_total: Some(3),
                max_per_shard: None,
            },
            evaluated,
        )
        .unwrap();

        assert_eq!(
            plan.work
                .iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            vec!["alpha", "beta", "gamma"]
        );
        assert_eq!(plan.work[0].priority_tier, "forced");
        assert_eq!(plan.work[1].priority_tier, "top-download-stale");
        assert_eq!(plan.work[2].priority_tier, "newer-version");
        assert_eq!(plan.work[0].work_id, "crate:alpha:1.0.0:default");
    }
}
