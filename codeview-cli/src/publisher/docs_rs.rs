//! docs.rs adapter — fetches rustdoc JSON for a published crate.
//!
//! docs.rs serves gzipped rustdoc JSON at
//! `https://docs.rs/crate/{name}/{version}{/target}/json.gz`.  The
//! `target` segment is optional; omit it for the default platform
//! docs.rs picked when building the crate.
//!
//! Errors are classified into `Transient` (5xx, network) and `Permanent`
//! (4xx — version doesn't exist, docs build failed) so the cron
//! caller can retry-or-give-up correctly.

use std::io::Read;

use anyhow::Context;
use flate2::read::GzDecoder;

#[derive(Debug, thiserror::Error)]
pub enum DocsRsError {
    /// 4xx — docs.rs has no JSON for this `(name, version)`. Don't retry
    /// next sweep unless the parser revision changes (it might recognise
    /// a newer schema in older JSON).
    #[error("docs.rs permanent: {status} {url}")]
    Permanent { status: u16, url: String },

    /// 5xx, timeout, DNS failure — try again next sweep.
    #[error("docs.rs transient: {0:#}")]
    Transient(anyhow::Error),

    /// Bytes came through but gzip header was malformed.
    #[error("docs.rs malformed gzip: {0:#}")]
    MalformedGzip(anyhow::Error),
}

/// Raw bytes + size metadata for a successful fetch.
pub struct Download {
    /// Decompressed JSON.
    pub json: Vec<u8>,
    /// Size of the compressed payload on the wire.
    pub compressed_bytes: usize,
}

/// Fetch + decompress rustdoc JSON for one crate version.
///
/// `target` defaults to docs.rs's chosen platform (typically
/// `x86_64-unknown-linux-gnu`) — pass `Some("aarch64-apple-darwin")`
/// etc. only when probing platform-specific differences.
pub async fn fetch_rustdoc_json(
    client: &reqwest::Client,
    name: &str,
    version: &str,
    target: Option<&str>,
) -> Result<Download, DocsRsError> {
    let target_segment = match target {
        Some(t) => format!("/{t}"),
        None => String::new(),
    };
    let url = format!("https://docs.rs/crate/{name}/{version}{target_segment}/json.gz");

    let resp = client
        .get(&url)
        .header("Accept", "application/gzip")
        .send()
        .await
        .map_err(|e| DocsRsError::Transient(anyhow::Error::new(e).context(format!("GET {url}"))))?;

    let status = resp.status();
    if !status.is_success() {
        if status.is_client_error() {
            return Err(DocsRsError::Permanent {
                status: status.as_u16(),
                url,
            });
        }
        return Err(DocsRsError::Transient(anyhow::anyhow!(
            "docs.rs {url}: {status}"
        )));
    }

    let gz_bytes = resp
        .bytes()
        .await
        .map_err(|e| DocsRsError::Transient(anyhow::Error::new(e).context("read body")))?;
    let compressed_bytes = gz_bytes.len();

    let mut decoder = GzDecoder::new(&gz_bytes[..]);
    let mut json = Vec::with_capacity(compressed_bytes * 8);
    decoder
        .read_to_end(&mut json)
        .map_err(|e| DocsRsError::MalformedGzip(anyhow::Error::new(e).context("gunzip")))?;

    Ok(Download {
        json,
        compressed_bytes,
    })
}

/// Build a reqwest client with sensible defaults for the cron flows.
///
/// - 60s connect, 5min read — docs.rs serves big crates slowly
/// - Gzip transparently handled at the body level (we still need our
///   own decode for the `json.gz` *path* since the server doesn't set
///   `Content-Encoding: gzip` even though the file is gzipped)
/// - Identifies as `codeview-cron/{version}` so docs.rs maintainers can
///   trace traffic to us
pub fn http_client() -> Result<reqwest::Client, anyhow::Error> {
    let ua = format!("codeview-cron/{} (https://codeview.dev)", env!("CARGO_PKG_VERSION"));
    reqwest::Client::builder()
        .user_agent(ua)
        .connect_timeout(std::time::Duration::from_secs(60))
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .context("build reqwest client")
}
