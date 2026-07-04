//! `codeview cron metadata` — build/publish compact crate metadata snapshots.

use std::path::PathBuf;

use anyhow::Result;
use clap::Args;

use crate::publisher::crates_dump::{
    self, DEFAULT_DB_DUMP_PATH, DEFAULT_DB_DUMP_URL, DEFAULT_SNAPSHOT_KEY, MetadataSource,
    RankMode, SnapshotBuildOptions, SnapshotLoad,
};
use crate::publisher::r2::write_json;

use super::CronContext;

#[derive(Debug, Args)]
pub struct Metadata {
    /// Bulk metadata source. `db-dump` is the production path.
    #[arg(long, value_enum, default_value_t = MetadataSource::DbDump)]
    pub source: MetadataSource,

    /// crates.io db-dump URL.
    #[arg(long, default_value = DEFAULT_DB_DUMP_URL)]
    pub db_dump_url: String,

    /// Local cache path for `db-dump.tar.gz`.
    #[arg(long, default_value = DEFAULT_DB_DUMP_PATH)]
    pub db_dump_path: PathBuf,

    /// Ranking mode for snapshot ordering.
    #[arg(long, value_enum, default_value_t = RankMode::AllTime)]
    pub rank: RankMode,

    /// Reuse a local dump/snapshot up to this age.
    #[arg(long, default_value_t = 30)]
    pub metadata_max_age_hours: u64,

    /// Snapshot destination. `r2:<key>`, `r2://<key>`, and `rust/...`
    /// write to R2; other values are local paths.
    #[arg(long, default_value = DEFAULT_SNAPSHOT_KEY)]
    pub out: String,

    /// Include prerelease versions when selecting each crate's newest
    /// non-yanked version.
    #[arg(long)]
    pub include_prerelease: bool,

    /// R2 bucket used when `--out` names an R2 key.
    #[arg(long, default_value = "crate-graphs")]
    pub bucket: String,

    /// Suppress human-readable logs.
    #[arg(long)]
    pub quiet: bool,
}

enum SnapshotDestination {
    Local(PathBuf),
    R2(String),
}

pub async fn run(args: Metadata) -> Result<()> {
    let log = |s: &str| {
        if !args.quiet {
            eprintln!("{s}");
        }
    };
    if args.source != MetadataSource::DbDump {
        anyhow::bail!(
            "metadata source {:?} is accepted by the CLI but only db-dump snapshot generation is implemented",
            args.source
        );
    }
    if args.rank != RankMode::AllTime {
        anyhow::bail!("only --rank all-time is implemented");
    }

    let destination = parse_destination(&args.out);
    let snapshot_cache_path = match &destination {
        SnapshotDestination::Local(path) => path.clone(),
        SnapshotDestination::R2(_) => crates_dump::snapshot_path_for_dump(&args.db_dump_path),
    };
    let client = crates_dump::http_client()?;
    let (snapshot, load) = crates_dump::load_or_refresh_snapshot(
        &client,
        &args.db_dump_url,
        &args.db_dump_path,
        &snapshot_cache_path,
        SnapshotBuildOptions {
            include_prerelease: args.include_prerelease,
        },
        crates_dump::max_age_duration(args.metadata_max_age_hours),
    )
    .await?;

    match load {
        SnapshotLoad::ReusedSnapshot => {
            log(&format!(
                "[metadata] reused {}",
                snapshot_cache_path.display()
            ));
        }
        SnapshotLoad::BuiltFromDump => {
            log(&format!(
                "[metadata] built snapshot with {} crates",
                snapshot.crates.len()
            ));
        }
    }

    match destination {
        SnapshotDestination::Local(path) => {
            crates_dump::write_snapshot_file(&path, &snapshot)?;
            log(&format!("[metadata] wrote {}", path.display()));
        }
        SnapshotDestination::R2(key) => {
            let ctx = CronContext::build(&args.bucket).await?;
            write_json(&ctx.r2, &key, &snapshot).await?;
            log(&format!("[metadata] wrote r2://{key}"));
        }
    }
    Ok(())
}

fn parse_destination(raw: &str) -> SnapshotDestination {
    if let Some(key) = raw.strip_prefix("r2://") {
        return SnapshotDestination::R2(key.to_string());
    }
    if let Some(key) = raw.strip_prefix("r2:") {
        return SnapshotDestination::R2(key.to_string());
    }
    if raw.starts_with("rust/") {
        return SnapshotDestination::R2(raw.to_string());
    }
    SnapshotDestination::Local(PathBuf::from(raw))
}
