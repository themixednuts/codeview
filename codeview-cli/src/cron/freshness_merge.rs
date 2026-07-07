//! `codeview cron freshness-merge` — single-writer freshness finalizer.
//!
//! Parse workers append JSONL deltas under `rust/_runs/{run}/deltas/`.
//! This command runs once after all workers finish. It reads the previous
//! aggregate, applies this run's deltas in memory, writes changed shard
//! objects, emits read-side catalog/ref files, and writes
//! `rust/_index/_manifest.json` last. There is intentionally no locking:
//! the driver/workflow owns the single-writer guarantee.
//!
//! Aggregate shard assignment uses the existing FNV-1a 32-bit hash family:
//! `fnv1a32(crate_name) % shardCount`. Shard ids are zero-padded hex, so
//! the default 256 shards are `00` through `ff`.

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use anyhow::{Context, Result};
use clap::Args;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::publisher::artifacts::{hyphenate_crate_name, normalise_crate_name};
use crate::publisher::freshness::{FreshnessEntry, FreshnessRegistry, Source};
use crate::publisher::r2::{
    CATALOG_KEY, INDEX_MANIFEST_KEY, R2, index_generation_shard_key, read_json, refs_key,
    run_delta_prefix, write_json,
};
use crate::publisher::shards;

use super::CronContext;
use super::catalog::{self, CatalogEntry};
use super::parse_shard::{RunDelta, RunDeltaOutcome};

const AGGREGATE_SCHEMA_VERSION: u32 = 1;
const REF_SCHEMA_VERSION: u32 = 1;
const DEFAULT_INDEX_SHARDS: usize = 256;
const JSON: &str = "application/json; charset=utf-8";

#[derive(Debug, Args)]
pub struct FreshnessMerge {
    /// Run id whose append-only deltas should be merged.
    #[arg(long)]
    pub run_id: String,

    /// Prefix containing JSONL deltas. Defaults to `rust/_runs/<run-id>/`.
    #[arg(long)]
    pub delta_prefix: Option<String>,

    /// Aggregate shard count. Defaults to 256.
    #[arg(long, default_value_t = DEFAULT_INDEX_SHARDS)]
    pub index_shards: usize,

    /// Emit `rust/catalog.json` from the merged aggregate.
    #[arg(long)]
    pub write_catalog: bool,

    /// Emit `rust/_refs/{storageName}.json`. Default on.
    #[arg(long, default_value_t = true, action = clap::ArgAction::SetTrue)]
    pub write_refs: bool,

    /// Disable `_refs` emission while keeping `--write-refs` default-on.
    #[arg(long)]
    pub no_write_refs: bool,

    /// Initialize the aggregate from per-crate freshness files.
    #[arg(long)]
    pub bootstrap: bool,

    /// Generation id for new changed shards and the manifest pointer.
    #[arg(long)]
    pub generation: Option<String>,

    /// RFC3339 timestamp for deterministic tests and reproducible runs.
    #[arg(long)]
    pub generated_at: Option<String>,

    /// R2 bucket.
    #[arg(long, default_value = "crate-graphs")]
    pub bucket: String,
}

pub async fn run(args: FreshnessMerge) -> Result<()> {
    let ctx = CronContext::build(&args.bucket).await?;
    let report = finalize(
        &ctx,
        FinalizeConfig {
            run_id: args.run_id.clone(),
            delta_prefix: args
                .delta_prefix
                .clone()
                .unwrap_or_else(|| run_delta_prefix(&args.run_id)),
            index_shards: args.index_shards,
            write_catalog: args.write_catalog,
            write_refs: args.write_refs && !args.no_write_refs,
            bootstrap: args.bootstrap,
            generation: args.generation.clone().unwrap_or(args.run_id),
            generated_at: args
                .generated_at
                .clone()
                .unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
        },
    )
    .await?;
    eprintln!(
        "[freshness-merge] run={} deltas={} entries={} changed_shards={} catalog={} refs={} manifest={}",
        report.run_id,
        report.deltas_applied,
        report.aggregate_entries,
        report.changed_shards,
        report.catalog_written,
        report.refs_written,
        INDEX_MANIFEST_KEY,
    );
    Ok(())
}

#[derive(Debug, Clone)]
pub(crate) struct FinalizeConfig {
    pub(crate) run_id: String,
    pub(crate) delta_prefix: String,
    pub(crate) index_shards: usize,
    pub(crate) write_catalog: bool,
    pub(crate) write_refs: bool,
    pub(crate) bootstrap: bool,
    pub(crate) generation: String,
    pub(crate) generated_at: String,
}

pub(crate) async fn finalize(
    ctx: &CronContext,
    config: FinalizeConfig,
) -> Result<FreshnessMergeReport> {
    let config = FreshnessMergeConfig {
        run_id: config.run_id,
        delta_prefix: config.delta_prefix,
        index_shards: config.index_shards,
        write_catalog: config.write_catalog,
        write_refs: config.write_refs,
        bootstrap: config.bootstrap,
        generation: config.generation,
        generated_at: config.generated_at,
        parser_revision: ctx.parser_revision.clone(),
        graph_schema_version: codeview_core::SCHEMA_VERSION,
    };
    merge(ctx.r2.clone(), &ctx.freshness, config).await
}

#[derive(Debug, Clone)]
pub(crate) struct FreshnessMergeConfig {
    pub(crate) run_id: String,
    pub(crate) delta_prefix: String,
    pub(crate) index_shards: usize,
    pub(crate) write_catalog: bool,
    pub(crate) write_refs: bool,
    pub(crate) bootstrap: bool,
    pub(crate) generation: String,
    pub(crate) generated_at: String,
    pub(crate) parser_revision: String,
    pub(crate) graph_schema_version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FreshnessMergeReport {
    pub(crate) run_id: String,
    pub(crate) deltas_applied: usize,
    pub(crate) aggregate_entries: usize,
    pub(crate) changed_shards: usize,
    pub(crate) catalog_written: bool,
    pub(crate) refs_written: usize,
}

pub(crate) async fn merge(
    r2: Arc<dyn R2>,
    freshness: &FreshnessRegistry,
    config: FreshnessMergeConfig,
) -> Result<FreshnessMergeReport> {
    if config.index_shards == 0 {
        anyhow::bail!("--index-shards must be greater than zero");
    }

    let loaded = load_current_aggregate(&r2, freshness, config.bootstrap).await?;
    let deltas = read_run_deltas(&r2, &config.delta_prefix).await?;
    let mut entries = loaded.entries;
    for delta in &deltas {
        apply_delta(freshness, &mut entries, delta, &config).await?;
    }

    let write_result = write_aggregate_outputs(&r2, &entries, loaded.manifest.as_ref(), &config)
        .await
        .context("write aggregate outputs")?;

    Ok(FreshnessMergeReport {
        run_id: config.run_id,
        deltas_applied: deltas.len(),
        aggregate_entries: entries.len(),
        changed_shards: write_result.changed_shards,
        catalog_written: config.write_catalog,
        refs_written: write_result.refs_written,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AggregateManifest {
    pub(crate) schema: u32,
    pub(crate) generation: String,
    pub(crate) generated_at: String,
    pub(crate) parser_revision: String,
    pub(crate) graph_schema_version: u32,
    pub(crate) shard_count: usize,
    pub(crate) shards: Vec<AggregateManifestShard>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct AggregateManifestShard {
    pub(crate) id: String,
    pub(crate) key: String,
    pub(crate) sha256: String,
    pub(crate) count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct AggregateShard {
    pub(crate) schema: u32,
    pub(crate) shard: String,
    pub(crate) entries: BTreeMap<String, AggregateEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AggregateEntry {
    pub(crate) name: String,
    pub(crate) storage_name: String,
    pub(crate) version: String,
    pub(crate) parsed_at: String,
    pub(crate) source: Source,
    pub(crate) parser_revision: String,
    pub(crate) schema_version: u32,
    pub(crate) graph_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) rustdoc_hash: Option<String>,
    pub(crate) nodes: usize,
    pub(crate) edges: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) priority_tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) download_rank: Option<u32>,
    pub(crate) failure: Option<AggregateFailure>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AggregateFailure {
    pub(crate) outcome: RunDeltaOutcome,
    pub(crate) error: String,
    pub(crate) last_attempt_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CrateRefFile {
    pub(crate) schema_version: u32,
    pub(crate) storage_name: String,
    pub(crate) display_name: String,
    pub(crate) aliases: BTreeMap<String, CrateRefAlias>,
    pub(crate) versions: Vec<CrateRefVersion>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CrateRefAlias {
    pub(crate) version: String,
    pub(crate) graph_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CrateRefVersion {
    pub(crate) version: String,
    pub(crate) graph_hash: String,
    pub(crate) parsed_at: String,
    pub(crate) nodes: usize,
    pub(crate) edges: usize,
}

struct LoadedAggregate {
    manifest: Option<AggregateManifest>,
    entries: BTreeMap<String, AggregateEntry>,
}

struct WriteResult {
    changed_shards: usize,
    refs_written: usize,
}

async fn load_current_aggregate(
    r2: &Arc<dyn R2>,
    freshness: &FreshnessRegistry,
    bootstrap: bool,
) -> Result<LoadedAggregate> {
    if !bootstrap
        && let Some(manifest) = read_json::<AggregateManifest>(r2, INDEX_MANIFEST_KEY).await?
    {
        eprintln!(
            "[freshness-merge] loading aggregate generation={} shards={}",
            manifest.generation, manifest.shard_count,
        );
        let mut entries = BTreeMap::new();
        for shard_ref in &manifest.shards {
            let shard: AggregateShard = read_json(r2, &shard_ref.key)
                .await?
                .with_context(|| format!("aggregate shard missing: {}", shard_ref.key))?;
            for (_key, entry) in shard.entries {
                entries.insert(aggregate_key(&entry.name, &entry.version), entry);
            }
        }
        return Ok(LoadedAggregate {
            manifest: Some(manifest),
            entries,
        });
    }

    if !bootstrap {
        anyhow::bail!(
            "aggregate manifest missing at {INDEX_MANIFEST_KEY}; rerun with --bootstrap to initialize from per-crate freshness files"
        );
    }

    eprintln!("[freshness-merge] bootstrap: loading per-crate freshness files");
    let entries = freshness
        .list_all()
        .await?
        .into_iter()
        .map(AggregateEntry::from_freshness)
        .map(|entry| (aggregate_key(&entry.name, &entry.version), entry))
        .collect();
    Ok(LoadedAggregate {
        manifest: None,
        entries,
    })
}

async fn read_run_deltas(r2: &Arc<dyn R2>, prefix: &str) -> Result<Vec<RunDelta>> {
    let mut keys = r2.list_prefix(prefix).await?;
    keys.retain(|key| key.ends_with(".jsonl"));
    keys.sort();

    let mut out = Vec::new();
    for key in keys {
        let Some(bytes) = r2.get(&key).await? else {
            continue;
        };
        let text = String::from_utf8(bytes).with_context(|| format!("decode JSONL {key}"))?;
        for (line_index, line) in text.lines().enumerate() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let delta: RunDelta = serde_json::from_str(line)
                .with_context(|| format!("parse {key}:{}", line_index + 1))?;
            out.push(delta);
        }
    }
    Ok(out)
}

async fn apply_delta(
    freshness: &FreshnessRegistry,
    entries: &mut BTreeMap<String, AggregateEntry>,
    delta: &RunDelta,
    config: &FreshnessMergeConfig,
) -> Result<()> {
    let canonical_name = normalise_crate_name(&delta.name);
    let key = aggregate_key(&canonical_name, &delta.version);
    match delta.outcome {
        RunDeltaOutcome::Published | RunDeltaOutcome::ParserBumped | RunDeltaOutcome::Fresh => {
            let previous = entries.get(&key).cloned();
            let mut entry =
                if let Some(latest) = freshness.version(&canonical_name, &delta.version).await? {
                    AggregateEntry::from_freshness(latest)
                } else if let Some(mut entry) = previous.clone() {
                    entry.apply_success_delta(delta, config);
                    entry
                } else {
                    AggregateEntry::placeholder(delta, &canonical_name, config)
                };
            entry.apply_enrichment(delta, previous.as_ref());
            entry.failure = None;
            entries.insert(aggregate_key(&entry.name, &entry.version), entry);
        }
        RunDeltaOutcome::Transient | RunDeltaOutcome::Permanent | RunDeltaOutcome::Quarantine => {
            let previous = entries.get(&key).cloned();
            let mut entry = if let Some(entry) = previous.clone() {
                entry
            } else if let Some(latest) = freshness.version(&canonical_name, &delta.version).await? {
                AggregateEntry::from_freshness(latest)
            } else {
                AggregateEntry::placeholder(delta, &canonical_name, config)
            };
            entry.apply_enrichment(delta, previous.as_ref());
            entry.failure = Some(AggregateFailure {
                outcome: delta.outcome,
                error: delta.error.clone().unwrap_or_default(),
                last_attempt_at: config.generated_at.clone(),
            });
            entries.insert(aggregate_key(&entry.name, &entry.version), entry);
        }
    }
    Ok(())
}

async fn write_aggregate_outputs(
    r2: &Arc<dyn R2>,
    entries: &BTreeMap<String, AggregateEntry>,
    previous_manifest: Option<&AggregateManifest>,
    config: &FreshnessMergeConfig,
) -> Result<WriteResult> {
    let shards_by_id = partition_entries(entries, config.index_shards);
    let previous_shards = reusable_manifest_shards(previous_manifest, config.index_shards);

    let mut changed_shards = 0usize;
    let mut manifest_shards = Vec::with_capacity(config.index_shards);
    for (shard_id, shard_entries) in shards_by_id {
        let shard = AggregateShard {
            schema: AGGREGATE_SCHEMA_VERSION,
            shard: shard_id.clone(),
            entries: shard_entries,
        };
        let bytes = serde_json::to_vec(&shard)?;
        let sha256 = sha256_hex(&bytes);
        let count = shard.entries.len();

        if let Some(existing) = previous_shards.get(&shard_id)
            && existing.sha256 == sha256
            && existing.count == count
        {
            manifest_shards.push((*existing).clone());
            continue;
        }

        let key = index_generation_shard_key(&config.generation, &shard_id);
        r2.put(&key, bytes, JSON)
            .await
            .with_context(|| format!("write aggregate shard {key}"))?;
        changed_shards += 1;
        manifest_shards.push(AggregateManifestShard {
            id: shard_id,
            key,
            sha256,
            count,
        });
    }

    if config.write_catalog {
        let catalog = catalog_from_aggregate(entries, config.generated_at.clone());
        write_json(r2, CATALOG_KEY, &catalog)
            .await
            .context("write catalog")?;
    }

    let refs_written = if config.write_refs {
        write_refs(r2, entries).await.context("write refs")?
    } else {
        0
    };

    let manifest = AggregateManifest {
        schema: AGGREGATE_SCHEMA_VERSION,
        generation: config.generation.clone(),
        generated_at: config.generated_at.clone(),
        parser_revision: config.parser_revision.clone(),
        graph_schema_version: config.graph_schema_version,
        shard_count: config.index_shards,
        shards: manifest_shards,
    };
    write_json(r2, INDEX_MANIFEST_KEY, &manifest)
        .await
        .context("write aggregate manifest pointer")?;

    Ok(WriteResult {
        changed_shards,
        refs_written,
    })
}

fn reusable_manifest_shards(
    previous_manifest: Option<&AggregateManifest>,
    shard_count: usize,
) -> HashMap<String, &AggregateManifestShard> {
    let Some(manifest) = previous_manifest else {
        return HashMap::new();
    };
    if manifest.shard_count != shard_count {
        return HashMap::new();
    }
    manifest
        .shards
        .iter()
        .map(|shard| (shard.id.clone(), shard))
        .collect()
}

fn partition_entries(
    entries: &BTreeMap<String, AggregateEntry>,
    shard_count: usize,
) -> Vec<(String, BTreeMap<String, AggregateEntry>)> {
    let mut shards = (0..shard_count)
        .map(|index| (shard_id(index, shard_count), BTreeMap::new()))
        .collect::<Vec<_>>();
    for (name, entry) in entries {
        let index = aggregate_shard_index(name, shard_count);
        shards[index].1.insert(name.clone(), entry.clone());
    }
    shards
}

pub(crate) fn aggregate_shard_index(name: &str, shard_count: usize) -> usize {
    debug_assert!(shard_count > 0);
    (shards::fnv1a32(name) % shard_count as u32) as usize
}

fn shard_id(index: usize, shard_count: usize) -> String {
    let max_index = shard_count.saturating_sub(1);
    let width = std::cmp::max(2, format!("{max_index:x}").len());
    format!("{index:0width$x}")
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn catalog_from_aggregate(
    entries: &BTreeMap<String, AggregateEntry>,
    generated_at: String,
) -> catalog::CatalogFile {
    let mut newest_by_storage = BTreeMap::<String, &AggregateEntry>::new();
    for entry in entries.values().filter(|entry| entry.has_good_freshness()) {
        newest_by_storage
            .entry(entry.storage_name.clone())
            .and_modify(|current| {
                if compare_entries_for_newest(&entry, current).is_lt() {
                    *current = entry;
                }
            })
            .or_insert(entry);
    }

    let crates = newest_by_storage
        .into_values()
        .map(|entry| CatalogEntry {
            name: entry.name.clone(),
            storage_name: entry.storage_name.clone(),
            version: entry.version.clone(),
            parsed_at: entry.parsed_at.clone(),
            node_count: entry.nodes,
            edge_count: entry.edges,
        })
        .collect();
    catalog::build_catalog(crates, generated_at)
}

async fn write_refs(r2: &Arc<dyn R2>, entries: &BTreeMap<String, AggregateEntry>) -> Result<usize> {
    let refs = refs_from_aggregate(entries);
    let count = refs.len();
    for ref_file in refs {
        write_json(r2, &refs_key(&ref_file.storage_name), &ref_file).await?;
    }
    Ok(count)
}

fn refs_from_aggregate(entries: &BTreeMap<String, AggregateEntry>) -> Vec<CrateRefFile> {
    let mut grouped: BTreeMap<String, Vec<&AggregateEntry>> = BTreeMap::new();
    for entry in entries.values().filter(|entry| entry.has_good_freshness()) {
        grouped
            .entry(entry.storage_name.clone())
            .or_default()
            .push(entry);
    }

    grouped
        .into_iter()
        .map(|(storage_name, mut entries)| {
            entries.sort_by(|left, right| compare_entries_for_newest(left, right));
            let newest = entries[0];
            let mut aliases = BTreeMap::new();
            insert_alias(&mut aliases, "latest", newest);
            if entries.iter().any(|entry| entry.source == Source::Sysroot) {
                insert_std_aliases(&mut aliases, &entries);
            } else {
                insert_alias(&mut aliases, "stable", newest);
            }

            let versions = entries
                .into_iter()
                .map(|entry| CrateRefVersion {
                    version: entry.version.clone(),
                    graph_hash: entry.graph_hash.clone(),
                    parsed_at: entry.parsed_at.clone(),
                    nodes: entry.nodes,
                    edges: entry.edges,
                })
                .collect();

            CrateRefFile {
                schema_version: REF_SCHEMA_VERSION,
                storage_name,
                display_name: newest.name.clone(),
                aliases,
                versions,
            }
        })
        .collect()
}

fn insert_std_aliases(aliases: &mut BTreeMap<String, CrateRefAlias>, entries: &[&AggregateEntry]) {
    let newest_stable = entries
        .iter()
        .copied()
        .find(|entry| !entry.version.contains("nightly") && !entry.version.contains("beta"));
    let newest_beta = entries
        .iter()
        .copied()
        .find(|entry| entry.version.contains("beta"));
    let newest_nightly = entries
        .iter()
        .copied()
        .find(|entry| entry.version.contains("nightly"));

    if let Some(entry) = newest_nightly {
        insert_alias(aliases, "nightly", entry);
    }
    if let Some(entry) = newest_beta.or(newest_nightly) {
        insert_alias(aliases, "beta", entry);
    }
    if let Some(entry) = newest_stable.or(newest_nightly) {
        insert_alias(aliases, "stable", entry);
    }
}

fn insert_alias(
    aliases: &mut BTreeMap<String, CrateRefAlias>,
    alias: &str,
    entry: &AggregateEntry,
) {
    aliases.insert(
        alias.to_string(),
        CrateRefAlias {
            version: entry.version.clone(),
            graph_hash: entry.graph_hash.clone(),
        },
    );
}

fn compare_entries_for_newest(left: &&AggregateEntry, right: &&AggregateEntry) -> Ordering {
    compare_versions_desc(&left.version, &right.version)
        .then_with(|| right.parsed_at.cmp(&left.parsed_at))
        .then_with(|| left.name.cmp(&right.name))
}

fn aggregate_key(name: &str, version: &str) -> String {
    format!("{name}@{version}")
}

fn compare_versions_desc(left: &str, right: &str) -> Ordering {
    match (Version::parse(left), Version::parse(right)) {
        (Ok(left), Ok(right)) => right.cmp(&left),
        (Ok(_), Err(_)) => Ordering::Less,
        (Err(_), Ok(_)) => Ordering::Greater,
        (Err(_), Err(_)) => right.cmp(left),
    }
}

impl AggregateEntry {
    fn from_freshness(entry: FreshnessEntry) -> Self {
        let storage_name = entry
            .storage_name
            .unwrap_or_else(|| hyphenate_crate_name(&entry.name));
        Self {
            name: entry.name,
            storage_name,
            version: entry.version,
            parsed_at: entry.parsed_at,
            source: entry.source,
            parser_revision: entry.parser_revision,
            schema_version: entry.schema_version,
            graph_hash: entry.graph_hash,
            rustdoc_hash: entry.rustdoc_hash,
            nodes: entry.nodes,
            edges: entry.edges,
            priority_tier: None,
            download_rank: None,
            failure: None,
        }
    }

    fn placeholder(delta: &RunDelta, canonical_name: &str, config: &FreshnessMergeConfig) -> Self {
        let has_good_delta = matches!(
            delta.outcome,
            RunDeltaOutcome::Published | RunDeltaOutcome::ParserBumped | RunDeltaOutcome::Fresh
        );
        Self {
            name: canonical_name.to_string(),
            storage_name: hyphenate_crate_name(canonical_name),
            version: delta.version.clone(),
            parsed_at: config.generated_at.clone(),
            source: Source::Unknown,
            parser_revision: config.parser_revision.clone(),
            schema_version: config.graph_schema_version,
            graph_hash: if has_good_delta {
                delta.graph_hash.clone().unwrap_or_default()
            } else {
                String::new()
            },
            rustdoc_hash: None,
            nodes: if has_good_delta {
                delta.nodes.unwrap_or(0)
            } else {
                0
            },
            edges: if has_good_delta {
                delta.edges.unwrap_or(0)
            } else {
                0
            },
            priority_tier: delta.priority_tier.clone(),
            download_rank: delta.download_rank,
            failure: None,
        }
    }

    fn apply_success_delta(&mut self, delta: &RunDelta, config: &FreshnessMergeConfig) {
        self.version = delta.version.clone();
        self.parsed_at = config.generated_at.clone();
        self.parser_revision = config.parser_revision.clone();
        self.schema_version = config.graph_schema_version;
        if let Some(graph_hash) = &delta.graph_hash {
            self.graph_hash = graph_hash.clone();
        }
        if let Some(nodes) = delta.nodes {
            self.nodes = nodes;
        }
        if let Some(edges) = delta.edges {
            self.edges = edges;
        }
    }

    fn apply_enrichment(&mut self, delta: &RunDelta, previous: Option<&AggregateEntry>) {
        self.priority_tier = delta
            .priority_tier
            .clone()
            .or_else(|| previous.and_then(|entry| entry.priority_tier.clone()));
        self.download_rank = delta
            .download_rank
            .or_else(|| previous.and_then(|entry| entry.download_rank));
    }

    fn has_good_freshness(&self) -> bool {
        !self.graph_hash.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::publisher::r2::freshness_key;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemoryR2 {
        objects: Mutex<BTreeMap<String, Vec<u8>>>,
        puts: Mutex<Vec<String>>,
    }

    impl MemoryR2 {
        fn new() -> Arc<Self> {
            Arc::new(Self::default())
        }

        fn backend(self: &Arc<Self>) -> Arc<dyn R2> {
            self.clone()
        }

        fn put_log(&self) -> Vec<String> {
            self.puts.lock().expect("put log mutex").clone()
        }

        fn clear_put_log(&self) {
            self.puts.lock().expect("put log mutex").clear();
        }

        async fn json<T: serde::de::DeserializeOwned>(&self, key: &str) -> T {
            let bytes = self
                .get(key)
                .await
                .expect("memory get")
                .unwrap_or_else(|| panic!("missing key {key}"));
            serde_json::from_slice(&bytes).expect("parse json")
        }

        async fn put_jsonl(&self, key: &str, deltas: &[RunDelta]) {
            let mut body = Vec::new();
            for delta in deltas {
                body.extend(serde_json::to_vec(delta).expect("serialize delta"));
                body.push(b'\n');
            }
            self.put(key, body, "application/x-ndjson; charset=utf-8")
                .await
                .expect("put jsonl");
        }
    }

    #[async_trait::async_trait]
    impl R2 for MemoryR2 {
        async fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
            Ok(self
                .objects
                .lock()
                .expect("objects mutex")
                .get(key)
                .cloned())
        }

        async fn put(&self, key: &str, bytes: Vec<u8>, _content_type: &str) -> Result<()> {
            self.objects
                .lock()
                .expect("objects mutex")
                .insert(key.to_string(), bytes);
            self.puts
                .lock()
                .expect("put log mutex")
                .push(key.to_string());
            Ok(())
        }

        async fn list_prefix(&self, prefix: &str) -> Result<Vec<String>> {
            let mut keys = self
                .objects
                .lock()
                .expect("objects mutex")
                .keys()
                .filter(|key| key.starts_with(prefix))
                .cloned()
                .collect::<Vec<_>>();
            keys.sort();
            Ok(keys)
        }
    }

    fn config(run_id: &str, generation: &str) -> FreshnessMergeConfig {
        FreshnessMergeConfig {
            run_id: run_id.to_string(),
            delta_prefix: run_delta_prefix(run_id),
            index_shards: 4,
            write_catalog: false,
            write_refs: false,
            bootstrap: false,
            generation: generation.to_string(),
            generated_at: "2026-07-04T00:00:00Z".to_string(),
            parser_revision: "parser-new".to_string(),
            graph_schema_version: 7,
        }
    }

    fn entry(
        name: &str,
        storage_name: Option<&str>,
        version: &str,
        parsed_at: &str,
        graph_hash: &str,
        source: Source,
    ) -> FreshnessEntry {
        FreshnessEntry {
            name: name.to_string(),
            storage_name: storage_name.map(ToString::to_string),
            version: version.to_string(),
            parsed_at: parsed_at.to_string(),
            source,
            parser_revision: "parser-old".to_string(),
            schema_version: 6,
            graph_hash: graph_hash.to_string(),
            rustdoc_hash: Some(format!("rustdoc-{graph_hash}")),
            nodes: 10,
            edges: 20,
        }
    }

    fn delta(name: &str, version: &str, outcome: RunDeltaOutcome) -> RunDelta {
        let is_failure = matches!(
            outcome,
            RunDeltaOutcome::Transient | RunDeltaOutcome::Permanent | RunDeltaOutcome::Quarantine
        );
        RunDelta {
            work_id: format!("crate:{name}:{version}:default"),
            name: name.to_string(),
            version: version.to_string(),
            outcome,
            nodes: (!is_failure).then_some(30),
            edges: (!is_failure).then_some(40),
            graph_hash: (!is_failure).then(|| format!("delta-{name}-{version}")),
            priority_tier: Some("top-download-stale".to_string()),
            download_rank: Some(12),
            error: is_failure.then(|| format!("{outcome:?} error")),
        }
    }

    async fn record(r2: &Arc<MemoryR2>, freshness: &FreshnessRegistry, entry: FreshnessEntry) {
        freshness.record(&entry).await.expect("record freshness");
        assert!(r2.get(&freshness_key(&entry.name)).await.unwrap().is_some());
    }

    async fn load_entries(r2: &Arc<MemoryR2>) -> BTreeMap<String, AggregateEntry> {
        let manifest: AggregateManifest = r2.json(INDEX_MANIFEST_KEY).await;
        let mut entries = BTreeMap::new();
        for shard_ref in manifest.shards {
            let shard: AggregateShard = r2.json(&shard_ref.key).await;
            entries.extend(shard.entries);
        }
        entries
    }

    #[tokio::test]
    async fn bootstrap_from_list_all_builds_manifest_and_shards() {
        let r2 = MemoryR2::new();
        let backend = r2.backend();
        let freshness = FreshnessRegistry::new(backend.clone());
        record(
            &r2,
            &freshness,
            entry(
                "alpha",
                None,
                "1.0.0",
                "2026-07-01T00:00:00Z",
                "hash-a",
                Source::DocsRs,
            ),
        )
        .await;
        record(
            &r2,
            &freshness,
            entry(
                "serde_json",
                Some("serde-json"),
                "1.0.0",
                "2026-07-01T00:00:00Z",
                "hash-serde",
                Source::DocsRs,
            ),
        )
        .await;

        let mut cfg = config("run-1", "gen-1");
        cfg.bootstrap = true;
        let report = merge(backend, &freshness, cfg).await.expect("merge");

        assert_eq!(report.changed_shards, 4);
        assert_eq!(report.aggregate_entries, 2);
        let manifest: AggregateManifest = r2.json(INDEX_MANIFEST_KEY).await;
        assert_eq!(manifest.schema, AGGREGATE_SCHEMA_VERSION);
        assert_eq!(manifest.generation, "gen-1");
        assert_eq!(manifest.shard_count, 4);
        assert_eq!(manifest.shards.len(), 4);

        let entries = load_entries(&r2).await;
        assert_eq!(entries["alpha@1.0.0"].storage_name, "alpha");
        assert_eq!(entries["serde_json@1.0.0"].storage_name, "serde-json");
    }

    #[tokio::test]
    async fn missing_aggregate_requires_explicit_bootstrap() {
        let r2 = MemoryR2::new();
        let backend = r2.backend();
        let freshness = FreshnessRegistry::new(backend.clone());

        let err = merge(backend, &freshness, config("run-1", "gen-1"))
            .await
            .expect_err("merge should require explicit bootstrap");

        assert!(
            err.to_string().contains("rerun with --bootstrap"),
            "unexpected error: {err:?}"
        );
    }

    #[tokio::test]
    async fn delta_application_updates_successes_and_records_failures() {
        let r2 = MemoryR2::new();
        let backend = r2.backend();
        let freshness = FreshnessRegistry::new(backend.clone());
        for name in ["alpha", "beta", "delta", "epsilon"] {
            record(
                &r2,
                &freshness,
                entry(
                    name,
                    None,
                    "1.0.0",
                    "2026-07-01T00:00:00Z",
                    &format!("hash-{name}-old"),
                    Source::DocsRs,
                ),
            )
            .await;
        }
        let mut cfg = config("run-1", "gen-1");
        cfg.bootstrap = true;
        merge(backend.clone(), &freshness, cfg)
            .await
            .expect("initial merge");

        record(
            &r2,
            &freshness,
            FreshnessEntry {
                nodes: 99,
                edges: 199,
                parser_revision: "parser-new".to_string(),
                schema_version: 7,
                ..entry(
                    "alpha",
                    None,
                    "2.0.0",
                    "2026-07-04T01:00:00Z",
                    "hash-alpha-new",
                    Source::DocsRs,
                )
            },
        )
        .await;
        record(
            &r2,
            &freshness,
            FreshnessEntry {
                parser_revision: "parser-new".to_string(),
                schema_version: 7,
                ..entry(
                    "beta",
                    None,
                    "1.0.0",
                    "2026-07-04T01:00:00Z",
                    "hash-beta-old",
                    Source::DocsRs,
                )
            },
        )
        .await;

        r2.put_jsonl(
            "rust/_runs/run-2/deltas/0.jsonl",
            &[
                delta("alpha", "2.0.0", RunDeltaOutcome::Published),
                delta("beta", "1.0.0", RunDeltaOutcome::ParserBumped),
                delta("delta", "1.0.0", RunDeltaOutcome::Fresh),
                delta("epsilon", "1.0.0", RunDeltaOutcome::Transient),
                delta("gamma", "0.1.0", RunDeltaOutcome::Permanent),
                delta("zeta", "0.1.0", RunDeltaOutcome::Quarantine),
            ],
        )
        .await;

        merge(backend, &freshness, config("run-2", "gen-2"))
            .await
            .expect("second merge");

        let entries = load_entries(&r2).await;
        assert_eq!(entries["alpha@2.0.0"].version, "2.0.0");
        assert_eq!(entries["alpha@2.0.0"].graph_hash, "hash-alpha-new");
        assert_eq!(entries["alpha@2.0.0"].nodes, 99);
        assert!(entries["alpha@2.0.0"].failure.is_none());
        assert_eq!(
            entries["alpha@2.0.0"].priority_tier.as_deref(),
            Some("top-download-stale")
        );
        assert_eq!(entries["alpha@2.0.0"].download_rank, Some(12));

        assert_eq!(entries["beta@1.0.0"].parser_revision, "parser-new");
        assert_eq!(entries["beta@1.0.0"].schema_version, 7);
        assert!(entries["beta@1.0.0"].failure.is_none());

        assert_eq!(entries["delta@1.0.0"].graph_hash, "hash-delta-old");
        assert!(entries["delta@1.0.0"].failure.is_none());

        assert_eq!(entries["epsilon@1.0.0"].graph_hash, "hash-epsilon-old");
        assert_eq!(
            entries["epsilon@1.0.0"].failure.as_ref().map(|f| f.outcome),
            Some(RunDeltaOutcome::Transient)
        );
        assert_eq!(
            entries["gamma@0.1.0"].failure.as_ref().map(|f| f.outcome),
            Some(RunDeltaOutcome::Permanent)
        );
        assert_eq!(entries["gamma@0.1.0"].graph_hash, "");
        assert_eq!(
            entries["zeta@0.1.0"].failure.as_ref().map(|f| f.outcome),
            Some(RunDeltaOutcome::Quarantine)
        );
    }

    #[tokio::test]
    async fn writes_only_changed_shards_and_manifest_pointer_last() {
        let r2 = MemoryR2::new();
        let backend = r2.backend();
        let freshness = FreshnessRegistry::new(backend.clone());
        record(
            &r2,
            &freshness,
            entry(
                "alpha",
                None,
                "1.0.0",
                "2026-07-01T00:00:00Z",
                "hash-a",
                Source::DocsRs,
            ),
        )
        .await;
        record(
            &r2,
            &freshness,
            entry(
                "beta",
                None,
                "1.0.0",
                "2026-07-01T00:00:00Z",
                "hash-b",
                Source::DocsRs,
            ),
        )
        .await;
        let mut cfg = config("run-1", "gen-1");
        cfg.bootstrap = true;
        merge(backend.clone(), &freshness, cfg)
            .await
            .expect("initial merge");
        let first_manifest: AggregateManifest = r2.json(INDEX_MANIFEST_KEY).await;

        record(
            &r2,
            &freshness,
            FreshnessEntry {
                graph_hash: "hash-a2".to_string(),
                ..entry(
                    "alpha",
                    None,
                    "1.1.0",
                    "2026-07-04T00:00:00Z",
                    "hash-a2",
                    Source::DocsRs,
                )
            },
        )
        .await;
        r2.put_jsonl(
            "rust/_runs/run-2/deltas/0.jsonl",
            &[delta("alpha", "1.1.0", RunDeltaOutcome::Published)],
        )
        .await;
        r2.clear_put_log();

        let report = merge(backend, &freshness, config("run-2", "gen-2"))
            .await
            .expect("second merge");

        assert_eq!(report.changed_shards, 1);
        let puts = r2.put_log();
        assert_eq!(puts.last().map(String::as_str), Some(INDEX_MANIFEST_KEY));

        let alpha_shard_id = shard_id(aggregate_shard_index("alpha", 4), 4);
        let changed_key = index_generation_shard_key("gen-2", &alpha_shard_id);
        assert!(puts.contains(&changed_key));
        assert_eq!(
            puts.iter()
                .filter(|key| key.starts_with("rust/_index/_generations/gen-2/shards/"))
                .count(),
            1
        );

        let second_manifest: AggregateManifest = r2.json(INDEX_MANIFEST_KEY).await;
        for shard in second_manifest.shards {
            if shard.id == alpha_shard_id {
                assert_eq!(shard.key, changed_key);
            } else {
                let previous = first_manifest
                    .shards
                    .iter()
                    .find(|old| old.id == shard.id)
                    .expect("previous shard");
                assert_eq!(shard.key, previous.key);
            }
        }
    }

    #[tokio::test]
    async fn refs_emit_aliases_versions_and_graph_hashes() {
        let r2 = MemoryR2::new();
        let backend = r2.backend();
        let freshness = FreshnessRegistry::new(backend.clone());
        record(
            &r2,
            &freshness,
            entry(
                "serde_json",
                Some("serde-json"),
                "1.0.0",
                "2026-07-01T00:00:00Z",
                "hash-serde",
                Source::DocsRs,
            ),
        )
        .await;
        record(
            &r2,
            &freshness,
            entry(
                "std",
                None,
                "1.95.0-nightly",
                "2026-07-01T00:00:00Z",
                "hash-std",
                Source::Sysroot,
            ),
        )
        .await;

        let mut cfg = config("run-1", "gen-1");
        cfg.bootstrap = true;
        cfg.write_refs = true;
        merge(backend, &freshness, cfg).await.expect("merge");

        let serde_ref: CrateRefFile = r2.json("rust/_refs/serde-json.json").await;
        assert_eq!(serde_ref.schema_version, REF_SCHEMA_VERSION);
        assert_eq!(serde_ref.storage_name, "serde-json");
        assert_eq!(serde_ref.display_name, "serde_json");
        assert_eq!(serde_ref.aliases["latest"].graph_hash, "hash-serde");
        assert_eq!(serde_ref.aliases["stable"].version, "1.0.0");
        assert_eq!(serde_ref.versions[0].nodes, 10);
        assert_eq!(serde_ref.versions[0].edges, 20);

        let std_ref: CrateRefFile = r2.json("rust/_refs/std.json").await;
        assert_eq!(std_ref.aliases["latest"].version, "1.95.0-nightly");
        assert_eq!(std_ref.aliases["nightly"].graph_hash, "hash-std");
        assert_eq!(std_ref.aliases["beta"].version, "1.95.0-nightly");
        assert_eq!(std_ref.aliases["stable"].version, "1.95.0-nightly");
    }

    #[test]
    fn catalog_wire_format_matches_existing_builder() {
        let alpha = entry(
            "alpha",
            None,
            "1.0.0",
            "2026-07-01T00:00:00Z",
            "hash-a",
            Source::DocsRs,
        );
        let beta = entry(
            "beta",
            Some("beta-storage"),
            "2.0.0",
            "2026-07-02T00:00:00Z",
            "hash-b",
            Source::DocsRs,
        );
        let expected = catalog::build_catalog(
            vec![
                CatalogEntry::from(alpha.clone()),
                CatalogEntry::from(beta.clone()),
            ],
            "2026-07-04T00:00:00Z".to_string(),
        );

        let mut aggregate = BTreeMap::new();
        aggregate.insert("alpha".to_string(), AggregateEntry::from_freshness(alpha));
        aggregate.insert("beta".to_string(), AggregateEntry::from_freshness(beta));
        aggregate.insert(
            "failed".to_string(),
            AggregateEntry {
                graph_hash: String::new(),
                failure: Some(AggregateFailure {
                    outcome: RunDeltaOutcome::Permanent,
                    error: "failed".to_string(),
                    last_attempt_at: "2026-07-04T00:00:00Z".to_string(),
                }),
                ..AggregateEntry::placeholder(
                    &delta("failed", "0.1.0", RunDeltaOutcome::Permanent),
                    "failed",
                    &config("run", "gen"),
                )
            },
        );

        let actual = catalog_from_aggregate(&aggregate, "2026-07-04T00:00:00Z".to_string());
        assert_eq!(
            serde_json::to_value(actual).expect("actual catalog json"),
            serde_json::to_value(expected).expect("expected catalog json")
        );
    }

    #[test]
    fn aggregate_types_round_trip_through_serde() {
        let aggregate_entry = AggregateEntry {
            name: "alpha".to_string(),
            storage_name: "alpha".to_string(),
            version: "1.0.0".to_string(),
            parsed_at: "2026-07-04T00:00:00Z".to_string(),
            source: Source::DocsRs,
            parser_revision: "parser".to_string(),
            schema_version: 7,
            graph_hash: "hash".to_string(),
            rustdoc_hash: Some("rustdoc".to_string()),
            nodes: 1,
            edges: 2,
            priority_tier: Some("top-download-stale".to_string()),
            download_rank: Some(1),
            failure: Some(AggregateFailure {
                outcome: RunDeltaOutcome::Transient,
                error: "timeout".to_string(),
                last_attempt_at: "2026-07-04T00:00:00Z".to_string(),
            }),
        };
        let shard = AggregateShard {
            schema: AGGREGATE_SCHEMA_VERSION,
            shard: "00".to_string(),
            entries: BTreeMap::from([("alpha".to_string(), aggregate_entry)]),
        };
        let manifest = AggregateManifest {
            schema: AGGREGATE_SCHEMA_VERSION,
            generation: "gen".to_string(),
            generated_at: "2026-07-04T00:00:00Z".to_string(),
            parser_revision: "parser".to_string(),
            graph_schema_version: 7,
            shard_count: 4,
            shards: vec![AggregateManifestShard {
                id: "00".to_string(),
                key: "rust/_index/_generations/gen/shards/00.json".to_string(),
                sha256: "abc".to_string(),
                count: 1,
            }],
        };

        let shard_json = serde_json::to_string(&shard).expect("serialize shard");
        let manifest_json = serde_json::to_string(&manifest).expect("serialize manifest");
        assert_eq!(
            serde_json::from_str::<AggregateShard>(&shard_json).expect("deserialize shard"),
            shard
        );
        assert_eq!(
            serde_json::from_str::<AggregateManifest>(&manifest_json)
                .expect("deserialize manifest"),
            manifest
        );
        assert!(manifest_json.contains("\"generatedAt\""));
        assert!(shard_json.contains("\"storageName\""));
        assert!(shard_json.contains("\"lastAttemptAt\""));
    }
}
