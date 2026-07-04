//! docs.rs adapter — fetches rustdoc JSON for a published crate.
//!
//! docs.rs serves rustdoc JSON at
//! `https://docs.rs/crate/{name}/{version}{/target}/json` (zstd) and
//! `https://docs.rs/crate/{name}/{version}{/target}/json.gz` (gzip).
//! The `target` segment is optional; omit it for the default platform
//! docs.rs picked when building the crate.
//!
//! Errors are classified into `Transient` (5xx, network) and `Permanent`
//! (4xx — version doesn't exist, docs build failed) so the cron
//! caller can retry-or-give-up correctly.

use std::io::{Cursor, Read};

use anyhow::Context;
use flate2::read::GzDecoder;
use futures::StreamExt;

const DEFAULT_COMPRESSED_CAP_BYTES: u64 = 512 * 1024 * 1024;
const DEFAULT_DECOMPRESSED_CAP_BYTES: u64 = 2 * 1024 * 1024 * 1024;

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

    /// Bytes came through completely, but the artifact failed a permanent
    /// integrity/shape check such as compression CRC, size cap, emptiness, or UTF-8.
    #[error("docs.rs corrupt artifact: {0:#}")]
    Corrupt(anyhow::Error),
}

/// Raw bytes + size metadata for a successful fetch.
pub struct Download {
    /// Decompressed JSON.
    pub json: Vec<u8>,
    /// Size of the compressed payload on the wire.
    pub compressed_bytes: usize,
    /// Compression used by the selected docs.rs endpoint.
    pub encoding: &'static str,
}

#[derive(Debug, Clone, Copy)]
enum Compression {
    Gzip,
    Zstd,
}

impl Compression {
    const fn label(self) -> &'static str {
        match self {
            Self::Gzip => "gzip",
            Self::Zstd => "zstd",
        }
    }

    const fn accept(self) -> &'static str {
        match self {
            Self::Gzip => "application/gzip",
            Self::Zstd => "application/zstd, application/octet-stream",
        }
    }
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
    let zstd_url = format!("https://docs.rs/crate/{name}/{version}{target_segment}/json");
    let gzip_url = format!("https://docs.rs/crate/{name}/{version}{target_segment}/json.gz");

    match fetch_rustdoc_json_url(client, &zstd_url, Compression::Zstd).await {
        Ok(download) => Ok(download),
        Err(DocsRsError::Permanent { status, .. }) if status == 404 || status == 410 => {
            fetch_rustdoc_json_url(client, &gzip_url, Compression::Gzip).await
        }
        Err(err) => Err(err),
    }
}

async fn fetch_rustdoc_json_url(
    client: &reqwest::Client,
    url: &str,
    compression: Compression,
) -> Result<Download, DocsRsError> {
    let resp = client
        .get(url)
        .header("Accept", compression.accept())
        .send()
        .await
        .map_err(|e| DocsRsError::Transient(anyhow::Error::new(e).context(format!("GET {url}"))))?;

    let status = resp.status();
    if !status.is_success() {
        if status.as_u16() == 408 || status.as_u16() == 429 || status.is_server_error() {
            return Err(DocsRsError::Transient(anyhow::anyhow!(
                "docs.rs {url}: {status}"
            )));
        }
        if status.is_client_error() {
            return Err(DocsRsError::Permanent {
                status: status.as_u16(),
                url: url.to_string(),
            });
        }
        return Err(DocsRsError::Transient(anyhow::anyhow!(
            "docs.rs {url}: {status}"
        )));
    }

    let compressed = read_body_with_cap(resp, url).await?;
    let compressed_bytes = compressed.len();
    let json = decode_with_cap(&compressed, compression)?;

    validate_decoded_json(&json)?;

    Ok(Download {
        json,
        compressed_bytes,
        encoding: compression.label(),
    })
}

async fn read_body_with_cap(resp: reqwest::Response, url: &str) -> Result<Vec<u8>, DocsRsError> {
    if let Some(content_length) = resp.content_length()
        && content_length > DEFAULT_COMPRESSED_CAP_BYTES
    {
        return Err(DocsRsError::Corrupt(anyhow::anyhow!(
            "compressed rustdoc JSON from {url} is {content_length} bytes, above cap {DEFAULT_COMPRESSED_CAP_BYTES}"
        )));
    }

    let cap = usize::try_from(DEFAULT_COMPRESSED_CAP_BYTES).unwrap_or(usize::MAX);
    let mut body = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk
            .map_err(|e| DocsRsError::Transient(anyhow::Error::new(e).context("read body")))?;
        if body.len().saturating_add(chunk.len()) > cap {
            return Err(DocsRsError::Corrupt(anyhow::anyhow!(
                "compressed rustdoc JSON from {url} exceeded cap {DEFAULT_COMPRESSED_CAP_BYTES}"
            )));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn decode_with_cap(bytes: &[u8], compression: Compression) -> Result<Vec<u8>, DocsRsError> {
    let decoder: Box<dyn Read> = match compression {
        Compression::Gzip => Box::new(GzDecoder::new(Cursor::new(bytes))),
        Compression::Zstd => Box::new(
            zstd::stream::read::Decoder::new(Cursor::new(bytes))
                .map_err(|e| DocsRsError::Corrupt(anyhow::Error::new(e).context("zstd header")))?,
        ),
    };

    let mut limited = decoder.take(DEFAULT_DECOMPRESSED_CAP_BYTES + 1);
    let mut json = Vec::new();
    limited.read_to_end(&mut json).map_err(|e| {
        DocsRsError::Corrupt(
            anyhow::Error::new(e).context(format!("decode {}", compression.label())),
        )
    })?;
    if json.len() as u64 > DEFAULT_DECOMPRESSED_CAP_BYTES {
        return Err(DocsRsError::Corrupt(anyhow::anyhow!(
            "decompressed rustdoc JSON exceeded cap {DEFAULT_DECOMPRESSED_CAP_BYTES}"
        )));
    }
    Ok(json)
}

fn validate_decoded_json(json: &[u8]) -> Result<(), DocsRsError> {
    if json.iter().all(|byte| byte.is_ascii_whitespace()) {
        return Err(DocsRsError::Corrupt(anyhow::anyhow!(
            "decoded rustdoc JSON is empty"
        )));
    }
    std::str::from_utf8(json)
        .map_err(|e| DocsRsError::Corrupt(anyhow::Error::new(e).context("utf-8")))?;
    Ok(())
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
    let ua = format!(
        "codeview-cron/{} (https://codeview.dev)",
        env!("CARGO_PKG_VERSION")
    );
    reqwest::Client::builder()
        .user_agent(ua)
        .connect_timeout(std::time::Duration::from_secs(60))
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .context("build reqwest client")
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Write};

    use flate2::{Compression as GzipCompression, write::GzEncoder};

    use super::*;

    #[test]
    fn decode_with_cap_supports_gzip_and_zstd() {
        let payload = br#"{"format_version":57}"#;

        let mut gzip_encoder = GzEncoder::new(Vec::new(), GzipCompression::default());
        gzip_encoder.write_all(payload).unwrap();
        let gzip = gzip_encoder.finish().unwrap();
        assert_eq!(decode_with_cap(&gzip, Compression::Gzip).unwrap(), payload);

        let zstd = zstd::stream::encode_all(Cursor::new(payload), 0).unwrap();
        assert_eq!(decode_with_cap(&zstd, Compression::Zstd).unwrap(), payload);
    }

    #[test]
    fn validate_decoded_json_rejects_empty_payload() {
        assert!(matches!(
            validate_decoded_json(b"  \n\t"),
            Err(DocsRsError::Corrupt(_))
        ));
    }

    #[test]
    fn validate_decoded_json_rejects_invalid_utf8() {
        assert!(matches!(
            validate_decoded_json(&[0xff, b'{', b'}']),
            Err(DocsRsError::Corrupt(_))
        ));
    }
}
