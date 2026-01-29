use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use codeview_rustdoc::{CallMode, generate_workspace_rustdoc_json, load_workspace_graph};
use serde::{Deserialize, Serialize};

const SIDECAR: &[u8] = include_bytes!(env!("SIDECAR_PATH"));

#[derive(Parser)]
#[command(name = "codeview", version, about = "Codeview CLI")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Analyze a Rust workspace and open the interactive UI
    Ui {
        /// Path to the workspace (defaults to current directory)
        #[arg(default_value = ".")]
        path: PathBuf,
        /// Port for UI server (OS assigns one if not specified)
        #[arg(long)]
        port: Option<u16>,
        /// Open the browser automatically
        #[arg(long)]
        open: bool,
        /// Show cargo rustdoc output and detailed progress
        #[arg(long, short)]
        verbose: bool,
        /// Serve a pre-built graph.json instead of analyzing
        #[arg(long)]
        graph: Option<PathBuf>,
        #[arg(long, value_enum, default_value = "strict")]
        call_mode: CallModeArg,
        /// Extra arguments to pass to cargo rustdoc (e.g. --all-features, --features "uuid")
        #[arg(last = true)]
        cargo_args: Vec<String>,
    },
    /// List running codeview server instances
    Ps,
    /// Analyze without opening UI (just generate graph.json)
    Analyze {
        #[arg(long)]
        manifest_path: Option<PathBuf>,
        #[arg(long)]
        out: Option<PathBuf>,
        /// Show cargo rustdoc output and detailed progress
        #[arg(long, short)]
        verbose: bool,
        #[arg(long, value_enum, default_value = "strict")]
        call_mode: CallModeArg,
        /// Extra arguments to pass to cargo rustdoc (e.g. --all-features, --features "uuid")
        #[arg(last = true)]
        cargo_args: Vec<String>,
    },
}

#[derive(Copy, Clone, Debug, ValueEnum)]
enum CallModeArg {
    Strict,
    Ambiguous,
}

#[derive(Serialize, Deserialize)]
struct Instance {
    pid: u32,
    port: u16,
    url: String,
    workspace: Option<String>,
    graph: String,
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Commands::Ui {
            path,
            port,
            open,
            verbose,
            graph,
            call_mode,
            cargo_args,
        } => {
            // If --graph is provided, just serve that directly
            if let Some(graph_path) = graph {
                let workspace_root = workspace_root_from_graph(&graph_path);
                return serve_ui(port, open, verbose, graph_path, workspace_root);
            }

            // Otherwise, analyze the workspace first
            let manifest_path = if path.is_file() {
                path.clone()
            } else {
                path.join("Cargo.toml")
            };

            if !manifest_path.exists() {
                anyhow::bail!("No Cargo.toml found at {}", manifest_path.display());
            }

            let graph_path = analyze_workspace(&manifest_path, call_mode, &cargo_args, verbose)?;
            let workspace_root = manifest_path.parent().map(|p| p.to_path_buf());
            serve_ui(port, open, verbose, graph_path, workspace_root)
        }
        Commands::Ps => list_instances(),
        Commands::Analyze {
            manifest_path,
            out,
            verbose,
            call_mode,
            cargo_args,
        } => analyze(manifest_path, out, verbose, call_mode, cargo_args),
    }
}

/// Analyze workspace and return the path to the generated graph.json
fn analyze_workspace(
    manifest_path: &Path,
    call_mode: CallModeArg,
    cargo_args: &[String],
    verbose: bool,
) -> Result<PathBuf> {
    let rustdoc_jsons = generate_workspace_rustdoc_json(manifest_path, cargo_args, verbose)?;
    if rustdoc_jsons.is_empty() {
        anyhow::bail!("No crates were successfully documented");
    }

    if verbose {
        eprintln!("Merging {} crate graphs...", rustdoc_jsons.len());
    }

    let workspace = load_workspace_graph(&rustdoc_jsons, manifest_path, call_mode.into())?;

    if verbose {
        let total_nodes: usize = workspace
            .crates
            .iter()
            .map(|c| c.nodes.len())
            .sum::<usize>()
            + workspace
                .external_crates
                .iter()
                .map(|c| c.nodes.len())
                .sum::<usize>();
        let total_edges: usize = workspace
            .crates
            .iter()
            .map(|c| c.edges.len())
            .sum::<usize>()
            + workspace.cross_crate_edges.len();

        eprintln!(
            "Generated workspace with {} crates, {} external crates, {} nodes, {} edges",
            workspace.crates.len(),
            workspace.external_crates.len(),
            total_nodes,
            total_edges,
        );
    }

    let out_path = default_graph_path(&rustdoc_jsons[0].json_path);
    if let Some(parent) = out_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create output dir {}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(&workspace)?;
    fs::write(&out_path, &json)
        .with_context(|| format!("failed to write graph to {}", out_path.display()))?;

    if verbose {
        eprintln!("Wrote graph to {}", out_path.display());
    }
    Ok(out_path)
}

fn analyze(
    manifest_path: Option<PathBuf>,
    out: Option<PathBuf>,
    verbose: bool,
    call_mode: CallModeArg,
    cargo_args: Vec<String>,
) -> Result<()> {
    let manifest_path = manifest_path.unwrap_or_else(|| PathBuf::from("Cargo.toml"));

    let rustdoc_jsons = generate_workspace_rustdoc_json(&manifest_path, &cargo_args, verbose)?;
    if rustdoc_jsons.is_empty() {
        anyhow::bail!("No crates were successfully documented");
    }

    if verbose {
        eprintln!("Merging {} crate graphs...", rustdoc_jsons.len());
    }

    let workspace = load_workspace_graph(&rustdoc_jsons, &manifest_path, call_mode.into())?;

    if verbose {
        let total_nodes: usize = workspace
            .crates
            .iter()
            .map(|c| c.nodes.len())
            .sum::<usize>()
            + workspace
                .external_crates
                .iter()
                .map(|c| c.nodes.len())
                .sum::<usize>();
        let total_edges: usize = workspace
            .crates
            .iter()
            .map(|c| c.edges.len())
            .sum::<usize>()
            + workspace.cross_crate_edges.len();

        eprintln!(
            "Generated workspace with {} crates, {} external crates, {} nodes, {} edges",
            workspace.crates.len(),
            workspace.external_crates.len(),
            total_nodes,
            total_edges,
        );
    }

    let out_path = out.unwrap_or_else(|| default_graph_path(&rustdoc_jsons[0].json_path));
    if let Some(parent) = out_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create output dir {}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(&workspace)?;
    fs::write(&out_path, json)
        .with_context(|| format!("failed to write graph to {}", out_path.display()))?;

    eprintln!("Wrote graph to {}", out_path.display());
    Ok(())
}

impl From<CallModeArg> for CallMode {
    fn from(value: CallModeArg) -> Self {
        match value {
            CallModeArg::Strict => CallMode::Strict,
            CallModeArg::Ambiguous => CallMode::Ambiguous,
        }
    }
}

fn default_graph_path(rustdoc_json: &Path) -> PathBuf {
    rustdoc_json
        .parent()
        .and_then(Path::parent)
        .unwrap_or_else(|| Path::new("target"))
        .join("codeview")
        .join("graph.json")
}

/// Derive workspace root from graph path.
///
/// graph.json is typically at `<workspace>/target/codeview/graph.json`,
/// so we go up 3 levels from the file to get the workspace root.
fn workspace_root_from_graph(graph_path: &Path) -> Option<PathBuf> {
    graph_path
        .canonicalize()
        .ok()?
        .parent()? // codeview/
        .parent()? // target/
        .parent() // workspace root
        .map(|p| p.to_path_buf())
}

/// Resolve the port to use: if specified, check availability and fall back to
/// OS-assigned; if not specified, let the OS pick a free port.
fn resolve_port(preferred: Option<u16>) -> u16 {
    use std::net::TcpListener;
    if let Some(port) = preferred {
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return port;
        }
        eprintln!("Port {port} is in use, finding an open port...");
    }
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(4173)
}

fn instances_dir() -> PathBuf {
    std::env::temp_dir().join("codeview-instances")
}

fn register_instance(instance: &Instance) {
    let dir = instances_dir();
    let _ = fs::create_dir_all(&dir);
    let path = dir.join(format!("{}.json", instance.pid));
    let _ = fs::write(path, serde_json::to_string(instance).unwrap_or_default());
}

fn unregister_instance(pid: u32) {
    let path = instances_dir().join(format!("{pid}.json"));
    let _ = fs::remove_file(path);
}

fn is_process_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use std::ffi::c_void;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
            fn CloseHandle(handle: *mut c_void) -> i32;
            fn GetExitCodeProcess(handle: *mut c_void, code: *mut u32) -> i32;
        }
        const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
        const STILL_ACTIVE: u32 = 259;
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return false;
            }
            let mut code: u32 = 0;
            let ok = GetExitCodeProcess(handle, &mut code);
            CloseHandle(handle);
            ok != 0 && code == STILL_ACTIVE
        }
    }
    #[cfg(unix)]
    {
        // kill(pid, 0) checks existence without sending a signal
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }
}

fn list_instances() -> Result<()> {
    let dir = instances_dir();
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => {
            println!("No running instances.");
            return Ok(());
        }
    };

    let mut found = false;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "json") {
            let data = match fs::read_to_string(&path) {
                Ok(d) => d,
                Err(_) => continue,
            };
            let inst: Instance = match serde_json::from_str(&data) {
                Ok(i) => i,
                Err(_) => {
                    let _ = fs::remove_file(&path);
                    continue;
                }
            };
            if !is_process_alive(inst.pid) {
                let _ = fs::remove_file(&path);
                continue;
            }
            if !found {
                println!("{:<8} {:<8} {:<30} WORKSPACE", "PID", "PORT", "URL");
                found = true;
            }
            println!(
                "{:<8} {:<8} {:<30} {}",
                inst.pid,
                inst.port,
                inst.url,
                inst.workspace.as_deref().unwrap_or("-"),
            );
        }
    }

    if !found {
        println!("No running instances.");
    }

    Ok(())
}

fn serve_ui(
    port: Option<u16>,
    open: bool,
    verbose: bool,
    graph_path: PathBuf,
    workspace_root: Option<PathBuf>,
) -> Result<()> {
    use std::process::Command;

    let port = resolve_port(port);
    let pid = std::process::id();

    // Extract sidecar to a per-instance temp location so multiple instances can coexist
    let temp_dir = std::env::temp_dir().join(format!("codeview-{pid}"));
    fs::create_dir_all(&temp_dir)?;

    let sidecar_path = temp_dir.join(sidecar_name());

    fs::write(&sidecar_path, SIDECAR)
        .with_context(|| format!("failed to write sidecar to {}", sidecar_path.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&sidecar_path, fs::Permissions::from_mode(0o755))?;
    }

    let mut cmd = Command::new(&sidecar_path);
    cmd.env("PORT", port.to_string());

    if let Some(root) = &workspace_root {
        cmd.env("CODEVIEW_WORKSPACE", root);
        if verbose {
            eprintln!("Workspace root: {}", root.display());
        }
    }

    let canonical = graph_path
        .canonicalize()
        .unwrap_or_else(|_| graph_path.clone());
    cmd.env("CODEVIEW_GRAPH", &canonical);
    if verbose {
        eprintln!("Graph: {}", canonical.display());
    }

    // On Unix, use pre_exec to tell the child to receive SIGKILL when the
    // parent dies. This must be set before spawn.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                // PR_SET_PDEATHSIG = 1; SIGKILL = 9
                libc::prctl(1, 9);
                Ok(())
            });
        }
    }

    let mut child = cmd
        .spawn()
        .with_context(|| format!("failed to spawn sidecar at {}", sidecar_path.display()))?;

    // On Windows, use a Job Object so the child is killed when the CLI exits.
    #[cfg(windows)]
    {
        if let Err(err) = assign_child_to_job(&child) {
            eprintln!("Warning: could not tie server lifetime to CLI: {err}");
        }
    }

    let url = format!("http://127.0.0.1:{port}");
    eprintln!("Codeview UI running at {url}");

    register_instance(&Instance {
        pid,
        port,
        url: url.clone(),
        workspace: workspace_root.as_ref().map(|p| p.display().to_string()),
        graph: canonical.display().to_string(),
    });

    if open && let Err(err) = open::that(&url) {
        eprintln!("Failed to open browser: {err}");
        eprintln!("Please open {url} manually");
    }

    let running = Arc::new(AtomicBool::new(true));
    let r = running.clone();
    ctrlc::set_handler(move || {
        r.store(false, Ordering::SeqCst);
    })
    .context("failed to set Ctrl+C handler")?;

    while running.load(Ordering::SeqCst) {
        match child.try_wait() {
            Ok(Some(status)) => {
                unregister_instance(pid);
                cleanup_temp(&temp_dir);
                if !status.success() {
                    anyhow::bail!("sidecar exited with status {status}");
                }
                return Ok(());
            }
            Ok(None) => {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(err) => {
                anyhow::bail!("failed to wait for sidecar: {err}");
            }
        }
    }

    eprintln!("\nShutting down...");
    let _ = child.kill();
    let _ = child.wait();
    unregister_instance(pid);
    cleanup_temp(&temp_dir);
    Ok(())
}

fn cleanup_temp(dir: &Path) {
    let _ = fs::remove_dir_all(dir);
}

/// On Windows, assign the child process to a Job Object configured to kill
/// all processes when the last handle closes (i.e. when the CLI exits, even
/// if killed unexpectedly). This prevents orphaned server processes.
#[cfg(windows)]
fn assign_child_to_job(child: &std::process::Child) -> Result<()> {
    use std::mem;
    use std::os::windows::io::AsRawHandle;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(
            lpJobAttributes: *mut std::ffi::c_void,
            lpName: *const u16,
        ) -> *mut std::ffi::c_void;
        fn SetInformationJobObject(
            hJob: *mut std::ffi::c_void,
            JobObjectInformationClass: u32,
            lpJobObjectInformation: *const std::ffi::c_void,
            cbJobObjectInformationLength: u32,
        ) -> i32;
        fn AssignProcessToJobObject(
            hJob: *mut std::ffi::c_void,
            hProcess: *mut std::ffi::c_void,
        ) -> i32;
    }

    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    const JOB_OBJECT_INFO_CLASS_EXTENDED: u32 = 9;

    #[repr(C)]
    struct IoCounters {
        _data: [u64; 6],
    }

    #[repr(C)]
    struct BasicLimitInformation {
        _per_process_user_time: i64,
        _per_job_user_time: i64,
        limit_flags: u32,
        _min_working_set: usize,
        _max_working_set: usize,
        _active_process_limit: u32,
        _affinity: usize,
        _priority_class: u32,
        _scheduling_class: u32,
    }

    #[repr(C)]
    struct ExtendedLimitInformation {
        basic: BasicLimitInformation,
        _io: IoCounters,
        _process_memory_limit: usize,
        _job_memory_limit: usize,
        _peak_process_memory_used: usize,
        _peak_job_memory_used: usize,
    }

    unsafe {
        let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
        if job.is_null() {
            anyhow::bail!("CreateJobObjectW failed");
        }

        let mut info: ExtendedLimitInformation = mem::zeroed();
        info.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        let ret = SetInformationJobObject(
            job,
            JOB_OBJECT_INFO_CLASS_EXTENDED,
            &info as *const _ as *const std::ffi::c_void,
            mem::size_of::<ExtendedLimitInformation>() as u32,
        );
        if ret == 0 {
            anyhow::bail!("SetInformationJobObject failed");
        }

        let handle = child.as_raw_handle();
        let ret = AssignProcessToJobObject(job, handle);
        if ret == 0 {
            anyhow::bail!("AssignProcessToJobObject failed");
        }

        // Keep the job handle alive for the lifetime of the process. When
        // the CLI exits, Windows closes the handle and kills all job processes.
        static JOB_HANDLE: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
        JOB_HANDLE.get_or_init(|| job as usize);
    }

    Ok(())
}

fn sidecar_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "codeview-server.exe"
    } else {
        "codeview-server"
    }
}
