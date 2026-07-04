//! crates.io db-dump adapter.
//!
//! The scheduler needs global crate metadata: download ranking and the
//! newest non-yanked version for many crates at once. The crates.io API
//! is intentionally kept as a diagnostic fallback; this module reads the
//! daily database dump into a compact JSON snapshot.

use std::collections::HashMap;
use std::fmt;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use clap::ValueEnum;
use csv::StringRecord;
use flate2::read::GzDecoder;
use futures::StreamExt;
use semver::Version;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use super::docs_rs;

pub const DEFAULT_DB_DUMP_URL: &str = "https://static.crates.io/db-dump.tar.gz";
pub const DEFAULT_DB_DUMP_PATH: &str = "target/codeview/crates-db-dump.tar.gz";
pub const DEFAULT_SNAPSHOT_KEY: &str = "rust/_meta/crates-snapshot.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MetadataSource {
    DbDump,
    Sparse,
    Api,
}

impl fmt::Display for MetadataSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DbDump => f.write_str("db-dump"),
            Self::Sparse => f.write_str("sparse"),
            Self::Api => f.write_str("api"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RankMode {
    AllTime,
}

impl fmt::Display for RankMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AllTime => f.write_str("all-time"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrateCatalogSnapshot {
    pub schema_version: u32,
    pub generated_at: String,
    pub source: CrateCatalogSource,
    pub rank: RankMode,
    pub crates: Vec<CrateCandidate>,
}

impl CrateCatalogSnapshot {
    pub fn is_fresh(&self, max_age: Duration) -> bool {
        if max_age.is_zero() {
            return false;
        }
        let Ok(generated_at) = chrono::DateTime::parse_from_rfc3339(&self.generated_at) else {
            return false;
        };
        let age =
            chrono::Utc::now().signed_duration_since(generated_at.with_timezone(&chrono::Utc));
        age.num_seconds() >= 0 && age.num_seconds() as u64 <= max_age.as_secs()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrateCatalogSource {
    pub kind: MetadataSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_modified: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrateCandidate {
    pub name: String,
    pub newest_non_yanked: Option<String>,
    pub newest_pubtime: Option<String>,
    pub all_time_downloads: u64,
    pub recent_downloads: Option<u64>,
    pub all_time_rank: Option<u32>,
    pub recent_rank: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotLoad {
    ReusedSnapshot,
    BuiltFromDump,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DbDumpCacheMetadata {
    pub url: String,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub content_length: Option<u64>,
    pub checked_at: String,
    pub downloaded_at: Option<String>,
}

struct CrateAccumulator {
    name: String,
    all_time_downloads: u64,
    newest: Option<VersionChoice>,
}

struct VersionChoice {
    parsed: Version,
    raw: String,
    created_at: Option<String>,
}

/// Build a long-timeout HTTP client that uses the same Codeview user
/// agent as the docs.rs/crates.io cron adapters.
pub fn http_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(docs_rs::user_agent())
        .connect_timeout(Duration::from_secs(60))
        .timeout(Duration::from_secs(60 * 60 * 4))
        .build()
        .context("build crates.io db-dump HTTP client")
}

pub fn max_age_duration(hours: u64) -> Duration {
    Duration::from_secs(hours.saturating_mul(60 * 60))
}

pub fn snapshot_path_for_dump(db_dump_path: &Path) -> PathBuf {
    sibling_path_with_suffix(db_dump_path, ".snapshot.json")
}

pub async fn load_or_refresh_snapshot(
    client: &reqwest::Client,
    url: &str,
    db_dump_path: &Path,
    snapshot_path: &Path,
    max_age: Duration,
) -> Result<(CrateCatalogSnapshot, SnapshotLoad)> {
    if let Some(snapshot) = read_snapshot_file(snapshot_path)?
        && snapshot.is_fresh(max_age)
    {
        return Ok((snapshot, SnapshotLoad::ReusedSnapshot));
    }

    let cache = ensure_db_dump(client, url, db_dump_path, max_age).await?;
    let source = CrateCatalogSource {
        kind: MetadataSource::DbDump,
        url: Some(url.to_string()),
        cache_path: Some(db_dump_path.display().to_string()),
        etag: cache.etag,
        last_modified: cache.last_modified,
        checked_at: Some(cache.checked_at),
    };
    let db_dump_path = db_dump_path.to_path_buf();
    let snapshot = tokio::task::spawn_blocking(move || {
        build_snapshot_from_db_dump_path(&db_dump_path, source)
    })
    .await??;
    write_snapshot_file(snapshot_path, &snapshot)?;
    Ok((snapshot, SnapshotLoad::BuiltFromDump))
}

pub async fn ensure_db_dump(
    client: &reqwest::Client,
    url: &str,
    db_dump_path: &Path,
    max_age: Duration,
) -> Result<DbDumpCacheMetadata> {
    let sidecar_path = cache_metadata_path(db_dump_path);
    let cached = read_cache_metadata(&sidecar_path)?;
    if db_dump_path.exists()
        && cached
            .as_ref()
            .is_some_and(|metadata| cache_metadata_is_fresh(metadata, max_age))
    {
        return Ok(cached.expect("checked is_some"));
    }

    if let Some(parent) = db_dump_path.parent()
        && !parent.as_os_str().is_empty()
    {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("create {}", parent.display()))?;
    }

    let mut request = client.get(url).header("Accept", "application/gzip");
    if db_dump_path.exists()
        && let Some(metadata) = &cached
    {
        if let Some(etag) = &metadata.etag {
            request = request.header(reqwest::header::IF_NONE_MATCH, etag);
        }
        if let Some(last_modified) = &metadata.last_modified {
            request = request.header(reqwest::header::IF_MODIFIED_SINCE, last_modified);
        }
    }

    let response = request.send().await.with_context(|| format!("GET {url}"))?;
    let status = response.status();
    let now = chrono::Utc::now().to_rfc3339();
    if status == reqwest::StatusCode::NOT_MODIFIED {
        let mut metadata = cached.context("db dump returned 304 but no cache metadata exists")?;
        metadata.checked_at = now;
        write_cache_metadata(&sidecar_path, &metadata)?;
        return Ok(metadata);
    }
    if !status.is_success() {
        anyhow::bail!("crates.io db dump {url}: {status}");
    }

    let etag = header_to_string(response.headers(), reqwest::header::ETAG);
    let last_modified = header_to_string(response.headers(), reqwest::header::LAST_MODIFIED);
    let content_length = response.content_length();
    let tmp_path = sibling_path_with_suffix(db_dump_path, ".partial");
    let mut file = tokio::fs::File::create(&tmp_path)
        .await
        .with_context(|| format!("create {}", tmp_path.display()))?;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.with_context(|| format!("read {url}"))?;
        file.write_all(&chunk)
            .await
            .with_context(|| format!("write {}", tmp_path.display()))?;
    }
    file.flush()
        .await
        .with_context(|| format!("flush {}", tmp_path.display()))?;
    drop(file);

    if db_dump_path.exists() {
        tokio::fs::remove_file(db_dump_path)
            .await
            .with_context(|| format!("replace {}", db_dump_path.display()))?;
    }
    tokio::fs::rename(&tmp_path, db_dump_path)
        .await
        .with_context(|| format!("move {} to {}", tmp_path.display(), db_dump_path.display()))?;

    let metadata = DbDumpCacheMetadata {
        url: url.to_string(),
        etag,
        last_modified,
        content_length,
        checked_at: now.clone(),
        downloaded_at: Some(now),
    };
    write_cache_metadata(&sidecar_path, &metadata)?;
    Ok(metadata)
}

pub fn read_snapshot_file(path: &Path) -> Result<Option<CrateCatalogSnapshot>> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    let snapshot = serde_json::from_slice(&bytes)
        .with_context(|| format!("parse snapshot {}", path.display()))?;
    Ok(Some(snapshot))
}

pub fn write_snapshot_file(path: &Path, snapshot: &CrateCatalogSnapshot) -> Result<()> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let json = serde_json::to_vec(snapshot)?;
    std::fs::write(path, json).with_context(|| format!("write {}", path.display()))
}

pub fn build_snapshot_from_db_dump_path(
    db_dump_path: &Path,
    source: CrateCatalogSource,
) -> Result<CrateCatalogSnapshot> {
    let mut crates = HashMap::<u64, CrateAccumulator>::new();
    stream_csv_member(db_dump_path, "crates.csv", |reader| {
        read_crates_csv(reader, &mut crates)
    })?;
    stream_csv_member(db_dump_path, "versions.csv", |reader| {
        read_versions_csv(reader, &mut crates)
    })?;
    Ok(snapshot_from_accumulators(crates, source))
}

#[cfg(test)]
fn build_snapshot_from_csv_readers(
    crates_csv: impl Read,
    versions_csv: impl Read,
    source: CrateCatalogSource,
) -> Result<CrateCatalogSnapshot> {
    let mut crates = HashMap::<u64, CrateAccumulator>::new();
    read_crates_csv(crates_csv, &mut crates)?;
    read_versions_csv(versions_csv, &mut crates)?;
    Ok(snapshot_from_accumulators(crates, source))
}

fn stream_csv_member(
    db_dump_path: &Path,
    member_file_name: &str,
    mut read_csv: impl FnMut(&mut dyn Read) -> Result<()>,
) -> Result<()> {
    let file =
        File::open(db_dump_path).with_context(|| format!("open {}", db_dump_path.display()))?;
    let decoder = GzDecoder::new(BufReader::new(file));
    let mut archive = tar::Archive::new(decoder);
    for entry in archive.entries().context("read db-dump tar entries")? {
        let mut entry = entry.context("read db-dump tar entry")?;
        let matches = {
            let path = entry.path().context("read db-dump member path")?;
            path.file_name()
                .is_some_and(|file_name| file_name == member_file_name)
        };
        if matches {
            read_csv(&mut entry).with_context(|| format!("read {member_file_name}"))?;
            return Ok(());
        }
    }
    anyhow::bail!("db dump missing {member_file_name}");
}

fn read_crates_csv(reader: impl Read, crates: &mut HashMap<u64, CrateAccumulator>) -> Result<()> {
    let mut csv = csv::ReaderBuilder::new().flexible(true).from_reader(reader);
    let headers = csv.headers().context("read crates.csv headers")?.clone();
    let id_idx = required_header(&headers, "id")?;
    let name_idx = required_header(&headers, "name")?;
    let downloads_idx = required_header(&headers, "downloads")?;

    for record in csv.records() {
        let record = record.context("read crates.csv row")?;
        let id = parse_u64(required_field(&record, id_idx, "id")?, "crates.id")?;
        let name = required_field(&record, name_idx, "name")?.to_string();
        let all_time_downloads = parse_u64(
            required_field(&record, downloads_idx, "downloads")?,
            "crates.downloads",
        )?;
        crates.insert(
            id,
            CrateAccumulator {
                name,
                all_time_downloads,
                newest: None,
            },
        );
    }
    Ok(())
}

fn read_versions_csv(reader: impl Read, crates: &mut HashMap<u64, CrateAccumulator>) -> Result<()> {
    let mut csv = csv::ReaderBuilder::new().flexible(true).from_reader(reader);
    let headers = csv.headers().context("read versions.csv headers")?.clone();
    let crate_id_idx = required_header(&headers, "crate_id")?;
    let num_idx = required_header(&headers, "num")?;
    let yanked_idx = required_header(&headers, "yanked")?;
    let created_at_idx = optional_header(&headers, "created_at");

    for record in csv.records() {
        let record = record.context("read versions.csv row")?;
        if parse_bool(
            required_field(&record, yanked_idx, "yanked")?,
            "versions.yanked",
        )? {
            continue;
        }
        let crate_id = parse_u64(
            required_field(&record, crate_id_idx, "crate_id")?,
            "versions.crate_id",
        )?;
        let Some(accumulator) = crates.get_mut(&crate_id) else {
            continue;
        };
        let raw = required_field(&record, num_idx, "num")?;
        let Ok(parsed) = Version::parse(raw) else {
            continue;
        };
        let created_at = created_at_idx
            .and_then(|idx| record.get(idx))
            .filter(|value| !value.is_empty())
            .map(ToString::to_string);
        let replace = accumulator
            .newest
            .as_ref()
            .is_none_or(|current| parsed > current.parsed);
        if replace {
            accumulator.newest = Some(VersionChoice {
                parsed,
                raw: raw.to_string(),
                created_at,
            });
        }
    }
    Ok(())
}

fn snapshot_from_accumulators(
    crates: HashMap<u64, CrateAccumulator>,
    source: CrateCatalogSource,
) -> CrateCatalogSnapshot {
    let mut candidates: Vec<CrateCandidate> = crates
        .into_values()
        .map(|accumulator| {
            let (newest_non_yanked, newest_pubtime) = match accumulator.newest {
                Some(choice) => (Some(choice.raw), choice.created_at),
                None => (None, None),
            };
            CrateCandidate {
                name: accumulator.name,
                newest_non_yanked,
                newest_pubtime,
                all_time_downloads: accumulator.all_time_downloads,
                recent_downloads: None,
                all_time_rank: None,
                recent_rank: None,
            }
        })
        .collect();

    candidates.sort_by(|a, b| {
        b.all_time_downloads
            .cmp(&a.all_time_downloads)
            .then_with(|| a.name.cmp(&b.name))
    });
    for (index, candidate) in candidates.iter_mut().enumerate() {
        candidate.all_time_rank = Some(u32::try_from(index + 1).unwrap_or(u32::MAX));
    }

    CrateCatalogSnapshot {
        schema_version: 1,
        generated_at: chrono::Utc::now().to_rfc3339(),
        source,
        rank: RankMode::AllTime,
        crates: candidates,
    }
}

fn required_header(headers: &StringRecord, name: &str) -> Result<usize> {
    optional_header(headers, name).with_context(|| format!("missing CSV header {name}"))
}

fn optional_header(headers: &StringRecord, name: &str) -> Option<usize> {
    headers.iter().position(|header| header == name)
}

fn required_field<'a>(record: &'a StringRecord, index: usize, name: &str) -> Result<&'a str> {
    record
        .get(index)
        .with_context(|| format!("missing CSV field {name}"))
}

fn parse_u64(value: &str, label: &str) -> Result<u64> {
    if value.is_empty() {
        return Ok(0);
    }
    value
        .parse()
        .with_context(|| format!("parse {label}={value:?} as u64"))
}

fn parse_bool(value: &str, label: &str) -> Result<bool> {
    match value {
        "t" | "true" | "TRUE" | "1" => Ok(true),
        "f" | "false" | "FALSE" | "0" => Ok(false),
        other => anyhow::bail!("parse {label}={other:?} as bool"),
    }
}

fn cache_metadata_path(db_dump_path: &Path) -> PathBuf {
    sibling_path_with_suffix(db_dump_path, ".meta.json")
}

fn sibling_path_with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "db-dump.tar.gz".to_string());
    path.with_file_name(format!("{file_name}{suffix}"))
}

fn cache_metadata_is_fresh(metadata: &DbDumpCacheMetadata, max_age: Duration) -> bool {
    if max_age.is_zero() {
        return false;
    }
    let Ok(checked_at) = chrono::DateTime::parse_from_rfc3339(&metadata.checked_at) else {
        return false;
    };
    let age = chrono::Utc::now().signed_duration_since(checked_at.with_timezone(&chrono::Utc));
    age.num_seconds() >= 0 && age.num_seconds() as u64 <= max_age.as_secs()
}

fn read_cache_metadata(path: &Path) -> Result<Option<DbDumpCacheMetadata>> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    let metadata =
        serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?;
    Ok(Some(metadata))
}

fn write_cache_metadata(path: &Path, metadata: &DbDumpCacheMetadata) -> Result<()> {
    let json = serde_json::to_vec(metadata)?;
    std::fs::write(path, json).with_context(|| format!("write {}", path.display()))
}

fn header_to_string(
    headers: &reqwest::header::HeaderMap,
    name: reqwest::header::HeaderName,
) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(ToString::to_string)
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    fn test_source() -> CrateCatalogSource {
        CrateCatalogSource {
            kind: MetadataSource::DbDump,
            url: Some("fixture://db-dump".to_string()),
            cache_path: None,
            etag: None,
            last_modified: None,
            checked_at: None,
        }
    }

    #[test]
    fn csv_snapshot_selects_highest_semver_non_yanked_and_assigns_rank() {
        let crates = "\
id,name,downloads
1,alpha,100
2,beta,250
3,gamma,50
";
        let versions = "\
id,crate_id,num,yanked,created_at
10,1,1.9.0,false,2024-01-01 00:00:00
11,1,1.10.0,false,2024-02-01 00:00:00
12,1,2.0.0,true,2024-03-01 00:00:00
20,2,0.9.0,false,2023-01-01 00:00:00
21,2,3.0.0,true,2024-01-01 00:00:00
30,3,0.1.0,true,2022-01-01 00:00:00
";

        let snapshot = build_snapshot_from_csv_readers(
            Cursor::new(crates),
            Cursor::new(versions),
            test_source(),
        )
        .unwrap();

        assert_eq!(snapshot.crates[0].name, "beta");
        assert_eq!(snapshot.crates[0].all_time_rank, Some(1));
        assert_eq!(
            snapshot.crates[0].newest_non_yanked.as_deref(),
            Some("0.9.0")
        );
        assert_eq!(snapshot.crates[1].name, "alpha");
        assert_eq!(snapshot.crates[1].all_time_rank, Some(2));
        assert_eq!(
            snapshot.crates[1].newest_non_yanked.as_deref(),
            Some("1.10.0")
        );
        assert_eq!(snapshot.crates[2].name, "gamma");
        assert_eq!(snapshot.crates[2].all_time_rank, Some(3));
        assert_eq!(snapshot.crates[2].newest_non_yanked, None);
    }

    #[test]
    fn csv_snapshot_uses_semver_prerelease_ordering() {
        let crates = "\
id,name,downloads
1,delta,1
";
        let versions = "\
id,crate_id,num,yanked,created_at
10,1,1.0.0-alpha.1,false,2024-01-01 00:00:00
11,1,1.0.0,false,2024-02-01 00:00:00
12,1,1.1.0-alpha.1,false,2024-03-01 00:00:00
";

        let snapshot = build_snapshot_from_csv_readers(
            Cursor::new(crates),
            Cursor::new(versions),
            test_source(),
        )
        .unwrap();

        assert_eq!(
            snapshot.crates[0].newest_non_yanked.as_deref(),
            Some("1.1.0-alpha.1")
        );
    }
}
