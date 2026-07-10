//! R2 object storage — the central seam between cron orchestration and
//! whichever physical store we're targeting.
//!
//! Two adapters, real seam:
//!
//! - [`S3Backend`] — Cloudflare R2 via its S3-compatible API (production
//!   writes from GHA, reads from anywhere with credentials).
//! - [`LocalMiniflareBackend`] — shells out to `wrangler r2 object`
//!   `--local` for reads/writes, so the same code path `wrangler dev`
//!   takes owns the on-disk format. Lets `cron mimic` exercise the full
//!   pipeline against the same state the SvelteKit worker reads from in
//!   dev mode, without us reverse-engineering miniflare's internals.
//!
//! The interface is deliberately tiny (`get` / `put` / `list_prefix`) —
//! everything bigger is built in `freshness.rs` and `artifacts.rs` on
//! top of these three primitives.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use anyhow::{Context, Result};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use rusqlite::Connection;
use sha2::{Digest as _, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::Mutex;

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

    /// How many concurrent `put` calls this backend tolerates.
    ///
    /// `S3Backend` returns 8 — Cloudflare R2 happily fans out.
    /// `LocalMiniflareBackend` returns 1 — every `put` spawns a
    /// fresh `wrangler r2 object put` subprocess, which spins up its
    /// own miniflare and contends for the same SQLite locks; concurrent
    /// processes routinely lose those races and surface 500s from
    /// workerd.  Serializing local writes adds latency but eliminates
    /// the lockstep retry-storms.
    fn concurrency_hint(&self) -> usize {
        8
    }
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
        let access_key =
            std::env::var("R2_ACCESS_KEY_ID").context("R2_ACCESS_KEY_ID env var not set")?;
        let secret_key = std::env::var("R2_SECRET_ACCESS_KEY")
            .context("R2_SECRET_ACCESS_KEY env var not set")?;
        let account_id = std::env::var("R2_ACCOUNT_ID").context("R2_ACCOUNT_ID env var not set")?;
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

async fn with_retries<T, F, Fut, ClassErr>(op: &str, classify: ClassErr, mut f: F) -> Result<T>
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
                eprintln!(
                    "[r2] {op} failed (attempt {}): {err:#}; retrying in {:?}",
                    attempt + 1,
                    delay
                );
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

/// Wrangler-subprocess errors that are worth retrying.  Concurrent
/// `wrangler r2 object put` invocations against the same `--persist-to`
/// path race on miniflare's SQLite locks; the loser surfaces as a
/// workerd 500 or a `database is locked` message in stderr.  Both are
/// transient — back off and try again.
///
/// `wrangler not found` / `ENOENT` / `not a directory` shapes are
/// permanent (config wrong, nothing retry can fix); everything else
/// errs toward transient so transient SQLite WAL contention doesn't
/// hard-fail the seed.
fn wrangler_is_transient(err: &anyhow::Error) -> bool {
    let s = format!("{err:#}");
    if s.contains("spawn wrangler")
        || s.contains("ENOENT")
        || s.contains("not a directory")
        || s.contains("No such file")
    {
        return false;
    }
    // 500/503 from workerd, SQLite WAL contention, timeouts, generic 5xx.
    s.contains("statusCode = 500")
        || s.contains("statusCode = 502")
        || s.contains("statusCode = 503")
        || s.contains("statusCode = 504")
        || s.contains("database is locked")
        || s.contains("disk I/O error")
        || s.contains("timeout")
        || s.contains("does not contain the CF-R2-Error header")
        // Wrangler exits non-zero on workerd RPC failures — treat unknown
        // shapes as transient so retries cover any new error formats too.
        || s.contains("failed (exit 1)")
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

// ─── Local miniflare-via-wrangler backend ─────────────────────────────

/// Local-dev R2 backend that delegates to `wrangler r2 object` so the
/// on-disk format stays in lock-step with `wrangler dev --local` — even
/// when miniflare bumps its internal layout (which it has done at least
/// once: wrangler 4.x added a `metadata.sqlite` index next to the
/// per-namespace `.sqlite` files).
///
/// `get` and `put` shell out to wrangler. `list_prefix` reads
/// miniflare's `_mf_objects` table directly, because `wrangler r2
/// object` has no `list` subcommand. The table's `key` column has been
/// stable across the wrangler 3 → 4 transition, and we open the DB
/// read-only so we don't have to track schema changes.
///
/// `persist_to` is the Wrangler persistence root passed to
/// `wrangler --persist-to`. Wrangler creates the actual v3 local
/// storage layout underneath it. Sqlite db path:
///
/// ```text
/// {persist_to}/v3/r2/miniflare-R2BucketObject/{do_id}.sqlite
/// ```
///
/// where `{do_id}` is derived from the bucket name via HMAC-SHA256
/// (`namespace_id_from_name`) — the same algorithm miniflare uses.
pub struct LocalMiniflareBackend {
    bucket: String,
    /// Passed verbatim to `wrangler --persist-to`. Resolved to absolute
    /// at construction so the SQLite reader and the subprocess agree
    /// regardless of the caller's cwd.
    persist_to: PathBuf,
    /// Path of the per-bucket miniflare sqlite file. Computed from
    /// `persist_to` + `namespace_id_from_name`.
    db_path: PathBuf,
    /// Optional cwd override for the wrangler subprocess. Set via
    /// `CODEVIEW_WRANGLER_CWD` when the cron CLI is invoked from a
    /// directory that doesn't have `node_modules/wrangler` resolvable.
    /// `None` means inherit the parent's cwd (matches the typical
    /// `bun run cron:mimic` invocation from `codeview-ui/`).
    wrangler_cwd: Option<PathBuf>,
    /// R2 binding name from `wrangler.toml` (`[[r2_buckets]] binding =
    /// "CRATE_GRAPHS"`).  Needed so the bulk-writer's miniflare config
    /// matches what `wrangler dev` configures — otherwise the puts land
    /// in a different namespace than the worker reads from.
    binding: String,
    /// Lazily-spawned long-running miniflare process for fast bulk
    /// puts.  See [`BulkWriter`].
    bulk_writer: Arc<Mutex<Option<BulkWriter>>>,
}

/// Long-running miniflare R2 writer.  Speaks JSON-Lines over stdio to
/// `codeview-ui/scripts/bulk-put-local.ts` (Bun + miniflare 4).
///
/// **Why a sidecar process at all:** every `wrangler r2 object put`
/// invocation pays ~3s of Node startup before the actual ~10ms SQLite
/// write.  Spawning per artifact made the first `cron seed-std` run
/// take ~2 hours for the std corpus (2071 artifacts).  Keeping one
/// miniflare process alive across the whole batch cuts that to ~10ms
/// per put, dominated by the SQLite WAL append.
///
/// **Protocol** (see `bulk-put-local.ts` for the canonical doc):
///
/// - Start: child writes `{"ready":true}` on stdout once miniflare is
///   ready, then waits for requests.
/// - Per put: caller writes one JSON line `{"key","contentType","body"}`
///   (body base64'd) on stdin, child writes one line `{"ok":true,"key"}`
///   or `{"ok":false,"key","err"}` on stdout.
/// - Shutdown: stdin closes → child finishes any in-flight write,
///   disposes miniflare, exits 0.
///
/// Single-flight by construction (`Mutex<Option<_>>` guards access),
/// which matches miniflare's internal SQLite WAL serialization —
/// pipelining wouldn't speed it up.
struct BulkWriter {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl LocalMiniflareBackend {
    pub fn new(bucket: impl Into<String>, persist_to: impl Into<PathBuf>) -> Self {
        let bucket = bucket.into();
        let mut persist_to = persist_to.into();
        let wrangler_cwd = std::env::var("CODEVIEW_WRANGLER_CWD")
            .ok()
            .map(PathBuf::from);

        // Make persist_to absolute up front so list_prefix's direct
        // SQLite read and the wrangler subprocess resolve to the same
        // file even if they have different working directories.
        if persist_to.is_relative() {
            let base = wrangler_cwd
                .clone()
                .or_else(|| std::env::current_dir().ok())
                .unwrap_or_else(|| PathBuf::from("."));
            persist_to = base.join(&persist_to);
        }

        let r2_root = persist_to.join("v3").join("r2");
        let do_unique_key = "miniflare-R2BucketObject";
        let do_id = namespace_id_from_name(do_unique_key, &bucket);
        let db_path = r2_root.join(do_unique_key).join(format!("{do_id}.sqlite"));

        // Match the wrangler.toml `[[r2_buckets]] binding` value.  If
        // the project ever runs more buckets we'll plumb this in via
        // env or arg; today there's exactly one.
        let binding =
            std::env::var("CODEVIEW_R2_BINDING").unwrap_or_else(|_| "CRATE_GRAPHS".to_string());

        Self {
            bucket,
            persist_to,
            db_path,
            wrangler_cwd,
            binding,
            bulk_writer: Arc::new(Mutex::new(None)),
        }
    }

    /// `{bucket}/{key}` — wrangler's expected positional shape.
    fn object_path(&self, key: &str) -> String {
        format!("{}/{key}", self.bucket)
    }

    /// Spawn the bulk-writer sidecar on first use and cache it.
    ///
    /// The script lives at `<wrangler_cwd>/scripts/bulk-put-local.ts`
    /// (defaults to `codeview-ui/scripts/...` since `wrangler_cwd`
    /// usually points at `codeview-ui`).  Once spawned, the same
    /// process is reused for every subsequent put — that's the whole
    /// point of going through this instead of `wrangler r2 object put`.
    async fn ensure_bulk_writer(
        &self,
        guard: &mut tokio::sync::MutexGuard<'_, Option<BulkWriter>>,
    ) -> Result<()> {
        if guard.is_some() {
            return Ok(());
        }
        let cwd = self
            .wrangler_cwd
            .clone()
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| PathBuf::from("."));
        let script_path = cwd.join("scripts").join("bulk-put-local.ts");
        let persist_to = self
            .persist_to
            .to_str()
            .context("persist_to path is not valid UTF-8")?
            .to_string();

        let mut cmd = tokio::process::Command::new("bun");
        cmd.arg(&script_path)
            .args([
                "--binding",
                &self.binding,
                "--bucket",
                &self.bucket,
                "--persist-to",
                &persist_to,
            ])
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());

        let mut child = cmd
            .spawn()
            .with_context(|| format!("spawn bun {}", script_path.display()))?;
        let stdin = child
            .stdin
            .take()
            .context("bulk-writer child has no stdin")?;
        let stdout = child
            .stdout
            .take()
            .context("bulk-writer child has no stdout")?;
        let mut stdout = BufReader::new(stdout);

        // Wait for the `{"ready":true}` handshake.  Anything else means
        // the script crashed during miniflare setup — propagate.
        let mut line = String::new();
        let bytes_read = stdout
            .read_line(&mut line)
            .await
            .context("read bulk-writer ready handshake")?;
        if bytes_read == 0 {
            anyhow::bail!("bulk-writer exited before sending ready handshake");
        }
        let trimmed = line.trim();
        let parsed: serde_json::Value = serde_json::from_str(trimmed)
            .with_context(|| format!("bulk-writer handshake not JSON: {trimmed:?}"))?;
        if parsed.get("ready").and_then(|v| v.as_bool()) != Some(true) {
            anyhow::bail!(
                "bulk-writer handshake unexpected: {trimmed:?} (expected {{\"ready\":true}})"
            );
        }

        **guard = Some(BulkWriter {
            child,
            stdin,
            stdout,
        });
        Ok(())
    }

    /// Do one round-trip on the bulk-writer: write a request line, read
    /// its ack.  Holds the writer's mutex across the round-trip so
    /// stdin/stdout never interleave.
    async fn bulk_put(&self, key: &str, bytes: &[u8], content_type: &str) -> Result<()> {
        let mut guard = self.bulk_writer.lock().await;
        self.ensure_bulk_writer(&mut guard).await?;
        let writer = guard
            .as_mut()
            .expect("ensure_bulk_writer left None in slot");

        let request = serde_json::json!({
            "key": key,
            "contentType": content_type,
            "body": B64.encode(bytes),
        });
        let mut payload = request.to_string();
        payload.push('\n');
        writer
            .stdin
            .write_all(payload.as_bytes())
            .await
            .with_context(|| format!("write bulk request for {key}"))?;
        writer
            .stdin
            .flush()
            .await
            .with_context(|| format!("flush bulk request for {key}"))?;

        let mut line = String::new();
        let bytes_read = writer
            .stdout
            .read_line(&mut line)
            .await
            .with_context(|| format!("read bulk ack for {key}"))?;
        if bytes_read == 0 {
            anyhow::bail!("bulk-writer closed stdout before acking {key}");
        }
        let trimmed = line.trim();
        let parsed: serde_json::Value = serde_json::from_str(trimmed)
            .with_context(|| format!("bulk ack for {key} not JSON: {trimmed:?}"))?;
        match parsed.get("ok").and_then(|v| v.as_bool()) {
            Some(true) => Ok(()),
            _ => {
                let err = parsed
                    .get("err")
                    .and_then(|v| v.as_str())
                    .unwrap_or("(no err in ack)");
                anyhow::bail!("bulk-writer ack for {key}: {err}");
            }
        }
    }

    /// `bunx wrangler` invocation with the right cwd. We use `bunx`
    /// instead of bare `wrangler` because the project's wrangler comes
    /// from `codeview-ui/node_modules/.bin`, not a global install.
    fn wrangler_cmd(&self) -> tokio::process::Command {
        let mut cmd = tokio::process::Command::new("bunx");
        cmd.arg("wrangler");
        if let Some(cwd) = &self.wrangler_cwd {
            cmd.current_dir(cwd);
        }
        cmd
    }

    fn persist_to_arg(&self) -> Result<&str> {
        self.persist_to
            .to_str()
            .context("persist_to path is not valid UTF-8")
    }
}

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
        let op = format!("wrangler get {key}");
        let object_path = self.object_path(key);
        let persist_to = self.persist_to_arg()?.to_string();
        with_retries(&op, wrangler_is_transient, || async {
            let mut cmd = self.wrangler_cmd();
            cmd.args([
                "r2",
                "object",
                "get",
                &object_path,
                "--local",
                "--persist-to",
                &persist_to,
                "--pipe",
            ]);
            cmd.stdout(Stdio::piped());
            cmd.stderr(Stdio::piped());

            let output = cmd
                .output()
                .await
                .with_context(|| format!("spawn wrangler r2 object get {object_path}"))?;

            if output.status.success() {
                // wrangler r2 object get --pipe writes raw bytes to stdout
                // and chatty UI lines to stderr; we want only stdout here.
                return Ok(Some(output.stdout));
            }

            // Miss vs. real error: wrangler 4 reports "key does not exist"
            // on stderr and exits non-zero. Anything else is a hard failure.
            let stderr = String::from_utf8_lossy(&output.stderr);
            if stderr.contains("does not exist")
                || stderr.contains("not found")
                || stderr.contains("404")
            {
                Ok(None)
            } else {
                anyhow::bail!(
                    "wrangler r2 object get {object_path} failed (exit {}): {stderr}",
                    output.status.code().unwrap_or(-1)
                )
            }
        })
        .await
    }

    async fn put(&self, key: &str, bytes: Vec<u8>, content_type: &str) -> Result<()> {
        // The bulk writer is the hot path. `with_retries` still wraps
        // it so a one-off stdin-pipe hiccup (rare; happens if the
        // sidecar crashes) gets one more chance — though in practice
        // an EPIPE means the child is dead and we need to respawn,
        // which `ensure_bulk_writer` handles when the next attempt
        // sees `bulk_writer = None`.  Reset on hard error so the
        // retry re-spawns instead of writing to a closed stdin.
        let op = format!("bulk put {key}");
        let bytes = Arc::new(bytes);
        let content_type = content_type.to_string();
        with_retries(&op, wrangler_is_transient, || {
            let bytes = bytes.clone();
            let content_type = content_type.clone();
            async move {
                match self.bulk_put(key, &bytes, &content_type).await {
                    Ok(()) => Ok(()),
                    Err(err) => {
                        // Drop the sidecar handle so the next attempt
                        // re-spawns from scratch. A dead child stdin
                        // can't recover via plain retry.
                        let mut guard = self.bulk_writer.lock().await;
                        if let Some(mut writer) = guard.take() {
                            let _ = writer.stdin.shutdown().await;
                            let _ = writer.child.start_kill();
                        }
                        Err(err)
                    }
                }
            }
        })
        .await
    }

    async fn list_prefix(&self, prefix: &str) -> Result<Vec<String>> {
        // wrangler 4.x exposes get/put/delete but no `object list`. We
        // can't run miniflare's bucket.list() out-of-process, so read
        // _mf_objects directly. The table is opened read-only — wrangler
        // owns the schema, we just observe it.
        let db_path = self.db_path.clone();
        let prefix = prefix.to_string();
        tokio::task::spawn_blocking(move || list_prefix_sync(&db_path, &prefix)).await?
    }

    fn concurrency_hint(&self) -> usize {
        // One wrangler subprocess at a time. See trait doc.
        1
    }
}

fn list_prefix_sync(db_path: &Path, prefix: &str) -> Result<Vec<String>> {
    if !db_path.exists() {
        return Ok(Vec::new());
    }
    let conn = Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .with_context(|| format!("open read-only {db_path:?}"))?;
    let mut stmt = conn.prepare(
        "SELECT key FROM _mf_objects WHERE substr(key, 1, length(?1)) = ?1 ORDER BY key",
    )?;
    let rows = stmt
        .query_map([prefix], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
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
        Target::Local { persist_to } => {
            Ok(Arc::new(LocalMiniflareBackend::new(bucket, persist_to)))
        }
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
                    .unwrap_or_else(|_| ".wrangler/state".into());
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

/// Exact-version freshness entry. The crate-level freshness key remains
/// a latest-version pointer; this key preserves every parsed version.
pub fn version_freshness_key(name: &str, version: &str) -> String {
    format!("rust/_index/by-version/{name}/{version}.json")
}

/// Convenience for the artifact orchestrator.
#[allow(dead_code)]
pub fn artifact_prefix(storage_name: &str, version: &str) -> String {
    format!("rust/{storage_name}/{version}")
}

/// Path of the global catalog.
pub const CATALOG_KEY: &str = "rust/catalog.json";

/// Public pointer to the current sharded freshness aggregate.
pub const INDEX_MANIFEST_KEY: &str = "rust/_index/_manifest.json";

/// Helper to read+parse JSON via the trait.
pub async fn read_json<T: serde::de::DeserializeOwned>(
    r2: &Arc<dyn R2>,
    key: &str,
) -> Result<Option<T>> {
    let Some(bytes) = r2.get(key).await? else {
        return Ok(None);
    };
    Ok(Some(
        serde_json::from_slice(&bytes).with_context(|| format!("parse JSON for {key}"))?,
    ))
}

/// Helper to serialise+upload JSON via the trait.
pub async fn write_json<T: serde::Serialize>(r2: &Arc<dyn R2>, key: &str, value: &T) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    r2.put(key, bytes, "application/json; charset=utf-8").await
}

/// Path of one aggregate generation shard.
pub fn index_generation_shard_key(generation: &str, shard_id: &str) -> String {
    format!("rust/_index/_generations/{generation}/shards/{shard_id}.json")
}

/// Prefix for one run's append-only parse deltas.
pub fn run_delta_prefix(run_id: &str) -> String {
    format!("rust/_runs/{run_id}/")
}

/// Path of the small mutable read-side ref object for one storage name.
pub fn refs_key(storage_name: &str) -> String {
    format!("rust/_refs/{storage_name}.json")
}
