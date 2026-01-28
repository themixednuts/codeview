use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use codeview_core::{Graph, MermaidKind, export_mermaid};
use codeview_rustdoc::{CallMode, generate_workspace_rustdoc_json, load_workspace_graph};

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
        /// Serve a pre-built graph.json instead of analyzing
        #[arg(long)]
        graph: Option<PathBuf>,
        #[arg(long, value_enum, default_value = "strict")]
        call_mode: CallModeArg,
        /// Extra arguments to pass to cargo rustdoc (e.g. --all-features, --features "uuid")
        #[arg(last = true)]
        cargo_args: Vec<String>,
    },
    /// Analyze without opening UI (just generate graph.json)
    Analyze {
        #[arg(long)]
        manifest_path: Option<PathBuf>,
        #[arg(long)]
        out: Option<PathBuf>,
        #[arg(long, value_enum, default_value = "strict")]
        call_mode: CallModeArg,
        /// Extra arguments to pass to cargo rustdoc (e.g. --all-features, --features "uuid")
        #[arg(last = true)]
        cargo_args: Vec<String>,
    },
    /// Export graph to other formats
    Export {
        #[arg(long)]
        input: PathBuf,
        #[arg(long, value_enum, default_value = "mermaid-flow")]
        format: ExportFormat,
        #[arg(long)]
        out: PathBuf,
    },
}

#[derive(Copy, Clone, Debug, ValueEnum)]
enum ExportFormat {
    MermaidFlow,
    MermaidClass,
}

#[derive(Copy, Clone, Debug, ValueEnum)]
enum CallModeArg {
    Strict,
    Ambiguous,
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Commands::Ui {
            path,
            port,
            graph,
            call_mode,
            cargo_args,
        } => {
            // If --graph is provided, just serve that directly
            if let Some(graph_path) = graph {
                let workspace_root = workspace_root_from_graph(&graph_path);
                return serve_ui(port, graph_path, workspace_root);
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

            let graph_path = analyze_workspace(&manifest_path, call_mode, &cargo_args)?;
            let workspace_root = manifest_path.parent().map(|p| p.to_path_buf());
            serve_ui(port, graph_path, workspace_root)
        }
        Commands::Analyze {
            manifest_path,
            out,
            call_mode,
            cargo_args,
        } => analyze(manifest_path, out, call_mode, cargo_args),
        Commands::Export { input, format, out } => export_graph(input, format, out),
    }
}

/// Analyze workspace and return the path to the generated graph.json
fn analyze_workspace(
    manifest_path: &Path,
    call_mode: CallModeArg,
    cargo_args: &[String],
) -> Result<PathBuf> {
    let rustdoc_jsons = generate_workspace_rustdoc_json(manifest_path, cargo_args)?;
    if rustdoc_jsons.is_empty() {
        anyhow::bail!("No crates were successfully documented");
    }

    eprintln!("Merging {} crate graphs...", rustdoc_jsons.len());

    let graph = load_workspace_graph(&rustdoc_jsons, manifest_path, call_mode.into())?;

    eprintln!(
        "Generated graph with {} nodes and {} edges",
        graph.nodes.len(),
        graph.edges.len()
    );

    let out_path = default_graph_path(&rustdoc_jsons[0].json_path);
    if let Some(parent) = out_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create output dir {}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(&graph)?;
    fs::write(&out_path, &json)
        .with_context(|| format!("failed to write graph to {}", out_path.display()))?;

    eprintln!("Wrote graph to {}", out_path.display());
    Ok(out_path)
}

fn analyze(
    manifest_path: Option<PathBuf>,
    out: Option<PathBuf>,
    call_mode: CallModeArg,
    cargo_args: Vec<String>,
) -> Result<()> {
    let manifest_path = manifest_path.unwrap_or_else(|| PathBuf::from("Cargo.toml"));

    let rustdoc_jsons = generate_workspace_rustdoc_json(&manifest_path, &cargo_args)?;
    if rustdoc_jsons.is_empty() {
        anyhow::bail!("No crates were successfully documented");
    }

    eprintln!("Merging {} crate graphs...", rustdoc_jsons.len());

    let graph = load_workspace_graph(&rustdoc_jsons, &manifest_path, call_mode.into())?;

    eprintln!(
        "Generated graph with {} nodes and {} edges",
        graph.nodes.len(),
        graph.edges.len()
    );

    let out_path = out.unwrap_or_else(|| default_graph_path(&rustdoc_jsons[0].json_path));
    if let Some(parent) = out_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create output dir {}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(&graph)?;
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

fn export_graph(input: PathBuf, format: ExportFormat, out: PathBuf) -> Result<()> {
    let content = fs::read_to_string(&input)
        .with_context(|| format!("failed to read graph json {}", input.display()))?;
    let graph: Graph = serde_json::from_str(&content)?;
    let output = match format {
        ExportFormat::MermaidFlow => export_mermaid(&graph, MermaidKind::Flow),
        ExportFormat::MermaidClass => export_mermaid(&graph, MermaidKind::Class),
    };

    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create output dir {}", parent.display()))?;
    }
    fs::write(&out, output)
        .with_context(|| format!("failed to write export to {}", out.display()))?;

    Ok(())
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
        .parent()  // workspace root
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

fn serve_ui(port: Option<u16>, graph_path: PathBuf, workspace_root: Option<PathBuf>) -> Result<()> {
    use std::process::Command;

    let port = resolve_port(port);

    // Extract sidecar to a persistent temp location
    let temp_dir = std::env::temp_dir().join("codeview");
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
        eprintln!("Workspace root: {}", root.display());
    }

    let canonical = graph_path.canonicalize().unwrap_or_else(|_| graph_path.clone());
    cmd.env("CODEVIEW_GRAPH", &canonical);
    eprintln!("Graph: {}", canonical.display());

    let mut child = cmd
        .spawn()
        .with_context(|| format!("failed to spawn sidecar at {}", sidecar_path.display()))?;

    let url = format!("http://127.0.0.1:{port}");
    eprintln!("Codeview UI running at {url}");

    if let Err(err) = open::that(&url) {
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
    Ok(())
}

fn sidecar_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "codeview-server.exe"
    } else {
        "codeview-server"
    }
}
