use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use codeview_core::{Graph, MermaidKind, export_mermaid};
use codeview_rustdoc::{CallMode, generate_workspace_rustdoc_json, load_workspace_graph};
use include_dir::{Dir, include_dir};
use tiny_http::{Header, Method, Response, Server, StatusCode};

static UI_DIR: Dir = include_dir!("$OUT_DIR/codeview-ui");

#[derive(Parser)]
#[command(name = "codeview", version, about = "Codeview CLI")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    Analyze {
        #[arg(long)]
        manifest_path: Option<PathBuf>,
        #[arg(long)]
        out: Option<PathBuf>,
        #[arg(long, value_enum, default_value = "strict")]
        call_mode: CallModeArg,
    },
    Export {
        #[arg(long)]
        input: PathBuf,
        #[arg(long, value_enum, default_value = "mermaid-flow")]
        format: ExportFormat,
        #[arg(long)]
        out: PathBuf,
    },
    Ui {
        #[arg(long, default_value_t = 5173)]
        port: u16,
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
        Commands::Analyze {
            manifest_path,
            out,
            call_mode,
        } => analyze(manifest_path, out, call_mode),
        Commands::Export { input, format, out } => export_graph(input, format, out),
        Commands::Ui { port } => serve_ui(port),
    }
}

fn analyze(
    manifest_path: Option<PathBuf>,
    out: Option<PathBuf>,
    call_mode: CallModeArg,
) -> Result<()> {
    let manifest_path = manifest_path.unwrap_or_else(|| PathBuf::from("Cargo.toml"));

    // Generate rustdoc for all workspace members
    let rustdoc_jsons = generate_workspace_rustdoc_json(&manifest_path)?;
    if rustdoc_jsons.is_empty() {
        anyhow::bail!("No crates were successfully documented");
    }

    eprintln!("Merging {} crate graphs...", rustdoc_jsons.len());

    // Load and merge all graphs
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

fn serve_ui(port: u16) -> Result<()> {
    let address = format!("127.0.0.1:{port}");
    let server =
        Server::http(&address).map_err(|err| anyhow::anyhow!("failed to bind {address}: {err}"))?;
    println!("Codeview UI running at http://{address}");

    for request in server.incoming_requests() {
        if let Err(error) = handle_ui_request(request) {
            eprintln!("failed to handle request: {error}");
        }
    }
    Ok(())
}

fn handle_ui_request(request: tiny_http::Request) -> Result<()> {
    let is_head = request.method() == &Method::Head;
    if request.method() != &Method::Get && !is_head {
        let response = Response::empty(StatusCode(405));
        request.respond(response)?;
        return Ok(());
    }

    let url = request.url();
    let path = url.split('?').next().unwrap_or("/");
    let path = path.trim_start_matches('/');
    let file_path = if path.is_empty() { "index.html" } else { path };

    let file = UI_DIR
        .get_file(file_path)
        .or_else(|| UI_DIR.get_file("index.html"));

    match file {
        Some(file) => {
            let mime = mime_guess::from_path(file.path()).first_or_octet_stream();
            let header = Header::from_bytes("Content-Type", mime.as_ref())
                .map_err(|_| anyhow::anyhow!("failed to build content-type header"))?;
            let response = if is_head {
                Response::empty(StatusCode(200)).with_header(header).boxed()
            } else {
                Response::from_data(file.contents())
                    .with_header(header)
                    .boxed()
            };
            request.respond(response)?;
        }
        None => {
            let response = Response::empty(StatusCode(404));
            request.respond(response)?;
        }
    }
    Ok(())
}
