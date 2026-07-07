//! `codeview cron mimic` — dev-time pipeline exercise.
//!
//! Same shape as the GHA workflow but locally, against miniflare's R2
//! emulator at `.wrangler/state/v3/`.  Lets us verify parser/shard/
//! freshness changes without burning CI minutes.

use anyhow::Result;
use clap::Args;
use std::process::Command;

#[derive(Debug, Args)]
pub struct Mimic {
    /// Comma-separated crate names (`name` or `name@version`).  When the
    /// version is omitted, crates.io's newest is used.
    #[arg(long, default_value = "serde,tokio,anyhow,thiserror,clap")]
    pub crates: String,

    /// Bypass freshness check for every crate.
    #[arg(long)]
    pub force: bool,

    /// Stop the loop after the first non-success exit code.
    #[arg(long)]
    pub stop_on_fail: bool,

    /// R2 bucket (default: `crate-graphs`).
    #[arg(long, default_value = "crate-graphs")]
    pub bucket: String,
}

pub async fn run(args: Mimic) -> Result<()> {
    // Force local target unconditionally for the mimic.
    unsafe { std::env::set_var("STATIC_R2_TARGET", "local") };

    let exe = std::env::current_exe()?;
    let entries: Vec<(String, Option<String>)> = args
        .crates
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| match s.rsplit_once('@') {
            Some((n, v)) => (n.to_string(), Some(v.to_string())),
            None => (s.to_string(), None),
        })
        .collect();

    let http = crate::publisher::docs_rs::http_client()?;
    let mut results: Vec<(String, String, i32)> = Vec::new();

    for (name, version_opt) in entries {
        let version = match version_opt {
            Some(v) => v,
            None => match crate::publisher::crates_io::newest_version(&http, &name).await? {
                Some(info) => info.newest_version,
                None => {
                    eprintln!("[mimic] crates.io 404: {name}");
                    continue;
                }
            },
        };
        eprintln!("\n── parsing {name}@{version} ────────────────────────");
        let started = std::time::Instant::now();
        let status = Command::new(&exe)
            .arg("cron")
            .arg("parse-one")
            .arg("--name")
            .arg(&name)
            .arg("--version")
            .arg(&version)
            .arg("--bucket")
            .arg(&args.bucket)
            .args(if args.force { vec!["--force"] } else { vec![] })
            .status()?;
        let code = status.code().unwrap_or(-1);
        eprintln!(
            "[mimic] {name}@{version} → exit {} ({}ms)",
            code,
            started.elapsed().as_millis()
        );
        results.push((name.clone(), version.clone(), code));
        if args.stop_on_fail && code != 0 {
            eprintln!("[mimic] STOP_ON_FAIL — halting");
            break;
        }
    }

    eprintln!("\n── Summary ─────────────────────────────────────────");
    let ok = results.iter().filter(|(_, _, c)| *c == 0).count();
    let transient = results.iter().filter(|(_, _, c)| *c == 64).count();
    let permanent = results.iter().filter(|(_, _, c)| *c == 65).count();
    let other = results.len() - ok - transient - permanent;
    eprintln!(
        "ran={} ok={} transient={} permanent={} other={}",
        results.len(),
        ok,
        transient,
        permanent,
        other,
    );
    for (n, v, c) in &results {
        let tag = match *c {
            0 => "OK       ",
            64 => "TRANSIENT",
            65 => "PERMANENT",
            _ => "OTHER    ",
        };
        eprintln!("  {tag} {n}@{v}  (exit {c})");
    }

    let any_fail = results.iter().any(|(_, _, c)| *c != 0);
    std::process::exit(if any_fail { 1 } else { 0 });
}
