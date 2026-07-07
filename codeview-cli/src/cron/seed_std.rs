//! `codeview cron seed-std` — populate R2 with std crate artifacts.
//!
//! `std`, `core`, `alloc`, `proc_macro`, and `test` aren't on docs.rs;
//! their rustdoc JSON ships via the `rust-docs-json` rustup component,
//! which is nightly-only.  This subcommand:
//!
//! 1. Detects a rustup-installed toolchain's sysroot (`rustc +<tc> --print sysroot`).
//! 2. Reads `share/doc/rust/json/{crate}.json` for each shipped std crate.
//! 3. Runs the same `publish_one` pipeline `cron parse-one` uses, with
//!    `CrateSource::LocalFile` instead of a docs.rs fetch.
//! 4. For the bare `nightly` toolchain, also writes channel-alias pointers
//!    (`stable`, `beta`, `latest`) → the nightly toolchain version, so
//!    `/std/stable` URLs resolve until per-channel parsing exists.
//!
//! Idempotent: `--if-missing` skips when `rust/alloc/stable.json` is
//! already present in R2.  Used by `cf:dev` to auto-seed on first run.
//!
//! Replaces the deleted `scripts/build-std-docs.ts` +
//! `scripts/seed-std-if-missing.ts` + `INCLUDE_STD=1` arm of
//! `scripts/publish-static-batch.ts`.

use anyhow::{Context, Result};
use clap::Args;

use crate::publisher::artifacts::{CrateSource, Outcome, PublishOptions, publish_one};
use crate::publisher::freshness::Source;
use crate::sysroot::{STD_JSON_CRATES, aliases_for_toolchain, detect_sysroot};

use super::CronContext;

#[derive(Debug, Args)]
pub struct SeedStd {
    /// Comma-separated toolchains to seed (default `nightly`).  Each
    /// must have `rust-docs-json` installed; for the bare `nightly`
    /// toolchain we additionally write `stable`/`beta`/`latest` aliases.
    #[arg(long, default_value = "nightly")]
    pub toolchains: String,

    /// Skip work entirely when `rust/alloc/stable.json` already exists
    /// in R2.  `cf:dev` uses this so first-run startups seed and
    /// subsequent ones are fast.
    #[arg(long)]
    pub if_missing: bool,

    /// Bypass the per-crate freshness idempotency check.  Re-parses
    /// every std crate even when the registry says nothing changed.
    #[arg(long)]
    pub force: bool,

    /// R2 bucket (default: `crate-graphs`).
    #[arg(long, default_value = "crate-graphs")]
    pub bucket: String,
}

pub async fn run(args: SeedStd) -> Result<()> {
    let ctx = CronContext::build(&args.bucket).await?;

    // ─── Idempotency probe ───────────────────────────────────────
    if args.if_missing {
        let probe = ctx
            .r2
            .get("rust/alloc/stable.json")
            .await
            .context("probe rust/alloc/stable.json")?;
        if probe.is_some() {
            eprintln!(
                "[seed-std] alloc/stable already in R2 — skipping (pass --force or omit --if-missing to refresh)"
            );
            return Ok(());
        }
    }

    let toolchains: Vec<&str> = args
        .toolchains
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();

    eprintln!(
        "[seed-std] parser={} toolchains={}",
        ctx.parser_revision_short(),
        toolchains.join(", "),
    );

    let mut total_published = 0usize;
    let mut total_skipped = 0usize;
    let mut total_failed = 0usize;

    for toolchain in toolchains {
        let info = match detect_sysroot(Some(toolchain)) {
            Ok(info) => info,
            Err(err) => {
                eprintln!("[seed-std] toolchain {toolchain}: detect failed: {err:#}");
                total_failed += 1;
                continue;
            }
        };
        eprintln!(
            "\n── {toolchain} → {} ────────────────────────",
            info.toolchain_version,
        );

        if info.available_crates.is_empty() {
            eprintln!(
                "[seed-std] {toolchain}: no rustdoc JSON in {} (run `rustup component add rust-docs-json --toolchain {toolchain}`)",
                info.json_dir.display(),
            );
            total_failed += 1;
            continue;
        }

        // For bare `nightly`, alias to stable/beta/latest too.
        let alias_strs = aliases_for_toolchain(toolchain);
        let aliases: Vec<&str> = alias_strs.iter().copied().collect();

        for &crate_name in STD_JSON_CRATES {
            let Some(json_path) = info.json_path_for(crate_name) else {
                eprintln!("[seed-std] {crate_name}: not shipped by {toolchain}, skipping");
                total_skipped += 1;
                continue;
            };

            eprintln!("\n[seed-std] {crate_name}@{}", info.toolchain_version);
            let outcome = publish_one(PublishOptions {
                package_name: crate_name,
                name: crate_name,
                version: &info.toolchain_version,
                storage_name: crate_name,
                r2: ctx.r2.clone(),
                freshness: &ctx.freshness,
                parser_revision: &ctx.parser_revision,
                schema_version: codeview_core::SCHEMA_VERSION,
                force: args.force,
                source: CrateSource::LocalFile {
                    path: &json_path,
                    freshness_source: Source::Sysroot,
                },
                aliases: &aliases,
            })
            .await;

            match outcome {
                Ok(Outcome::AlreadyFresh) => {
                    eprintln!("[seed-std] {crate_name}: fresh, no work needed");
                    total_skipped += 1;
                }
                Ok(Outcome::ParserBumpedSameOutput) => {
                    eprintln!(
                        "[seed-std] {crate_name}: parser bumped, output identical, registry refreshed"
                    );
                    total_skipped += 1;
                }
                Ok(Outcome::Published { nodes, edges }) => {
                    eprintln!("[seed-std] {crate_name}: {nodes} nodes, {edges} edges published");
                    total_published += 1;
                }
                Err(err) => {
                    eprintln!("[seed-std] {crate_name}: {err}");
                    total_failed += 1;
                }
            }
        }
    }

    eprintln!("\n── seed-std summary ──────────────────────────────────");
    eprintln!("published={total_published} skipped={total_skipped} failed={total_failed}");

    if total_failed > 0 {
        std::process::exit(1);
    }
    Ok(())
}
