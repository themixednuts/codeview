use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("missing manifest dir"));
    let ui_dir = manifest_dir.parent().unwrap().join("codeview-ui");
    let target = env::var("TARGET").unwrap();

    // Rebuild when UI source changes
    println!("cargo:rerun-if-changed={}", ui_dir.join("src").display());
    println!("cargo:rerun-if-changed={}", ui_dir.join("package.json").display());
    println!("cargo:rerun-if-changed={}", ui_dir.join("svelte.config.js").display());
    println!("cargo:rerun-if-changed={}", ui_dir.join("vite.config.ts").display());

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

    std::fs::copy(&built_path, &sidecar_path)
        .expect("failed to copy sidecar binary");

    println!(
        "cargo:rustc-env=SIDECAR_PATH={}",
        sidecar_path.display()
    );
}
