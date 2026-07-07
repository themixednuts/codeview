//! Freshness registry — single source of truth for "have we parsed
//! this crate at this version with this parser revision?".
//!
//! Backed by `rust/_index/{name}.json` keys via the [`R2`] trait, so the
//! same code path serves both local (miniflare SQLite) and remote
//! (Cloudflare R2 over S3) targets.
//!
//! Preserves the registry JSON shape: same field names, same staleness
//! predicate, same `Restricted` semantics.

use std::sync::Arc;

use anyhow::Result;
use semver::Version;
use serde::{Deserialize, Serialize};

#[cfg(test)]
use super::r2::INDEX_MANIFEST_KEY;
use super::r2::{R2, freshness_key, read_json, version_freshness_key, write_json};

/// What we record after every successful parse. JSON-on-the-wire is
/// stable: the TS UI hits these files for "last parsed at" decorations.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshnessEntry {
    pub name: String,
    /// R2 storage form (hyphenated), e.g. `serde-json`. Set when the
    /// canonical Rust name differs from the on-disk path so consumers
    /// can construct artifact URLs without re-running the
    /// `normalise → hyphenate` transform.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage_name: Option<String>,
    pub version: String,
    /// ISO 8601 timestamp.
    pub parsed_at: String,
    pub source: Source,
    /// Git SHA of the parser at parse time. Bumps when `codeview-rustdoc`
    /// changes, marking every entry stale and triggering a re-parse on
    /// the next cron sweep.
    pub parser_revision: String,
    /// Graph-schema version (mirrors `codeview-core::SCHEMA_VERSION`).
    pub schema_version: u32,
    /// sha256 of the canonical graph JSON. Lets the orchestrator skip
    /// R2 uploads when re-parsing produces byte-identical artifacts
    /// (parser revision changed but output didn't).
    pub graph_hash: String,
    /// sha256 of the raw rustdoc JSON bytes from docs.rs. Recorded for
    /// drift detection ("did docs.rs serve different bytes for the
    /// same version after a toolchain bump?").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rustdoc_hash: Option<String>,
    pub nodes: usize,
    pub edges: usize,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    #[serde(rename = "docs.rs")]
    DocsRs,
    Sysroot,
    Cargo,
    Unknown,
}

/// Why the registry says a crate needs re-parsing — carries the previous
/// and current values so callers can log them.
#[derive(Debug, Clone)]
pub enum Staleness {
    Fresh,
    NeverParsed,
    NewerVersion { observed: String, recorded: String },
    ParserRevisionChanged { recorded: String, current: String },
    SchemaVersionChanged { recorded: u32, current: u32 },
}

impl Staleness {
    pub fn is_stale(&self) -> bool {
        !matches!(self, Staleness::Fresh)
    }

    pub fn describe(&self) -> String {
        match self {
            Staleness::Fresh => "fresh".into(),
            Staleness::NeverParsed => "never parsed".into(),
            Staleness::NewerVersion { observed, recorded } => {
                format!("crates.io {observed} vs recorded {recorded}")
            }
            Staleness::ParserRevisionChanged { recorded, current } => {
                format!(
                    "parser {} → {}",
                    &recorded[..recorded.len().min(8)],
                    &current[..current.len().min(8)],
                )
            }
            Staleness::SchemaVersionChanged { recorded, current } => {
                format!("schema v{recorded} → v{current}")
            }
        }
    }
}

/// Top-level operations over the registry. Stateless wrapper around an
/// `Arc<dyn R2>` — the trait handles transport, this type handles
/// staleness predicates and key shaping.
pub struct FreshnessRegistry {
    r2: Arc<dyn R2>,
}

impl FreshnessRegistry {
    pub fn new(r2: Arc<dyn R2>) -> Self {
        Self { r2 }
    }

    /// Read one entry by canonical crate name.  `Ok(None)` if the key
    /// is absent — distinguished from transport errors.
    pub async fn latest(&self, name: &str) -> Result<Option<FreshnessEntry>> {
        read_json(&self.r2, &freshness_key(name)).await
    }

    /// Read one exact crate version freshness entry.
    pub async fn version(&self, name: &str, version: &str) -> Result<Option<FreshnessEntry>> {
        read_json(&self.r2, &version_freshness_key(name, version)).await
    }

    /// Decide whether `(name, observed_newest_version)` needs
    /// re-parsing. Stale on first miss, newer version on crates.io,
    /// parser-SHA bump, or schema bump.
    pub async fn check(
        &self,
        name: &str,
        observed_newest_version: &str,
        current_parser_revision: &str,
        current_schema_version: u32,
    ) -> Result<Staleness> {
        let Some(entry) = self.version(name, observed_newest_version).await? else {
            return Ok(Staleness::NeverParsed);
        };
        if entry.version != observed_newest_version {
            return Ok(Staleness::NewerVersion {
                observed: observed_newest_version.to_string(),
                recorded: entry.version,
            });
        }
        if entry.parser_revision != current_parser_revision {
            return Ok(Staleness::ParserRevisionChanged {
                recorded: entry.parser_revision,
                current: current_parser_revision.to_string(),
            });
        }
        if entry.schema_version != current_schema_version {
            return Ok(Staleness::SchemaVersionChanged {
                recorded: entry.schema_version,
                current: current_schema_version,
            });
        }
        Ok(Staleness::Fresh)
    }

    pub async fn record(&self, entry: &FreshnessEntry) -> Result<()> {
        write_json(
            &self.r2,
            &version_freshness_key(&entry.name, &entry.version),
            entry,
        )
        .await?;

        let latest = self.latest(&entry.name).await?;
        if should_replace_latest(latest.as_ref(), entry) {
            write_json(&self.r2, &freshness_key(&entry.name), entry).await?;
        }
        Ok(())
    }

    /// Enumerate every recorded crate.  Used by the catalog rebuilder.
    pub async fn list_all(&self) -> Result<Vec<FreshnessEntry>> {
        let mut out = Vec::new();
        let keys = self.r2.list_prefix("rust/_index/by-version/").await?;
        for key in keys {
            if !is_version_freshness_key(&key) {
                continue;
            }
            if let Some(entry) = read_json::<FreshnessEntry>(&self.r2, &key).await? {
                out.push(entry);
            }
        }
        Ok(out)
    }
}

fn should_replace_latest(current: Option<&FreshnessEntry>, candidate: &FreshnessEntry) -> bool {
    let Some(current) = current else {
        return true;
    };
    compare_versions_desc(&candidate.version, &current.version).is_le()
}

fn compare_versions_desc(left: &str, right: &str) -> std::cmp::Ordering {
    match (Version::parse(left), Version::parse(right)) {
        (Ok(left), Ok(right)) => right.cmp(&left),
        (Ok(_), Err(_)) => std::cmp::Ordering::Less,
        (Err(_), Ok(_)) => std::cmp::Ordering::Greater,
        (Err(_), Err(_)) => right.cmp(left),
    }
}

#[cfg(test)]
fn is_per_crate_freshness_key(key: &str) -> bool {
    key.starts_with("rust/_index/")
        && key.ends_with(".json")
        && key != INDEX_MANIFEST_KEY
        && !key.starts_with("rust/_index/_generations/")
        && !key.starts_with("rust/_index/by-version/")
}

fn is_version_freshness_key(key: &str) -> bool {
    key.starts_with("rust/_index/by-version/") && key.ends_with(".json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_crate_freshness_key_does_not_collide_with_aggregate_manifest() {
        assert_eq!(freshness_key("manifest"), "rust/_index/manifest.json");
        assert!(is_per_crate_freshness_key(&freshness_key("manifest")));
        assert!(!is_per_crate_freshness_key(INDEX_MANIFEST_KEY));
        assert!(!is_per_crate_freshness_key(
            "rust/_index/_generations/gen/shards/00.json"
        ));
        assert!(!is_per_crate_freshness_key(
            "rust/_index/by-version/serde/1.0.0.json"
        ));
        assert!(is_version_freshness_key(
            "rust/_index/by-version/serde/1.0.0.json"
        ));
    }
}
