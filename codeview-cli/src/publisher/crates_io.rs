//! crates.io adapter — newest-version + top-N lookups.
//!
//! Tiny surface: the cron sweep only needs to know "what's the freshest
//! published version of `tokio`?" so it can compare to R2's freshness
//! index.  No write paths; we never publish to crates.io.

use anyhow::{Context, Result};
use serde::Deserialize;

/// Subset of the `crate` object returned by `GET /api/v1/crates/{name}`.
/// Subset of crates.io's `crate` shape that we read.  The two extra
/// fields are unused at the call sites today but worth carrying through
/// so future catalog enrichment (e.g. landing-page download counts) is
/// a wire-format addition rather than a re-fetch.
#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub struct CrateInfo {
    pub name: String,
    pub newest_version: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub downloads: Option<u64>,
}

/// Single-crate lookup. `None` if crates.io returns 404 (e.g. typo'd
/// crate name) — anything else propagates.
pub async fn newest_version(
    client: &reqwest::Client,
    name: &str,
) -> Result<Option<CrateInfo>> {
    let url = format!("https://crates.io/api/v1/crates/{}", urlencoding::encode(name));
    let resp = client
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .await
        .with_context(|| format!("GET {url}"))?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !resp.status().is_success() {
        anyhow::bail!("crates.io {url}: {}", resp.status());
    }
    #[derive(Deserialize)]
    struct Body {
        #[serde(rename = "crate")]
        krate: CrateInfo,
    }
    let body: Body = resp.json().await.context("parse crates.io response")?;
    Ok(Some(body.krate))
}

/// Top-N most-downloaded crates. Used by `cron sweep` when the
/// watchlist is configured as `top:N` rather than an explicit list.
pub async fn top(client: &reqwest::Client, n: usize) -> Result<Vec<CrateInfo>> {
    let per_page = n.min(100);
    let url = format!(
        "https://crates.io/api/v1/crates?per_page={per_page}&page=1&sort=downloads"
    );
    let resp = client
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .await
        .with_context(|| format!("GET {url}"))?;
    if !resp.status().is_success() {
        anyhow::bail!("crates.io {url}: {}", resp.status());
    }
    #[derive(Deserialize)]
    struct Body {
        crates: Vec<CrateInfo>,
    }
    let body: Body = resp.json().await.context("parse crates.io top response")?;
    Ok(body.crates.into_iter().take(n).collect())
}
