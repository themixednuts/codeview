//! Locate the `rust-docs-json` component on disk.
//!
//! `rust-docs-json` is a nightly-only rustup component that drops the
//! rustdoc JSON for `std`, `core`, `alloc`, `proc_macro`, and `test`
//! into `{sysroot}/share/doc/rust/json/{crate}.json`.  `cron seed-std`
//! reads those files directly instead of fetching from docs.rs (which
//! doesn't host std).
//!
//! Ports the relevant subset of `codeview-ui/src/lib/server/local/sysroot.ts`
//! — same probe order (`rustc +{toolchain} --print sysroot`), same
//! version-parse regex, same json-dir layout.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};

/// Subset of toolchain crates that ship rustdoc JSON via the
/// `rust-docs-json` component.  Matches `STD_JSON_CRATES` in
/// `codeview-ui/src/lib/std.ts`.
pub const STD_JSON_CRATES: &[&str] = &["std", "core", "alloc", "proc_macro", "test"];

/// One toolchain's view of the std crate corpus.
#[derive(Debug, Clone)]
pub struct SysrootInfo {
    /// `rustc --print sysroot`.  Retained for diagnostic logs even when
    /// callers only consume `json_dir`.
    #[allow(dead_code)]
    pub sysroot_path: PathBuf,
    pub json_dir: PathBuf,
    /// Parsed from `rustc --version` — e.g. `1.95.0-nightly`.
    pub toolchain_version: String,
    /// Filenames found in `share/doc/rust/json/` minus the `.json` suffix.
    pub available_crates: Vec<String>,
}

impl SysrootInfo {
    /// Path to the rustdoc JSON for a given crate, if `rust-docs-json` is
    /// installed for this toolchain and that crate is shipped.
    pub fn json_path_for(&self, crate_name: &str) -> Option<PathBuf> {
        if self
            .available_crates
            .iter()
            .any(|c| c == crate_name)
        {
            Some(self.json_dir.join(format!("{crate_name}.json")))
        } else {
            None
        }
    }
}

const EXEC_TIMEOUT: Duration = Duration::from_secs(30);

/// Run `rustc {toolchain_prefix} {args...}` and return trimmed stdout.
fn exec_rustc(toolchain: Option<&str>, args: &[&str]) -> Result<String> {
    let mut cmd = Command::new("rustc");
    if let Some(tc) = toolchain {
        cmd.arg(format!("+{tc}"));
    }
    cmd.args(args);
    run_with_timeout(cmd, EXEC_TIMEOUT)
}

fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Result<String> {
    // std::process::Command has no native timeout, but rustc/rustup probes
    // are inherently fast (<1s). Honour the timeout via a thread, but in
    // practice this just gives us a defensive ceiling.
    let mut child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .with_context(|| format!("spawn {cmd:?}"))?;

    let start = std::time::Instant::now();
    loop {
        match child.try_wait()? {
            Some(status) => {
                let output = child.wait_with_output()?;
                if !status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    bail!("{cmd:?} exited {status}: {stderr}");
                }
                return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
            }
            None => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    bail!("{cmd:?} timed out after {timeout:?}");
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

/// Parse `rustc 1.95.0-nightly (abc123 2026-05-19)` → `1.95.0-nightly`.
fn parse_rustc_version(line: &str) -> Option<String> {
    let after_rustc = line.strip_prefix("rustc")?.trim_start();
    let end = after_rustc
        .find(|c: char| c.is_whitespace())
        .unwrap_or(after_rustc.len());
    let candidate = &after_rustc[..end];
    if candidate.is_empty() {
        None
    } else {
        Some(candidate.to_string())
    }
}

/// Detect a toolchain's sysroot info.  `None` means "use the active
/// default" (`rustup default`).
pub fn detect_sysroot(toolchain: Option<&str>) -> Result<SysrootInfo> {
    let sysroot_path: PathBuf = exec_rustc(toolchain, &["--print", "sysroot"])?.into();
    let version_line = exec_rustc(toolchain, &["--version"])?;
    let toolchain_version = parse_rustc_version(&version_line).ok_or_else(|| {
        anyhow!("could not parse rustc version from {version_line:?}")
    })?;

    let json_dir = sysroot_path.join("share").join("doc").join("rust").join("json");
    let available_crates = list_json_crates(&json_dir).unwrap_or_default();

    Ok(SysrootInfo {
        sysroot_path,
        json_dir,
        toolchain_version,
        available_crates,
    })
}

fn list_json_crates(json_dir: &Path) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(json_dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(stem) = name.strip_suffix(".json") {
            out.push(stem.to_string());
        }
    }
    out.sort();
    Ok(out)
}

/// Channel aliases the seeder should write for a given toolchain string.
/// Mirrors `stdAliasesForToolchain` in the deleted `publish-static-batch.ts`.
///
/// Bare `nightly` aliases as `[nightly, stable, beta, latest]` so URLs
/// like `/std/stable` resolve until per-channel parsing exists.  Date-pinned
/// nightlies (`nightly-2026-05-14`) stay as themselves — they're for
/// reproducibility, not channel promotion.
pub fn aliases_for_toolchain(toolchain: &str) -> Vec<&'static str> {
    match toolchain {
        "nightly" => vec!["nightly", "stable", "beta", "latest"],
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nightly_version() {
        assert_eq!(
            parse_rustc_version("rustc 1.95.0-nightly (abc123 2026-05-19)"),
            Some("1.95.0-nightly".to_string())
        );
    }

    #[test]
    fn parses_stable_version() {
        assert_eq!(
            parse_rustc_version("rustc 1.82.0 (abc123 2024-10-17)"),
            Some("1.82.0".to_string())
        );
    }

    #[test]
    fn nightly_aliases_to_channels() {
        assert_eq!(
            aliases_for_toolchain("nightly"),
            vec!["nightly", "stable", "beta", "latest"]
        );
    }

    #[test]
    fn pinned_nightly_does_not_alias() {
        assert!(aliases_for_toolchain("nightly-2026-05-14").is_empty());
    }
}
