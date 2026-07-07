//! `codeview cron catalog` — derive `rust/catalog.json` from the
//! freshness index.
//!
//! Catalog is the read-side index of "which crates exist in R2".  The
//! UI's landing page reads this to populate its rails.  We don't write
//! it incrementally on every parse (concurrent writers would race); the
//! GHA workflow runs this once after the parse matrix completes.

use anyhow::Result;
use clap::Args;
use serde::{Deserialize, Serialize};

use crate::publisher::freshness::FreshnessEntry;
use crate::publisher::r2::{CATALOG_KEY, write_json};

use super::CronContext;

#[derive(Debug, Args)]
pub struct Catalog {
    #[arg(long, default_value = "crate-graphs")]
    pub bucket: String,

    /// Print to stdout instead of uploading. Useful for local inspection.
    #[arg(long)]
    pub dry_run: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct CatalogFile {
    pub(crate) schema_version: u32,
    #[serde(rename = "generatedAt")]
    pub(crate) generated_at: String,
    pub(crate) crates: Vec<CatalogEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct CatalogEntry {
    pub(crate) name: String,
    #[serde(rename = "storageName")]
    pub(crate) storage_name: String,
    pub(crate) version: String,
    #[serde(rename = "parsedAt")]
    pub(crate) parsed_at: String,
    #[serde(rename = "nodeCount")]
    pub(crate) node_count: usize,
    #[serde(rename = "edgeCount")]
    pub(crate) edge_count: usize,
}

impl From<FreshnessEntry> for CatalogEntry {
    fn from(entry: FreshnessEntry) -> Self {
        Self {
            storage_name: entry
                .storage_name
                .clone()
                .unwrap_or_else(|| entry.name.clone()),
            version: entry.version,
            parsed_at: entry.parsed_at,
            node_count: entry.nodes,
            edge_count: entry.edges,
            name: entry.name,
        }
    }
}

pub async fn run(args: Catalog) -> Result<()> {
    let ctx = CronContext::build(&args.bucket).await?;
    let entries = ctx.freshness.list_all().await?;

    let catalog = build_catalog(
        entries.into_iter().map(CatalogEntry::from).collect(),
        chrono::Utc::now().to_rfc3339(),
    );

    eprintln!("[catalog] {} entries", catalog.crates.len());
    if args.dry_run {
        println!("{}", serde_json::to_string_pretty(&catalog)?);
        return Ok(());
    }
    write_json(&ctx.r2, CATALOG_KEY, &catalog).await?;
    eprintln!("[catalog] wrote {CATALOG_KEY}");
    Ok(())
}

pub(crate) fn build_catalog(mut crates: Vec<CatalogEntry>, generated_at: String) -> CatalogFile {
    crates.sort_by(|a, b| a.name.cmp(&b.name));
    CatalogFile {
        schema_version: 1,
        generated_at,
        crates,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_json_uses_ui_contract() {
        let catalog = build_catalog(
            vec![CatalogEntry {
                name: "proc_macro".to_string(),
                storage_name: "proc_macro".to_string(),
                version: "1.98.0-nightly".to_string(),
                parsed_at: "2026-07-04T00:00:00Z".to_string(),
                node_count: 10,
                edge_count: 20,
            }],
            "2026-07-04T00:00:00Z".to_string(),
        );

        let json = serde_json::to_string(&catalog).expect("serialize catalog");
        assert!(json.contains("\"generatedAt\""));
        assert!(json.contains("\"version\""));
        assert!(json.contains("\"parsedAt\""));
        assert!(json.contains("\"nodeCount\""));
        assert!(json.contains("\"edgeCount\""));
        assert!(!json.contains("newest_version"));
    }
}
