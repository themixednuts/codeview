//! `codeview cron catalog` — derive `rust/catalog.json` from the
//! freshness index.
//!
//! Catalog is the read-side index of "which crates exist in R2".  The
//! UI's landing page reads this to populate its rails.  We don't write
//! it incrementally on every parse (concurrent writers would race); the
//! GHA workflow runs this once after the parse matrix completes.

use anyhow::Result;
use clap::Args;
use serde::Serialize;

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

#[derive(Debug, Serialize)]
struct CatalogFile {
    schema_version: u32,
    generated_at: String,
    crates: Vec<CatalogEntry>,
}

#[derive(Debug, Serialize)]
struct CatalogEntry {
    name: String,
    #[serde(rename = "storageName")]
    storage_name: String,
    newest_version: String,
    #[serde(rename = "parsedAt")]
    parsed_at: String,
    nodes: usize,
    edges: usize,
}

pub async fn run(args: Catalog) -> Result<()> {
    let ctx = CronContext::build(&args.bucket).await?;
    let entries = ctx.freshness.list_all().await?;

    let mut crates: Vec<CatalogEntry> = entries
        .into_iter()
        .map(|e| CatalogEntry {
            storage_name: e.storage_name.clone().unwrap_or_else(|| e.name.clone()),
            newest_version: e.version,
            parsed_at: e.parsed_at,
            nodes: e.nodes,
            edges: e.edges,
            name: e.name,
        })
        .collect();
    crates.sort_by(|a, b| a.name.cmp(&b.name));

    let catalog = CatalogFile {
        schema_version: 1,
        generated_at: chrono::Utc::now().to_rfc3339(),
        crates,
    };

    eprintln!("[catalog] {} entries", catalog.crates.len());
    if args.dry_run {
        println!("{}", serde_json::to_string_pretty(&catalog)?);
        return Ok(());
    }
    write_json(&ctx.r2, CATALOG_KEY, &catalog).await?;
    eprintln!("[catalog] wrote {CATALOG_KEY}");
    Ok(())
}
