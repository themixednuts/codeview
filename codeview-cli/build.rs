use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("missing manifest dir"));
    let ui_dir = manifest_dir.join("..").join("codeview-ui");
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("missing out dir"));
    let target_dir = out_dir.join("codeview-ui");

    println!(
        "cargo:rerun-if-changed={}",
        ui_dir.join("package.json").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        ui_dir.join("svelte.config.js").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        ui_dir.join("vite.config.js").display()
    );
    println!("cargo:rerun-if-changed={}", ui_dir.join("src").display());

    let prebuilt_dir = env::var("CODEVIEW_UI_DIR").ok().map(PathBuf::from);
    let build_dir = prebuilt_dir.clone().unwrap_or_else(|| ui_dir.join("build"));

    if prebuilt_dir.is_none() && env::var("CODEVIEW_SKIP_UI_BUILD").is_err() {
        build_ui(&ui_dir, &build_dir);
    }

    if !build_dir.exists() {
        panic!(
            "UI build output not found at {}. Set CODEVIEW_UI_DIR or run bun build.",
            build_dir.display()
        );
    }

    if target_dir.exists() {
        fs::remove_dir_all(&target_dir).expect("failed to clean UI output directory");
    }
    copy_dir_all(&build_dir, &target_dir).expect("failed to copy UI build output");
}

fn build_ui(ui_dir: &Path, build_dir: &Path) {
    let node_modules = ui_dir.join("node_modules");
    if !node_modules.exists() || !build_dir.exists() {
        run_command(
            Command::new("bun").arg("install").current_dir(ui_dir),
            "bun install",
        );
    }
    run_command(
        Command::new("bun")
            .arg("run")
            .arg("build")
            .current_dir(ui_dir),
        "bun run build",
    );
}

fn run_command(command: &mut Command, label: &str) {
    let status = command.status().unwrap_or_else(|err| {
        panic!("failed to execute {label}: {err}");
    });
    if !status.success() {
        panic!("command {label} failed with status {status}");
    }
}

fn copy_dir_all(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let path = entry.path();
        let target = to.join(entry.file_name());
        if path.is_dir() {
            copy_dir_all(&path, &target)?;
        } else {
            fs::copy(&path, &target)?;
        }
    }
    Ok(())
}
