use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Recursively emit rerun-if-changed for all files in a directory
fn watch_dir_recursive(dir: &Path) {
    if !dir.exists() {
        return;
    }

    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            // Skip node_modules and .svelte-kit
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name == "node_modules" || name == ".svelte-kit" || name == "dist" {
                continue;
            }
            watch_dir_recursive(&path);
        } else {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }
}

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("missing manifest dir"));
    let ui_dir = manifest_dir.parent().unwrap().join("codeview-ui");
    let target = env::var("TARGET").unwrap();

    // Rebuild when UI source changes (recursively watch all files)
    watch_dir_recursive(&ui_dir.join("src"));

    // Watch config files
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
        ui_dir.join("vite.config.ts").display()
    );

    // Rebuild when the codeview-rustdoc Rust source changes (triggers wasm:build)
    let rustdoc_dir = manifest_dir.parent().unwrap().join("codeview-rustdoc");
    watch_dir_recursive(&rustdoc_dir.join("src"));
    println!(
        "cargo:rerun-if-changed={}",
        rustdoc_dir.join("Cargo.toml").display()
    );

    // @jesterkit/exe-sveltekit builds directly to dist/codeview-server
    // It handles cross-compilation via EXE_TARGET env var
    let exe_target = match target.as_str() {
        t if t.contains("x86_64") && t.contains("linux") => "linux-x64",
        t if t.contains("aarch64") && t.contains("linux") => "linux-arm64",
        t if t.contains("x86_64") && t.contains("darwin") => "darwin-x64",
        t if t.contains("aarch64") && t.contains("darwin") => "darwin-arm64",
        t if t.contains("x86_64") && t.contains("windows") => "windows-x64",
        _ => panic!("Unsupported target for sidecar: {target}"),
    };

    let sidecar_dir = manifest_dir.join("sidecar");
    std::fs::create_dir_all(&sidecar_dir).expect("failed to create sidecar dir");

    let sidecar_name = if target.contains("windows") {
        format!("codeview-server-{exe_target}.exe")
    } else {
        format!("codeview-server-{exe_target}")
    };
    let sidecar_path = sidecar_dir.join(&sidecar_name);

    if env::var_os("CODEVIEW_SKIP_SIDECAR").is_some() {
        fs::write(&sidecar_path, []).expect("failed to write placeholder sidecar");
        println!("cargo:rustc-env=SIDECAR_PATH={}", sidecar_path.display());
        return;
    }

    // Build SvelteKit app with @jesterkit/exe-sveltekit adapter
    // This adapter builds directly to dist/codeview-server(.exe)
    let status = Command::new("bun")
        .args(["run", "build"])
        .env("EXE_TARGET", exe_target)
        .current_dir(&ui_dir)
        .status()
        .expect("failed to run `bun run build` - is bun installed?");

    if !status.success() {
        panic!("`bun run build` failed in {}", ui_dir.display());
    }

    // Copy the built binary to sidecar dir
    let built_name = if target.contains("windows") {
        "codeview-server.exe"
    } else {
        "codeview-server"
    };
    let built_path = ui_dir.join("dist").join(built_name);

    if !built_path.exists() {
        panic!("Built binary not found at {}", built_path.display());
    }

    std::fs::copy(&built_path, &sidecar_path).expect("failed to copy sidecar binary");

    println!("cargo:rustc-env=SIDECAR_PATH={}", sidecar_path.display());
}
