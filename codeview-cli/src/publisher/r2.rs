//! R2 object storage — the central seam between cron orchestration and
//! whichever physical store we're targeting.
//!
//! Two adapters, real seam:
//!
//! - [`S3Backend`] — Cloudflare R2 via its S3-compatible API (production
//!   writes from GHA, reads from anywhere with credentials).
//! - [`LocalMiniflareBackend`] — writes directly to the miniflare SQLite
//!   schema that `wrangler dev --local` reads from. Lets `cron mimic`
//!   exercise the full pipeline against the same on-disk format the
//!   SvelteKit worker hits in dev mode.
//!
//! The interface is deliberately tiny (`get` / `put` / `list_prefix`) —
//! everything bigger is built in `freshness.rs` and `artifacts.rs` on
//! top of these three primitives.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use md5::{Digest as _, Md5};
use rand::RngCore;
use rusqlite::Connection;
use sha2::Sha256;

/// Async object-storage interface.  Implementations:
///
/// - [`S3Backend`]   — Cloudflare R2 over the S3 API.
/// - [`LocalMiniflareBackend`] — miniflare SQLite emulator for `wrangler dev --local`.
///
/// Callers should hold an `Arc<dyn R2>` so the same registry instance
/// can be reused across many concurrent fetches.
#[async_trait::async_trait]
pub trait R2: Send + Sync {
    /// Fetch a key's bytes.  `Ok(None)` for "no such object" — distinguishes
    /// genuine misses from transport errors.
    async fn get(&self, key: &str) -> Result<Option<Vec<u8>>>;

    /// Write `bytes` to `key`.  Overwrites any existing object.
    /// `content_type` is recorded so the worker's `readJson` sees the
    /// right `Content-Type` header on read-back (matters for local mode
    /// where miniflare stores http_metadata explicitly).
    async fn put(&self, key: &str, bytes: Vec<u8>, content_type: &str) -> Result<()>;

    /// Enumerate keys under `prefix`. Callers walk pages; the trait
    /// returns the flat list. For very large prefixes (`rust/_index/`
    /// with thousands of crates) this could grow — fine for now,
    /// revisit when freshness sweeps start chewing minutes on listing.
    async fn list_prefix(&self, prefix: &str) -> Result<Vec<String>>;
}

// ─── S3 / Cloudflare R2 backend ───────────────────────────────────────

/// Production R2 client using the S3-compatible API.
///
/// Authenticated via static credentials (R2 access-key + secret) so it
/// works inside GitHub Actions where the OIDC provider isn't wired up.
/// `endpoint` is the R2 host: `https://{account_id}.r2.cloudflarestorage.com`.
pub struct S3Backend {
    client: aws_sdk_s3::Client,
    bucket: String,
}

impl S3Backend {
    /// Build a client from the standard env vars used by the GHA workflow:
    ///
    /// - `R2_ACCESS_KEY_ID`
    /// - `R2_SECRET_ACCESS_KEY`
    /// - `R2_ACCOUNT_ID`     (→ derives the endpoint URL)
    ///
    /// Region is forced to `"auto"` per R2's quirk — it ignores the
    /// region but the SDK insists on a value.
    pub async fn from_env(bucket: impl Into<String>) -> Result<Self> {
        let access_key = std::env::var("R2_ACCESS_KEY_ID")
            .context("R2_ACCESS_KEY_ID env var not set")?;
        let secret_key = std::env::var("R2_SECRET_ACCESS_KEY")
            .context("R2_SECRET_ACCESS_KEY env var not set")?;
        let account_id = std::env::var("R2_ACCOUNT_ID")
            .context("R2_ACCOUNT_ID env var not set")?;
        let endpoint = format!("https://{account_id}.r2.cloudflarestorage.com");

        let creds = aws_credential_types::Credentials::new(
            access_key,
            secret_key,
            None, // session token
            None, // expiry
            "codeview-cli",
        );

        let config = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .endpoint_url(endpoint)
            .region(aws_config::Region::new("auto"))
            .credentials_provider(creds)
            .load()
            .await;

        // R2 doesn't speak the bucket-virtual-host style cleanly; force
        // path-style addressing to keep keys clean.
        let s3_config = aws_sdk_s3::config::Builder::from(&config)
            .force_path_style(true)
            .build();

        Ok(Self {
            client: aws_sdk_s3::Client::from_conf(s3_config),
            bucket: bucket.into(),
        })
    }
}

/// Retry policy for R2 calls.  R2 occasionally returns 5xx or times
/// out under cron load; a tight retry loop with linear backoff
/// (1s / 2s / 4s) absorbs the vast majority without giving up too
/// quickly. Four attempts total — the final failure surfaces as a
/// transient error and the GHA wrapper marks the job for retry on the
/// next sweep.
const R2_RETRIES: u32 = 4;

async fn with_retries<T, F, Fut, ClassErr>(
    op: &str,
    classify: ClassErr,
    mut f: F,
) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, anyhow::Error>>,
    ClassErr: Fn(&anyhow::Error) -> bool, // true = retryable
{
    let mut attempt = 0;
    let mut last_err: Option<anyhow::Error> = None;
    while attempt < R2_RETRIES {
        match f().await {
            Ok(v) => return Ok(v),
            Err(err) => {
                if !classify(&err) || attempt + 1 == R2_RETRIES {
                    return Err(err.context(format!("{op} (after {} attempts)", attempt + 1)));
                }
                let delay = std::time::Duration::from_secs(1u64 << attempt);
                eprintln!("[r2] {op} failed (attempt {}): {err:#}; retrying in {:?}", attempt + 1, delay);
                tokio::time::sleep(delay).await;
                last_err = Some(err);
                attempt += 1;
            }
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("{op}: retry budget exhausted")))
}

/// S3 SDK errors are transient when the service responded 5xx or the
/// request never got a reply (DNS/TLS/timeout). 4xx is permanent —
/// retrying won't help.
fn s3_is_transient(err: &anyhow::Error) -> bool {
    let s = format!("{err:#}");
    // Cheap string-shape match avoids deep SDK error wrangling.  False
    // positives just mean we retry briefly on an already-permanent
    // failure, which is fine.
    s.contains("dispatch failure")
        || s.contains("timeout")
        || s.contains("connection")
        || s.contains("500")
        || s.contains("502")
        || s.contains("503")
        || s.contains("504")
}

#[async_trait::async_trait]
impl R2 for S3Backend {
    async fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        let op = format!("R2 get {key}");
        with_retries(&op, s3_is_transient, || async {
            match self
                .client
                .get_object()
                .bucket(&self.bucket)
                .key(key)
                .send()
                .await
            {
                Ok(resp) => {
                    let bytes = resp
                        .body
                        .collect()
                        .await
                        .with_context(|| format!("collect body for {key}"))?
                        .into_bytes()
                        .to_vec();
                    Ok(Some(bytes))
                }
                Err(err) => {
                    if let aws_sdk_s3::error::SdkError::ServiceError(ref se) = err
                        && se.err().is_no_such_key()
                    {
                        return Ok(None);
                    }
                    Err(anyhow::Error::new(err))
                }
            }
        })
        .await
    }

    async fn put(&self, key: &str, bytes: Vec<u8>, content_type: &str) -> Result<()> {
        let op = format!("R2 put {key}");
        // Clone bytes per attempt — small JSON shards, cost is negligible.
        with_retries(&op, s3_is_transient, || async {
            self.client
                .put_object()
                .bucket(&self.bucket)
                .key(key)
                .content_type(content_type)
                .body(bytes.clone().into())
                .send()
                .await
                .map(|_| ())
                .map_err(anyhow::Error::new)
        })
        .await
    }

    async fn list_prefix(&self, prefix: &str) -> Result<Vec<String>> {
        let op = format!("R2 list {prefix}");
        with_retries(&op, s3_is_transient, || async {
            let mut out = Vec::new();
            let mut continuation: Option<String> = None;
            loop {
                let mut req = self
                    .client
                    .list_objects_v2()
                    .bucket(&self.bucket)
                    .prefix(prefix);
                if let Some(token) = continuation.take() {
                    req = req.continuation_token(token);
                }
                let resp = req.send().await.map_err(anyhow::Error::new)?;
                for obj in resp.contents() {
                    if let Some(k) = obj.key() {
                        out.push(k.to_string());
                    }
                }
                if resp.is_truncated().unwrap_or(false) {
                    continuation = resp.next_continuation_token().map(|s| s.to_string());
                    if continuation.is_none() {
                        break;
                    }
                } else {
                    break;
                }
            }
            Ok(out)
        })
        .await
    }
}

// ─── Local miniflare-SQLite backend ───────────────────────────────────

/// Local-dev R2 backend that writes the same on-disk layout
/// `wrangler dev --local --persist-to .wrangler/state/v3` reads from.
///
/// Layout:
///
/// ```text
/// {persist_to}/v3/r2/{bucket}/blobs/{blob_id}           # raw bytes
/// {persist_to}/v3/r2/miniflare-R2BucketObject/{do_id}.sqlite
///                                                       # _mf_objects table indexes the blobs
/// ```
///
/// `{do_id}` is derived from the bucket name via HMAC-SHA256
/// (`namespace_id_from_name`) — same algorithm miniflare uses.
pub struct LocalMiniflareBackend {
    /// Held for debug/inspection — bucket + persist_to derive the
    /// blob_dir and db_path at construction time, but it's useful to
    /// keep the originals around for error messages.
    #[allow(dead_code)]
    bucket: String,
    #[allow(dead_code)]
    persist_to: PathBuf,
    blob_dir: PathBuf,
    db_path: PathBuf,
}

impl LocalMiniflareBackend {
    pub fn new(bucket: impl Into<String>, persist_to: impl Into<PathBuf>) -> Self {
        let bucket = bucket.into();
        let persist_to = persist_to.into();
        let r2_root = persist_to.join("v3").join("r2");
        let blob_dir = r2_root.join(&bucket).join("blobs");
        let do_unique_key = "miniflare-R2BucketObject";
        let do_id = namespace_id_from_name(do_unique_key, &bucket);
        let db_path = r2_root.join(do_unique_key).join(format!("{do_id}.sqlite"));
        Self {
            bucket,
            persist_to,
            blob_dir,
            db_path,
        }
    }

}

/// SQL DDL identical to miniflare's R2 emulator.  Keep in lock-step with
/// `seedLocalR2Artifacts` in `static-artifacts.ts` (historical reference)
/// so older artifacts on disk remain readable while we transition.
const MINIFLARE_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS _mf_objects (
    key TEXT PRIMARY KEY,
    blob_id TEXT,
    version TEXT NOT NULL,
    size INTEGER NOT NULL,
    etag TEXT NOT NULL,
    uploaded INTEGER NOT NULL,
    checksums TEXT NOT NULL,
    http_metadata TEXT NOT NULL,
    custom_metadata TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS _mf_multipart_uploads (
    upload_id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    http_metadata TEXT NOT NULL,
    custom_metadata TEXT NOT NULL,
    state TINYINT DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS _mf_multipart_parts (
    upload_id TEXT NOT NULL REFERENCES _mf_multipart_uploads(upload_id),
    part_number INTEGER NOT NULL,
    blob_id TEXT NOT NULL,
    size INTEGER NOT NULL,
    etag TEXT NOT NULL,
    checksum_md5 TEXT NOT NULL,
    object_key TEXT REFERENCES _mf_objects(key) DEFERRABLE INITIALLY DEFERRED,
    PRIMARY KEY (upload_id, part_number)
);
";

/// Derive the Durable Object id for a named instance.  Mirrors miniflare's
/// `namespaceIdFromName(uniqueKey, name)`:
///
/// 1. `key  = SHA256(uniqueKey)`
/// 2. `nameHmac = HMAC-SHA256(key, name)[..16]`
/// 3. `hmac     = HMAC-SHA256(key, nameHmac)[..16]`
/// 4. id = `hex(nameHmac || hmac)` (32 bytes → 64 hex chars)
fn namespace_id_from_name(unique_key: &str, name: &str) -> String {
    use hmac::{Hmac, Mac};

    let mut hasher = Sha256::new();
    hasher.update(unique_key.as_bytes());
    let key = hasher.finalize();

    let mut h1 = <Hmac<Sha256> as Mac>::new_from_slice(&key).expect("HMAC accepts any key length");
    h1.update(name.as_bytes());
    let name_hmac = h1.finalize().into_bytes();
    let name_hmac_16 = &name_hmac[..16];

    let mut h2 = <Hmac<Sha256> as Mac>::new_from_slice(&key).expect("HMAC accepts any key length");
    h2.update(name_hmac_16);
    let hmac = h2.finalize().into_bytes();
    let hmac_16 = &hmac[..16];

    let mut combined = Vec::with_capacity(32);
    combined.extend_from_slice(name_hmac_16);
    combined.extend_from_slice(hmac_16);
    hex::encode(combined)
}

#[async_trait::async_trait]
impl R2 for LocalMiniflareBackend {
    async fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        // rusqlite isn't async-aware; clone owned data into a blocking
        // task so the tokio reactor stays free.
        let backend = SyncLocal::new(self);
        let key = key.to_string();
        tokio::task::spawn_blocking(move || backend.get(&key)).await?
    }

    async fn put(&self, key: &str, bytes: Vec<u8>, content_type: &str) -> Result<()> {
        let backend = SyncLocal::new(self);
        let key = key.to_string();
        let ct = content_type.to_string();
        tokio::task::spawn_blocking(move || backend.put(&key, bytes, &ct)).await?
    }

    async fn list_prefix(&self, prefix: &str) -> Result<Vec<String>> {
        let backend = SyncLocal::new(self);
        let prefix = prefix.to_string();
        tokio::task::spawn_blocking(move || backend.list_prefix(&prefix)).await?
    }
}

/// Synchronous version of the local backend that runs inside
/// `spawn_blocking`.  Cheap to construct (just clones a few paths) so we
/// don't need to share a `Mutex<Connection>` across the async boundary.
struct SyncLocal {
    blob_dir: PathBuf,
    db_path: PathBuf,
}

impl SyncLocal {
    fn new(backend: &LocalMiniflareBackend) -> Self {
        Self {
            blob_dir: backend.blob_dir.clone(),
            db_path: backend.db_path.clone(),
        }
    }

    fn connect(&self) -> Result<Connection> {
        if let Some(parent) = self.db_path.parent() {
            fs::create_dir_all(parent).with_context(|| format!("mkdir {parent:?}"))?;
        }
        fs::create_dir_all(&self.blob_dir)
            .with_context(|| format!("mkdir {:?}", self.blob_dir))?;
        let conn = Connection::open(&self.db_path)
            .with_context(|| format!("open {:?}", self.db_path))?;
        conn.execute_batch(MINIFLARE_SCHEMA)?;
        Ok(conn)
    }

    fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        if !self.db_path.exists() {
            return Ok(None);
        }
        let conn = self.connect()?;
        let blob_id: Option<String> = conn
            .query_row(
                "SELECT blob_id FROM _mf_objects WHERE key = ?1",
                [key],
                |row| row.get(0),
            )
            .or_else(|err| {
                if matches!(err, rusqlite::Error::QueryReturnedNoRows) {
                    Ok(None)
                } else {
                    Err(err)
                }
            })?;
        let Some(blob_id) = blob_id else {
            return Ok(None);
        };
        let blob_path = self.blob_dir.join(&blob_id);
        if !blob_path.exists() {
            return Ok(None);
        }
        let bytes = fs::read(&blob_path).with_context(|| format!("read {blob_path:?}"))?;
        Ok(Some(bytes))
    }

    fn put(&self, key: &str, bytes: Vec<u8>, content_type: &str) -> Result<()> {
        let conn = self.connect()?;
        let blob_id = new_blob_id();
        let etag = format!("{:x}", Md5::digest(&bytes));
        let version = new_version();
        let uploaded = chrono::Utc::now().timestamp_millis();
        let size = bytes.len() as i64;

        // Best-effort cleanup of the previous blob — miniflare's reader
        // tolerates orphan blobs, but we'd rather not leak disk space.
        if let Ok(Some(prev_blob_id)) = conn.query_row::<Option<String>, _, _>(
            "SELECT blob_id FROM _mf_objects WHERE key = ?1",
            [key],
            |row| row.get(0),
        ) {
            let prev_path = self.blob_dir.join(&prev_blob_id);
            let _ = fs::remove_file(&prev_path);
        }

        let blob_path = self.blob_dir.join(&blob_id);
        fs::write(&blob_path, &bytes).with_context(|| format!("write {blob_path:?}"))?;

        // miniflare encodes http_metadata as the Worker-side R2HTTPMetadata
        // shape — we only ever set Content-Type.
        let http_metadata = format!(r#"{{"contentType":"{content_type}"}}"#);

        conn.execute(
            "INSERT OR REPLACE INTO _mf_objects \
             (key, blob_id, version, size, etag, uploaded, checksums, http_metadata, custom_metadata) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                key,
                blob_id,
                version,
                size,
                etag,
                uploaded,
                "{}",
                http_metadata,
                "{}",
            ],
        )?;
        Ok(())
    }

    fn list_prefix(&self, prefix: &str) -> Result<Vec<String>> {
        if !self.db_path.exists() {
            return Ok(Vec::new());
        }
        let conn = self.connect()?;
        let mut stmt = conn.prepare(
            "SELECT key FROM _mf_objects WHERE substr(key, 1, length(?1)) = ?1 ORDER BY key",
        )?;
        let rows = stmt
            .query_map([prefix], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
}

fn new_blob_id() -> String {
    // 32 random bytes + 8 bytes timestamp — matches `generateLocalR2BlobId`
    // in the historical TS implementation. Length-stable for clean blob
    // directory listings.
    let mut buf = [0u8; 40];
    rand::rng().fill_bytes(&mut buf[..32]);
    let ts = chrono::Utc::now().timestamp_millis().to_be_bytes();
    buf[32..40].copy_from_slice(&ts);
    hex::encode(buf)
}

fn new_version() -> String {
    let mut buf = [0u8; 16];
    rand::rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

// ─── Construction helpers ─────────────────────────────────────────────

/// Lift the concrete backends behind `Arc<dyn R2>` so the rest of the
/// codebase doesn't carry a generic parameter just to support two
/// implementations.
pub enum Target {
    Remote,
    Local { persist_to: PathBuf },
}

pub async fn build_backend(target: Target, bucket: &str) -> Result<Arc<dyn R2>> {
    match target {
        Target::Remote => Ok(Arc::new(S3Backend::from_env(bucket).await?)),
        Target::Local { persist_to } => Ok(Arc::new(LocalMiniflareBackend::new(bucket, persist_to))),
    }
}

impl Target {
    /// Resolve from the `STATIC_R2_TARGET` env var (matches what GHA
    /// already sets).  Defaults to local for ergonomics — the
    /// production workflow sets `STATIC_R2_TARGET=remote` explicitly.
    pub fn from_env() -> Result<Self> {
        let target = std::env::var("STATIC_R2_TARGET").unwrap_or_else(|_| "local".into());
        match target.as_str() {
            "remote" => Ok(Target::Remote),
            "local" => {
                let persist_to = std::env::var("WRANGLER_PERSIST_TO")
                    .unwrap_or_else(|_| ".wrangler/state/v3".into());
                Ok(Target::Local {
                    persist_to: PathBuf::from(persist_to),
                })
            }
            other => anyhow::bail!("STATIC_R2_TARGET must be 'local' or 'remote', got '{other}'"),
        }
    }
}

/// Convenience for the freshness module — `rust/_index/{name}.json`.
pub fn freshness_key(name: &str) -> String {
    format!("rust/_index/{name}.json")
}

/// Convenience for the artifact orchestrator.
#[allow(dead_code)]
pub fn artifact_prefix(storage_name: &str, version: &str) -> String {
    format!("rust/{storage_name}/{version}")
}

/// Path of the global catalog.
pub const CATALOG_KEY: &str = "rust/catalog.json";

/// Helper to read+parse JSON via the trait.
pub async fn read_json<T: serde::de::DeserializeOwned>(
    r2: &Arc<dyn R2>,
    key: &str,
) -> Result<Option<T>> {
    let Some(bytes) = r2.get(key).await? else {
        return Ok(None);
    };
    Ok(Some(serde_json::from_slice(&bytes).with_context(|| {
        format!("parse JSON for {key}")
    })?))
}

/// Helper to serialise+upload JSON via the trait.
pub async fn write_json<T: serde::Serialize>(
    r2: &Arc<dyn R2>,
    key: &str,
    value: &T,
) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    r2.put(key, bytes, "application/json; charset=utf-8").await
}

/// Sanity check at module level — keeps the `Path` import live in case
/// future helpers grow.
#[allow(dead_code)]
fn _ensure_path_imported(_p: &Path) {}
