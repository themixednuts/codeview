//! `codeview cron seed-std` — populate R2 with std crate artifacts.
//!
//! `std`, `core`, `alloc`, `proc_macro`, and `test` aren't on docs.rs;
//! their rustdoc JSON either ships via the `rust-docs-json` rustup component
//! or is generated from an exact Rust source checkout.
//! This subcommand:
//!
//! 1. Detects a rustup-installed toolchain's sysroot (`rustc +<tc> --print sysroot`).
//! 2. Reads `share/doc/rust/json/{crate}.json` for each shipped std crate.
//! 3. Runs the same `publish_one` pipeline `cron parse-one` uses, with
//!    `CrateSource::LocalFile` instead of a docs.rs fetch.
//! 4. Writes channel-alias pointers for the matching toolchain. `stable`
//!    also serves `latest`; `beta` and `nightly` remain distinct.
//!
//! Idempotent: `--if-missing` skips when every requested channel alias is
//! already present in R2. Used by `cf:dev` to auto-seed on first run.
//!
//! Replaces the deleted `scripts/build-std-docs.ts` +
//! `scripts/seed-std-if-missing.ts` + `INCLUDE_STD=1` arm of
//! `scripts/publish-static-batch.ts`.

use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use clap::Args;

use crate::publisher::artifacts::{CrateSource, Outcome, PublishOptions, publish_one};
use crate::publisher::freshness::Source;
use crate::sysroot::{STD_JSON_CRATES, aliases_for_toolchain, detect_sysroot};

use super::CronContext;

#[derive(Debug, Args)]
pub struct SeedStd {
    /// Comma-separated toolchains to seed (default `nightly`). The JSON may
    /// come from `rust-docs-json` or `--json-dir`. Bare channel names publish
    /// matching channel aliases.
    #[arg(long, default_value = "nightly")]
    pub toolchains: String,

    /// Read JSON files from this directory instead of the rustup component.
    /// This is used for stable and beta, where Rust does not distribute
    /// `rust-docs-json`. Only one toolchain may be supplied with this option.
    #[arg(long)]
    pub json_dir: Option<PathBuf>,

    /// Skip work when all requested channel aliases already exist in R2.
    /// `cf:dev` uses this so first-run startups seed and subsequent ones are fast.
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
    let toolchains: Vec<&str> = args
        .toolchains
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if toolchains.is_empty() {
        bail!("at least one toolchain is required");
    }
    if args.json_dir.is_some() && toolchains.len() != 1 {
        bail!("--json-dir requires exactly one toolchain");
    }

    // ─── Idempotency probe ───────────────────────────────────────
    if args.if_missing {
        let mut all_present = true;
        for toolchain in &toolchains {
            let alias = aliases_for_toolchain(toolchain)
                .into_iter()
                .find(|alias| *alias != "latest")
                .unwrap_or(toolchain);
            let key = format!("rust/alloc/{alias}.json");
            if ctx
                .r2
                .get(&key)
                .await
                .with_context(|| format!("probe {key}"))?
                .is_none()
            {
                all_present = false;
                break;
            }
        }
        if all_present {
            eprintln!(
                "[seed-std] requested toolchain aliases already exist in R2 — skipping (pass --force or omit --if-missing to refresh)"
            );
            return Ok(());
        }
    }

    eprintln!(
        "[seed-std] parser={} toolchains={}",
        ctx.parser_revision_short(),
        toolchains.join(", "),
    );

    let mut total_published = 0usize;
    let mut total_skipped = 0usize;
    let mut total_failed = 0usize;

    for toolchain in toolchains {
        let detected = match detect_sysroot(Some(toolchain)) {
            Ok(info) => info,
            Err(err) => {
                eprintln!("[seed-std] toolchain {toolchain}: detect failed: {err:#}");
                total_failed += 1;
                continue;
            }
        };
        let info = match args.json_dir.clone() {
            Some(json_dir) => match detected.with_json_dir(json_dir) {
                Ok(info) => info,
                Err(err) => {
                    eprintln!("[seed-std] toolchain {toolchain}: external JSON failed: {err:#}");
                    total_failed += 1;
                    continue;
                }
            },
            None => detected,
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
