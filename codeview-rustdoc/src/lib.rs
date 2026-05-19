// Cross-crate link-extraction helpers (`collect_type_links`,
// `collect_bound_links`, etc.) are kept for the source-map / call-graph
// path even though the structured TypeRef refactor moved most consumers
// off them. Suppressing the dead-code lint here is cheaper than a
// surgical removal that would risk regressing the still-live call sites.

use std::collections::{HashMap, HashSet};
#[cfg(feature = "native")]
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(feature = "native")]
use std::process::Command;

#[cfg(feature = "native")]
use cargo_metadata::{MetadataCommand, TargetKind};
use codeview_core::{
    ArgumentInfo, Confidence, CrateGraph, Deprecation, Edge, EdgeKind, ExternalCrate, FieldInfo,
    FunctionSignature, Graph, ImplCategory, ImplType, Node, NodeKind, Span, VariantInfo,
    VariantKind as CvVariantKind, Visibility, Workspace,
};
use rustdoc_types as rdt;
use syn::visit::Visit;
use thiserror::Error;

#[cfg(feature = "wasm")]
mod wasm;

#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

#[cfg(feature = "wasm")]
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = log)]
    fn console_log(s: &str);
}

#[cfg(feature = "wasm")]
macro_rules! wasm_log {
    ($($arg:tt)*) => { console_log(&format!($($arg)*)) };
}

#[derive(Debug, Error)]
pub enum RustdocError {
    #[error("failed to read rustdoc json: {0}")]
    Io(#[from] std::io::Error),
    #[error("failed to parse rustdoc json: {0}")]
    Json(#[from] serde_json::Error),
    #[cfg(feature = "native")]
    #[error("failed to read cargo metadata: {0}")]
    Metadata(#[from] cargo_metadata::Error),
    #[error("failed to parse source: {0}")]
    Syn(#[from] syn::Error),
    #[error("cargo rustdoc failed with status: {0}")]
    RustdocFailed(std::process::ExitStatus),
    #[error("missing root package in workspace metadata")]
    MissingRootPackage,
}

#[cfg(feature = "native")]
#[derive(Debug, Clone)]
pub struct RustdocJson {
    pub crate_name: String,
    /// The name rustdoc uses internally (may differ from crate_name for binary crates)
    pub rustdoc_name: String,
    pub json_path: PathBuf,
    pub manifest_path: PathBuf,
    /// Path to the crate root source file (lib.rs or main.rs)
    pub src_path: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallMode {
    Strict,
    Ambiguous,
}

impl CallMode {
    fn allow_ambiguous(self) -> bool {
        matches!(self, Self::Ambiguous)
    }
}

#[cfg(feature = "native")]
fn is_lib_target(kind: &TargetKind) -> bool {
    matches!(
        kind,
        TargetKind::Lib
            | TargetKind::RLib
            | TargetKind::CDyLib
            | TargetKind::DyLib
            | TargetKind::StaticLib
            | TargetKind::ProcMacro
    )
}

#[cfg(feature = "native")]
fn get_workspace_members(manifest_path: &Path) -> Result<HashSet<String>, RustdocError> {
    let metadata = MetadataCommand::new().manifest_path(manifest_path).exec()?;
    let members: HashSet<String> = metadata
        .workspace_packages()
        .iter()
        .map(|pkg| pkg.name.replace('-', "_"))
        .collect();
    Ok(members)
}

#[cfg(feature = "native")]
pub fn generate_rustdoc_json(manifest_path: &Path) -> Result<RustdocJson, RustdocError> {
    let metadata = MetadataCommand::new().manifest_path(manifest_path).exec()?;
    let package = metadata
        .root_package()
        .ok_or(RustdocError::MissingRootPackage)?;
    // Normalize crate name: Cargo uses hyphens but Rust uses underscores internally
    let crate_name = package.name.replace('-', "_");
    let lib_target = package
        .targets
        .iter()
        .find(|t| t.kind.iter().any(|k| is_lib_target(k)));
    let primary_target = lib_target
        .or_else(|| {
            package
                .targets
                .iter()
                .find(|t| t.kind.iter().any(|k| matches!(k, TargetKind::Bin)))
        })
        .ok_or(RustdocError::MissingRootPackage)?;
    let src_path = primary_target.src_path.clone().into_std_path_buf();

    // For lib crates the rustdoc name matches the crate name; for binary crates
    // rustdoc uses the target (binary) name which may differ from the package name.
    let rustdoc_name = if lib_target.is_some() {
        crate_name.clone()
    } else {
        primary_target.name.replace('-', "_")
    };

    let status = Command::new("cargo")
        .arg("+nightly")
        .arg("rustdoc")
        .arg("--manifest-path")
        .arg(manifest_path)
        .arg("--")
        .arg("-Zunstable-options")
        .arg("--output-format")
        .arg("json")
        .status()?;

    if !status.success() {
        return Err(RustdocError::RustdocFailed(status));
    }

    let target_dir = metadata.target_directory.into_std_path_buf();
    let crate_file = format!("{rustdoc_name}.json");
    let json_path = target_dir.join("doc").join(crate_file);

    Ok(RustdocJson {
        crate_name,
        rustdoc_name,
        json_path,
        manifest_path: manifest_path.to_path_buf(),
        src_path,
    })
}

/// Generate rustdoc JSON for all workspace members
#[cfg(feature = "native")]
pub fn generate_workspace_rustdoc_json(
    manifest_path: &Path,
    cargo_args: &[String],
    verbose: bool,
) -> Result<Vec<RustdocJson>, RustdocError> {
    let metadata = MetadataCommand::new().manifest_path(manifest_path).exec()?;
    let workspace_root = metadata.workspace_root.as_std_path().to_path_buf();
    let target_dir = metadata.target_directory.as_std_path().to_path_buf();

    let mut results = Vec::new();

    for package in metadata.workspace_packages() {
        // Normalize crate name: Cargo uses hyphens but Rust uses underscores internally
        let crate_name = package.name.replace('-', "_");
        let pkg_manifest = package.manifest_path.as_std_path();

        if verbose {
            eprintln!("Documenting {} ...", crate_name);
        }

        // Determine the right target flag: prefer --lib, fall back to first bin
        let lib_target = package
            .targets
            .iter()
            .find(|t| t.kind.iter().any(|k| is_lib_target(k)));
        let bin_target = package
            .targets
            .iter()
            .find(|t| t.kind.iter().any(|k| matches!(k, TargetKind::Bin)));
        let primary_target = lib_target.or(bin_target);
        let Some(primary_target) = primary_target else {
            if verbose {
                eprintln!("Warning: no lib or bin target for {}", crate_name);
            }
            continue;
        };
        let src_path = primary_target.src_path.clone().into_std_path_buf();

        let mut cmd = Command::new("cargo");
        cmd.arg("+nightly")
            .arg("rustdoc")
            .arg("--manifest-path")
            .arg(pkg_manifest);

        if lib_target.is_some() {
            cmd.arg("--lib");
        } else {
            cmd.arg("--bin").arg(&primary_target.name);
        }

        // Add user-provided cargo args (e.g. --all-features, --features "uuid")
        for arg in cargo_args {
            cmd.arg(arg);
        }

        cmd.arg("--")
            .arg("-Zunstable-options")
            .arg("--output-format")
            .arg("json")
            .current_dir(&workspace_root);

        if !verbose {
            cmd.stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::piped());
        }

        if verbose {
            let status = cmd.status()?;
            if !status.success() {
                eprintln!("Warning: rustdoc failed for {}", crate_name);
                continue;
            }
        } else {
            let output = cmd.output()?;
            if !output.status.success() {
                eprintln!("Warning: rustdoc failed for {}", crate_name);
                let stderr = String::from_utf8_lossy(&output.stderr);
                if !stderr.is_empty() {
                    eprintln!("{}", stderr.trim_end());
                }
                continue;
            }
        }

        // For lib crates the rustdoc name matches the crate name; for binary crates
        // rustdoc uses the target (binary) name which may differ from the package name.
        let rustdoc_name = if lib_target.is_some() {
            crate_name.replace('-', "_")
        } else {
            primary_target.name.replace('-', "_")
        };
        let crate_file = format!("{rustdoc_name}.json");
        let json_path = target_dir.join("doc").join(crate_file);

        if json_path.exists() {
            results.push(RustdocJson {
                crate_name,
                rustdoc_name,
                json_path,
                manifest_path: pkg_manifest.to_path_buf(),
                src_path: src_path.clone(),
            });
        }
    }

    Ok(results)
}

/// Load and merge graphs from multiple rustdoc JSON files into a Workspace.
#[cfg(feature = "native")]
pub fn load_workspace_graph(
    rustdoc_jsons: &[RustdocJson],
    manifest_path: &Path,
    call_mode: CallMode,
) -> Result<Workspace, RustdocError> {
    let mut nodes_by_id: HashMap<String, Node> = HashMap::new();
    let mut edge_keys = HashSet::new();
    let mut edges = Vec::new();

    // Collect crate versions from cargo metadata
    let mut all_crate_versions: HashMap<String, String> = HashMap::new();
    let workspace_members: HashSet<String> =
        if let Ok(metadata) = MetadataCommand::new().manifest_path(manifest_path).exec() {
            // Collect versions for ALL packages (including dependencies)
            for package in &metadata.packages {
                let crate_name = package.name.replace('-', "_");
                all_crate_versions.insert(crate_name, package.version.to_string());
            }
            // Workspace members are the subset we fully analyze
            metadata
                .workspace_packages()
                .iter()
                .map(|pkg| pkg.name.replace('-', "_"))
                .collect()
        } else {
            HashSet::new()
        };

    // Resolve rustc version for std-lib crates (std, core, alloc).
    // Cargo metadata doesn't include these, so we fall back to `rustc +nightly --version`.
    let rustc_version: Option<String> = Command::new("rustc")
        .arg("+nightly")
        .arg("--version")
        .output()
        .ok()
        .and_then(|out| {
            let text = String::from_utf8_lossy(&out.stdout);
            // Output: "rustc 1.XX.0-nightly (hash date)"
            text.split_whitespace().nth(1).map(|v| v.to_string())
        });

    for rustdoc in rustdoc_jsons {
        let rustdoc_name_opt = if rustdoc.rustdoc_name != rustdoc.crate_name {
            Some(rustdoc.rustdoc_name.as_str())
        } else {
            None
        };
        let graph = load_graph_from_path_with_sources(
            &rustdoc.json_path,
            &rustdoc.crate_name,
            manifest_path,
            &rustdoc.src_path,
            call_mode,
            rustdoc_name_opt,
        )?;

        // Merge nodes, preferring nodes with more complete data
        for node in graph.nodes {
            match nodes_by_id.entry(node.id.clone()) {
                std::collections::hash_map::Entry::Vacant(entry) => {
                    entry.insert(node);
                }
                std::collections::hash_map::Entry::Occupied(mut entry) => {
                    // Prefer the node with more complete data (fields, span, etc.)
                    let existing = entry.get();
                    if node_is_more_complete(&node, existing) {
                        entry.insert(node);
                    }
                }
            }
        }

        // Merge edges (deduplicate by from+to+kind)
        for edge in graph.edges {
            let key = format!("{}|{}|{:?}", edge.from, edge.to, edge.kind);
            if edge_keys.insert(key) {
                edges.push(edge);
            }
        }
    }

    // Partition nodes and edges into per-crate graphs
    let all_nodes: Vec<Node> = nodes_by_id.into_values().collect();

    // Determine which crate a node belongs to by its ID prefix
    let node_crate = |id: &str| -> String {
        // Node IDs are like "crate_name::module::Item" or just "crate_name"
        let crate_name = id.split("::").next().unwrap_or(id);
        crate_name.to_string()
    };

    // Group nodes by crate
    let mut crate_nodes: HashMap<String, Vec<Node>> = HashMap::new();
    for node in all_nodes {
        let cn = node_crate(&node.id);
        crate_nodes.entry(cn).or_default().push(node);
    }

    // Build per-crate edge lists and cross-crate edge list
    let mut crate_edges: HashMap<String, Vec<Edge>> = HashMap::new();
    let mut cross_crate_edges = Vec::new();
    for edge in edges {
        let from_crate = node_crate(&edge.from);
        let to_crate = node_crate(&edge.to);
        if from_crate == to_crate {
            crate_edges.entry(from_crate).or_default().push(edge);
        } else {
            cross_crate_edges.push(edge);
        }
    }

    // Build workspace member CrateGraphs
    let mut crate_graphs = Vec::new();
    for member in &workspace_members {
        let nodes = crate_nodes.remove(member).unwrap_or_default();
        let edges = crate_edges.remove(member).unwrap_or_default();
        let version = all_crate_versions
            .get(member)
            .cloned()
            .unwrap_or_else(|| "0.0.0".to_string());
        crate_graphs.push(CrateGraph {
            id: member.clone(),
            name: member.clone(),
            version,
            nodes,
            edges,
            aliases: std::collections::HashMap::new(),
        });
    }
    crate_graphs.sort_by(|a, b| a.id.cmp(&b.id));

    // Build external crate stubs from remaining nodes
    const STD_CRATES: &[&str] = &["std", "core", "alloc"];
    let mut external_crates = Vec::new();
    let mut remaining_crate_names: Vec<String> = crate_nodes.keys().cloned().collect();
    remaining_crate_names.sort();
    for ext_name in remaining_crate_names {
        let nodes = crate_nodes.remove(&ext_name).unwrap_or_default();
        // Also include any intra-crate edges for external crates
        let _edges = crate_edges.remove(&ext_name).unwrap_or_default();
        // For std-lib crates, use the nightly rustc version (cargo metadata doesn't list them)
        let version = all_crate_versions.get(&ext_name).cloned().or_else(|| {
            if STD_CRATES.contains(&ext_name.as_str()) {
                rustc_version.clone()
            } else {
                None
            }
        });
        external_crates.push(ExternalCrate {
            id: ext_name.clone(),
            name: ext_name.clone(),
            version,
            nodes,
        });
    }

    Ok(Workspace {
        version: codeview_core::SCHEMA_VERSION,
        crates: crate_graphs,
        external_crates,
        cross_crate_edges,
        repo: None,
        ref_: None,
    })
}

/// Returns true if `new` has more complete data than `existing`
fn node_is_more_complete(new: &Node, existing: &Node) -> bool {
    // Prefer non-external nodes over external ones
    if !new.is_external && existing.is_external {
        return true;
    }
    if new.is_external && !existing.is_external {
        return false;
    }

    // Count how much data each node has
    let new_score = node_completeness_score(new);
    let existing_score = node_completeness_score(existing);
    new_score > existing_score
}

fn node_completeness_score(node: &Node) -> u32 {
    let mut score = 0;
    if node.span.is_some() {
        score += 1;
    }
    if node.fields.is_some() {
        score += 2;
    }
    if node.variants.is_some() {
        score += 2;
    }
    if node.signature.is_some() {
        score += 2;
    }
    if !node.generics.is_empty() {
        score += 1;
    }
    if node.docs.is_some() {
        score += 1;
    }
    if !node.attrs.is_empty() {
        score += 1;
    }
    if node.visibility != Visibility::Unknown {
        score += 1;
    }
    score
}

#[cfg(feature = "native")]
pub fn load_graph_from_path(path: &Path, crate_name: &str) -> Result<Graph, RustdocError> {
    let content = fs::read_to_string(path)?;
    extract_graph(&content, crate_name)
}

#[cfg(feature = "native")]
pub fn load_graph_from_path_with_sources(
    path: &Path,
    crate_name: &str,
    workspace_manifest_path: &Path,
    root_file: &Path,
    call_mode: CallMode,
    rustdoc_name: Option<&str>,
) -> Result<Graph, RustdocError> {
    let content = fs::read_to_string(path)?;
    extract_graph_with_sources(
        &content,
        crate_name,
        workspace_manifest_path,
        root_file,
        call_mode,
        rustdoc_name,
    )
}

// ---------------------------------------------------------------------------
// Multi-version rustdoc JSON compatibility layer
//
// `rustdoc-types` targets FORMAT_VERSION 57. docs.rs serves JSON from whatever
// nightly built the crate, so the format version varies (observed: v35–v57+).
//
// Strategy:
//   1. Fast path — `from_str::<Crate>` directly (zero-copy, zero allocation).
//   2. Slow path — parse to `Value`, apply version-gated in-place fixups,
//      then `from_value`. Only triggers when the fast path fails.
// ---------------------------------------------------------------------------

/// Parse rustdoc JSON with transparent format version compatibility.
///
/// Attempts zero-copy deserialization first. On failure, falls back to
/// in-place JSON fixups based on the document's `format_version`.
fn parse_rustdoc_lenient(json: &str) -> Result<rdt::Crate, RustdocError> {
    #[cfg(feature = "wasm")]
    wasm_log!(
        "[wasm] parse_rustdoc_lenient: starting with {} bytes",
        json.len()
    );
    #[cfg(feature = "wasm")]
    let t0 = js_sys::Date::now();

    // Fast path: zero-copy when the format already matches our target.
    #[cfg(feature = "wasm")]
    wasm_log!("[wasm] parse_rustdoc_lenient: attempting fast path");
    if let Ok(krate) = serde_json::from_str::<rdt::Crate>(json) {
        #[cfg(feature = "wasm")]
        wasm_log!(
            "[wasm] rustdoc parsed (fast path): {:.0}ms",
            js_sys::Date::now() - t0
        );
        return Ok(krate);
    }

    #[cfg(feature = "wasm")]
    let t1 = js_sys::Date::now();

    // Slow path: parse → fixup → materialize.
    let mut doc: serde_json::Value = serde_json::from_str(json)?;

    #[cfg(feature = "wasm")]
    let t2 = js_sys::Date::now();

    let source_version = doc
        .get("format_version")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0) as u32;

    #[cfg(feature = "wasm")]
    wasm_log!(
        "[wasm] rustdoc parsed to Value: {:.0}ms (format_version: {})",
        t2 - t1,
        source_version
    );

    // Drift detection: if rustdoc is serving a *newer* format_version than
    // we know about, log loudly on the native side. The compat layer still
    // does best-effort parsing (fixup_unknown_attrs catches new Attribute
    // variants) but any new structured fields will be silently ignored.
    // Surfacing the drift early lets the maintainer bump rustdoc-types
    // before subtle data loss accumulates across many parsed crates.
    if source_version > rdt::FORMAT_VERSION {
        #[cfg(not(feature = "wasm"))]
        eprintln!(
            "warning: rustdoc JSON format_version {} is newer than our supported v{}. \
             Parsing in best-effort mode; new fields will be ignored. \
             Consider bumping the rustdoc-types crate.",
            source_version,
            rdt::FORMAT_VERSION,
        );
        #[cfg(feature = "wasm")]
        wasm_log!(
            "warning: rustdoc format_version {} > our v{} (best-effort parse)",
            source_version,
            rdt::FORMAT_VERSION
        );
    }

    compat::upgrade(&mut doc, source_version);

    #[cfg(feature = "wasm")]
    let t3 = js_sys::Date::now();

    let result = serde_json::from_value(doc).map_err(Into::into);

    #[cfg(feature = "wasm")]
    wasm_log!(
        "[wasm] rustdoc upgrade + from_value: {:.0}ms",
        js_sys::Date::now() - t3
    );

    result
}

/// In-place JSON fixups for rustdoc format version compatibility.
///
/// Each fixup is gated on the source format version and corresponds to a
/// specific breaking change in `rust-lang/rust/src/rustdoc-json-types`.
///
/// Version changelog (breaking changes only):
///
/// | Ver | Commit         | Breaking change                                       |
/// |-----|----------------|-------------------------------------------------------|
/// | 44  | `8c50f95cf088` | Added required `Crate.target: Target`                 |
/// | 51  | `7fa8901cd090` | `GenericArgs` → `Option<Box<GenericArgs>>` (backward-compatible) |
/// | 54  | `078332fdc8e1` | `Item.attrs`: `Vec<String>` → `Vec<Attribute>`        |
/// | 57  | `361af821ab16` | Added required `ExternalCrate.path: PathBuf`          |
///
/// Non-breaking bumps (v45–v46, v48–v50, v52–v53, v55–v56) only changed
/// attribute pretty-printing or added new enum variants — no fixup needed.
/// v51 is backward-compatible: old JSON with inline `GenericArgs` objects
/// deserializes into `Some(Box<GenericArgs>)`.
mod compat {
    use serde_json::{Value, json};

    const TARGET: u32 = super::rdt::FORMAT_VERSION;

    /// Apply all version-gated fixups to bring `doc` up to our target schema.
    pub fn upgrade(doc: &mut Value, source: u32) {
        if source < 44 && TARGET >= 44 {
            fixup_crate_target(doc);
        }
        if source < 54 && TARGET >= 54 {
            walk(doc, fixup_string_attrs);
        }
        if source < 57 && TARGET >= 57 {
            fixup_external_crate_path(doc);
        }
        // Always: catch unknown Attribute variants from newer nightlies.
        walk(doc, fixup_unknown_attrs);
    }

    /// v44: `Crate` gained required `target: Target`. Inject a default.
    fn fixup_crate_target(doc: &mut Value) {
        let Value::Object(obj) = doc else { return };
        obj.entry("target")
            .or_insert_with(|| json!({"triple": "unknown", "target_features": []}));
    }

    /// v54: `Item.attrs` changed from `Vec<String>` to `Vec<Attribute>`.
    /// Wrap each bare string as `{"other": s}` to match the enum layout.
    fn fixup_string_attrs(map: &mut serde_json::Map<String, Value>) {
        let Some(Value::Array(attrs)) = map.get_mut("attrs") else {
            return;
        };
        for attr in attrs.iter_mut() {
            if let Value::String(s) = attr {
                *attr = json!({"other": std::mem::take(s)});
            }
        }
    }

    /// v57: `ExternalCrate` gained required `path: PathBuf`. Inject empty default.
    fn fixup_external_crate_path(doc: &mut Value) {
        let Some(Value::Object(ext_crates)) = doc.get_mut("external_crates") else {
            return;
        };
        for ec in ext_crates.values_mut() {
            let Value::Object(obj) = ec else { continue };
            obj.entry("path").or_insert(Value::String(String::new()));
        }
    }

    /// Normalize any `Attribute` variant our `rustdoc-types` can't deserialize.
    /// Replaces unrecognized values with `{"other": "<json>"}`.
    fn fixup_unknown_attrs(map: &mut serde_json::Map<String, Value>) {
        let Some(Value::Array(attrs)) = map.get_mut("attrs") else {
            return;
        };
        for attr in attrs.iter_mut() {
            // Strings are either already fixed by fixup_string_attrs or are
            // valid unit variant names — let serde handle them.
            if attr.is_string() {
                continue;
            }
            if serde_json::from_value::<super::rdt::Attribute>(attr.clone()).is_err() {
                *attr = json!({"other": attr.to_string()});
            }
        }
    }

    /// Recursively visit every JSON object, calling `f` on each.
    fn walk(value: &mut Value, f: fn(&mut serde_json::Map<String, Value>)) {
        match value {
            Value::Object(map) => {
                f(map);
                for v in map.values_mut() {
                    walk(v, f);
                }
            }
            Value::Array(arr) => {
                for v in arr.iter_mut() {
                    walk(v, f);
                }
            }
            _ => {}
        }
    }
}

pub fn extract_graph(json: &str, crate_name: &str) -> Result<Graph, RustdocError> {
    let krate = parse_rustdoc_lenient(json)?;
    build_graph(
        &krate,
        crate_name,
        BuildGraphOptions {
            workspace_members: None,
            source: None,
            call_mode: CallMode::Strict,
            skip_external_nodes: true,
            rustdoc_name: None,
        },
    )
}

/// Extract a crate graph with call edges from in-memory source files.
///
/// `source_files` maps relative paths (e.g. "src/lib.rs") to their content.
/// `root_file` (e.g. "src/lib.rs") is the entry point for module traversal.
pub fn extract_graph_with_source_map(
    json: &str,
    crate_name: &str,
    source_files: HashMap<String, String>,
    root_file: &str,
    call_mode: CallMode,
) -> Result<Graph, RustdocError> {
    let krate = parse_rustdoc_lenient(json)?;
    let provider = MemorySourceProvider::new(source_files);
    build_graph(
        &krate,
        crate_name,
        BuildGraphOptions {
            workspace_members: None,
            source: Some((Path::new(root_file), &provider)),
            call_mode,
            skip_external_nodes: true,
            rustdoc_name: None,
        },
    )
}

#[cfg(feature = "native")]
pub fn extract_graph_with_sources(
    json: &str,
    crate_name: &str,
    workspace_manifest_path: &Path,
    root_file: &Path,
    call_mode: CallMode,
    rustdoc_name: Option<&str>,
) -> Result<Graph, RustdocError> {
    let krate = parse_rustdoc_lenient(json)?;
    let workspace_members = get_workspace_members(workspace_manifest_path)?;
    build_graph(
        &krate,
        crate_name,
        BuildGraphOptions {
            workspace_members: Some(workspace_members),
            source: Some((root_file, &FsSourceProvider)),
            call_mode,
            skip_external_nodes: false,
            rustdoc_name: rustdoc_name.map(|s| s.to_string()),
        },
    )
}

/// Options for graph extraction.
struct BuildGraphOptions<'a> {
    /// Known workspace member crate names. If None, only `crate_name` is treated as local.
    workspace_members: Option<HashSet<String>>,
    /// Source provider for call edge extraction. If provided, the root file path and
    /// provider are used to parse source files and extract call edges.
    source: Option<(&'a Path, &'a dyn SourceProvider)>,
    /// Call resolution mode.
    call_mode: CallMode,
    /// When true, external crate items are excluded from the graph entirely.
    /// Edges referencing external nodes are still created (as cross-crate references)
    /// but no Node entries or module hierarchies are built for them.
    skip_external_nodes: bool,
    /// The name rustdoc uses internally for the root crate. For binary crates this may
    /// differ from `crate_name` (e.g. crate "codeview_cli" has rustdoc name "codeview").
    rustdoc_name: Option<String>,
}

fn build_graph(
    krate: &rdt::Crate,
    crate_name: &str,
    opts: BuildGraphOptions<'_>,
) -> Result<Graph, RustdocError> {
    #[cfg(feature = "wasm")]
    wasm_log!(
        "[wasm] build_graph: starting with {} items in index, {} paths",
        krate.index.len(),
        krate.paths.len()
    );

    // For binary crates, rustdoc uses the binary target name (e.g. "codeview") as the
    // first path segment, but we want to use the package/crate name (e.g. "codeview_cli").
    // Normalize paths for root crate items (crate_id == 0) so all downstream code works
    // without needing to know about the mismatch.
    let owned_krate;
    let krate = if let Some(ref rdn) = opts.rustdoc_name {
        let mut patched = krate.clone();
        for summary in patched.paths.values_mut() {
            if summary.crate_id == 0 {
                if let Some(first) = summary.path.first_mut() {
                    if first.as_str() == rdn.as_str() {
                        *first = crate_name.to_string();
                    }
                }
            }
        }
        owned_krate = patched;
        &owned_krate
    } else {
        krate
    };

    let mut graph = Graph::new();
    let mut node_cache = HashSet::new();
    let mut edge_cache = HashSet::new();
    let method_ids = collect_method_ids(krate);
    let path_index = build_path_index(krate, crate_name);
    let function_index = build_function_index(krate, &method_ids, crate_name);
    let trait_lookup = build_trait_lookup(krate, crate_name, &path_index);
    let mut placeholder_module_nodes = HashSet::new();

    // Built early because `extract_doc_links` needs it to rewrite intra-doc
    // link targets to their user-friendly re-export aliases (e.g. so a link
    // to `core::async_iter::async_iter::AsyncIterator` becomes
    // `core::async_iter::AsyncIterator`). Used again later for re-export edges
    // and the final `graph.aliases` field.
    let item_to_parent: HashMap<rdt::Id, rdt::Id> = {
        let mut map = HashMap::new();
        for (module_id, item) in &krate.index {
            if let rdt::ItemEnum::Module(module) = &item.inner {
                for child_id in &module.items {
                    map.insert(*child_id, *module_id);
                }
            }
        }
        map
    };
    let aliases = build_aliases(krate, crate_name, &path_index, &item_to_parent);
    let canonical_to_alias = invert_aliases(&aliases);

    #[cfg(feature = "wasm")]
    wasm_log!(
        "[wasm] build_graph: indexes built, {} method_ids, {} function_index entries, {} trait_lookup entries",
        method_ids.len(),
        function_index.callables.len(),
        trait_lookup.len()
    );

    let workspace_members = opts
        .workspace_members
        .unwrap_or_else(|| HashSet::from([crate_name.to_string()]));

    ensure_crate_node(
        &mut graph,
        &mut node_cache,
        crate_name,
        Visibility::Public,
        !workspace_members.contains(crate_name),
    );

    for (item_id, summary) in &krate.paths {
        let is_method = method_ids.contains(item_id);
        let node_kind = match map_item_kind(&summary.kind, is_method) {
            Some(kind) => kind,
            None => continue,
        };

        if summary.path.is_empty() {
            continue;
        }

        // Skip internal/generated paths (e.g., serde derive macro internals)
        // - Paths containing "_" as a segment (serde's internal module)
        // - Paths with segments starting with "__" (internal types like __FieldVisitor)
        if summary
            .path
            .iter()
            .any(|seg| seg == "_" || seg.starts_with("__"))
        {
            continue;
        }

        let item_crate_name = crate_name_for_id(krate, summary.crate_id, crate_name);
        let is_external = !workspace_members.contains(&item_crate_name);

        // When skip_external_nodes is set, don't create nodes or module hierarchies
        // for external crate items — they only need to exist as edge targets.
        if is_external && opts.skip_external_nodes {
            continue;
        }

        ensure_crate_node(
            &mut graph,
            &mut node_cache,
            &item_crate_name,
            Visibility::Public,
            is_external,
        );

        ensure_module_nodes(
            &mut graph,
            &mut node_cache,
            &mut edge_cache,
            &mut placeholder_module_nodes,
            &item_crate_name,
            &summary.path,
            &path_index,
            is_external,
        );

        let node_id = path_index
            .node_ids_by_rustdoc_id
            .get(item_id)
            .cloned()
            .unwrap_or_else(|| join_path(&item_crate_name, &summary.path));
        if !node_cache.contains(&node_id) || placeholder_module_nodes.contains(&node_id) {
            let item = krate.index.get(item_id);
            let visibility = item
                .map(|item| map_visibility(&item.visibility))
                .unwrap_or(Visibility::Unknown);
            let span = item.and_then(|item| item.span.as_ref().map(map_span));
            let attrs = item
                .map(|item| format_attributes(&item.attrs))
                .unwrap_or_default();
            let name = summary
                .path
                .last()
                .cloned()
                .unwrap_or_else(|| node_id.clone());

            let details = item
                .map(|item| extract_item_details(&krate.index, item))
                .unwrap_or_default();
            let deprecation = item.and_then(|item| map_deprecation(item.deprecation.as_ref()));

            let doc_links = item
                .map(|item| {
                    extract_doc_links(item, krate, crate_name, &path_index, &canonical_to_alias)
                })
                .unwrap_or_default();

            // bound_links removed: type IDs now live inline in
            // TypeRef::ResolvedPath, so the side table is redundant.

            upsert_node(
                &mut graph,
                &mut node_cache,
                &mut placeholder_module_nodes,
                Node {
                    id: node_id.clone(),
                    name,
                    kind: node_kind,
                    visibility,
                    line_count: line_count(&span),
                    span,
                    attrs,
                    is_external,
                    is_deprecated: deprecation.is_some(),
                    is_unsafe: details.is_unsafe,
                    is_auto: details.is_auto,
                    is_mutable: details.is_mutable,
                    is_stripped: details.is_stripped,
                    has_stripped_fields: details.has_stripped_fields,
                    has_stripped_variants: details.has_stripped_variants,
                    is_dyn_compatible: details.is_dyn_compatible,
                    deprecation,
                    fields: details.fields,
                    variants: details.variants,
                    signature: details.signature,
                    generics: details.generics,
                    docs: details.docs,
                    doc_links,
                    impl_type: None,
                    parent_impl: None,
                    impl_trait: None,
                    impl_category: None,
                    provided_trait_methods: None,
                    required_trait_methods: details.required_trait_methods,
                    default_trait_methods: details.default_trait_methods,
                    type_: details.type_,
                    variant_kind: details.variant_kind,
                    discriminant: details.discriminant,
                    const_value: details.const_value,
                    bounds: details.bounds,
                    import_source: details.import_source,
                    import_name: details.import_name,
                    is_glob: details.is_glob,
                    extern_crate_name: details.extern_crate_name,
                    extern_crate_rename: details.extern_crate_rename,
                    macro_source: details.macro_source,
                    proc_macro_kind: details.proc_macro_kind,
                    proc_macro_helpers: details.proc_macro_helpers,
                },
            );
        }

        if let Some(parent_id) = parent_path_id(&item_crate_name, &summary.path) {
            // Skip self-loops (can happen when path is just the crate name)
            if parent_id != node_id {
                let kind = structural_edge_kind(&parent_id, &item_crate_name, &path_index);
                push_edge(
                    &mut graph,
                    &mut edge_cache,
                    parent_id,
                    node_id,
                    kind,
                    Confidence::Static,
                );
            }
        }
    }

    // item_to_parent was built earlier (top of build_graph) so doc-link
    // alias rewriting could use it. Just reuse it here.
    add_use_import_edges_with_parent_map(
        &mut graph,
        &mut edge_cache,
        krate,
        crate_name,
        &path_index,
        &item_to_parent,
    );

    for item in krate.index.values() {
        let owner_id = match &item.inner {
            rdt::ItemEnum::Impl(impl_block) => {
                let item_crate_name = crate_name_for_id(krate, item.crate_id, crate_name);
                let is_external = !workspace_members.contains(&item_crate_name);

                // Skip external impl blocks entirely when skip_external_nodes is set
                if is_external && opts.skip_external_nodes {
                    continue;
                }

                ensure_crate_node(
                    &mut graph,
                    &mut node_cache,
                    &item_crate_name,
                    Visibility::Public,
                    is_external,
                );
                let impl_id = impl_node_id(&item_crate_name, item.id);
                // Resolve the trait ID for trait impls
                let impl_trait_id = impl_block.trait_.as_ref().and_then(|trait_path| {
                    resolve_id(krate, crate_name, &path_index, trait_path.id)
                });

                if !node_cache.contains(&impl_id) {
                    let name = impl_node_name(krate, crate_name, &path_index, impl_block);
                    let impl_type = if impl_block.trait_.is_some() {
                        Some(ImplType::Trait)
                    } else {
                        Some(ImplType::Inherent)
                    };
                    let impl_category = if impl_block.is_synthetic {
                        ImplCategory::Synthetic
                    } else if impl_block.is_negative {
                        ImplCategory::Negative
                    } else if impl_block.blanket_impl.is_some() {
                        ImplCategory::Blanket
                    } else if impl_block.trait_.is_some() {
                        ImplCategory::Trait
                    } else {
                        ImplCategory::Inherent
                    };
                    let span = item.span.as_ref().map(map_span);
                    let deprecation = map_deprecation(item.deprecation.as_ref());
                    graph.add_node(Node {
                        id: impl_id.clone(),
                        name,
                        kind: NodeKind::Impl,
                        visibility: map_visibility(&item.visibility),
                        line_count: line_count(&span),
                        span,
                        attrs: format_attributes(&item.attrs),
                        is_external,
                        is_deprecated: deprecation.is_some(),
                        is_unsafe: impl_block.is_unsafe,
                        is_auto: false,
                        is_mutable: false,
                        is_stripped: false,
                        has_stripped_fields: false,
                        has_stripped_variants: false,
                        is_dyn_compatible: None,
                        deprecation,
                        fields: None,
                        variants: None,
                        signature: None,
                        generics: map_generics(&impl_block.generics),
                        docs: extract_docs(item),
                        doc_links: extract_doc_links(
                            item,
                            krate,
                            crate_name,
                            &path_index,
                            &canonical_to_alias,
                        ),
                        impl_type,
                        parent_impl: None,
                        impl_trait: impl_trait_id.clone(),
                        impl_category: Some(impl_category),
                        provided_trait_methods: if impl_block.provided_trait_methods.is_empty() {
                            None
                        } else {
                            Some(impl_block.provided_trait_methods.clone())
                        },
                        required_trait_methods: None,
                        default_trait_methods: None,
                        type_: None,
                        variant_kind: None,
                        discriminant: None,
                        const_value: None,
                        bounds: Vec::new(),
                        import_source: None,
                        import_name: None,
                        is_glob: false,
                        extern_crate_name: None,
                        extern_crate_rename: None,
                        macro_source: None,
                        proc_macro_kind: None,
                        proc_macro_helpers: Vec::new(),
                    });
                    node_cache.insert(impl_id.clone());
                }

                // Add Contains edge from parent module to impl node
                if let Some(parent_id) = item_to_parent.get(&item.id)
                    && let Some(parent_node_id) =
                        resolve_id(krate, crate_name, &path_index, *parent_id)
                {
                    push_edge(
                        &mut graph,
                        &mut edge_cache,
                        parent_node_id,
                        impl_id.clone(),
                        EdgeKind::Contains,
                        Confidence::Static,
                    );
                }

                if let Some(for_id) = type_to_id(&impl_block.for_)
                    && let Some(type_node_id) = resolve_id(krate, crate_name, &path_index, for_id)
                {
                    push_edge(
                        &mut graph,
                        &mut edge_cache,
                        type_node_id.clone(),
                        impl_id.clone(),
                        EdgeKind::Defines,
                        Confidence::Static,
                    );

                    if let Some(trait_path) = impl_block.trait_.as_ref()
                        && let Some(trait_node_id) =
                            resolve_id(krate, crate_name, &path_index, trait_path.id)
                    {
                        push_edge(
                            &mut graph,
                            &mut edge_cache,
                            type_node_id,
                            trait_node_id,
                            EdgeKind::Implements,
                            Confidence::Static,
                        );
                    }
                }

                for assoc_id in &impl_block.items {
                    let Some(assoc_item) = krate.index.get(assoc_id) else {
                        continue;
                    };

                    let (kind, assoc_prefix) = match &assoc_item.inner {
                        rdt::ItemEnum::Function(_) => (NodeKind::Function, "method"),
                        rdt::ItemEnum::AssocType { .. } => (NodeKind::AssocType, "type"),
                        rdt::ItemEnum::AssocConst { .. } => (NodeKind::AssocConst, "const"),
                        rdt::ItemEnum::Constant { .. } => (NodeKind::Constant, "const"),
                        rdt::ItemEnum::TypeAlias(_) => (NodeKind::TypeAlias, "type"),
                        _ => continue,
                    };

                    // Create a per-impl node so each impl block owns its own child.
                    // This avoids shared children when the same rustdoc ID appears
                    // in multiple impl blocks (e.g. blanket impls like `impl<T> Any for T`).
                    let assoc_node_id = format!("{}::{}-{}", impl_id, assoc_prefix, assoc_id.0);
                    if !node_cache.contains(&assoc_node_id) {
                        let name = assoc_item
                            .name
                            .clone()
                            .unwrap_or_else(|| assoc_node_id.clone());
                        let details = extract_item_details(&krate.index, assoc_item);
                        let span = assoc_item.span.as_ref().map(map_span);
                        let deprecation = map_deprecation(assoc_item.deprecation.as_ref());
                        graph.add_node(Node {
                            id: assoc_node_id.clone(),
                            name,
                            kind,
                            visibility: map_visibility(&assoc_item.visibility),
                            line_count: line_count(&span),
                            span,
                            attrs: format_attributes(&assoc_item.attrs),
                            is_external,
                            is_deprecated: deprecation.is_some(),
                            is_unsafe: details.is_unsafe,
                            is_auto: details.is_auto,
                            is_mutable: details.is_mutable,
                            is_stripped: details.is_stripped,
                            has_stripped_fields: details.has_stripped_fields,
                            has_stripped_variants: details.has_stripped_variants,
                            is_dyn_compatible: details.is_dyn_compatible,
                            deprecation,
                            fields: details.fields,
                            variants: details.variants,
                            signature: details.signature,
                            generics: details.generics,
                            docs: details.docs,
                            doc_links: extract_doc_links(
                                assoc_item,
                                krate,
                                crate_name,
                                &path_index,
                                &canonical_to_alias,
                            ),
                            impl_type: None,
                            parent_impl: Some(impl_id.clone()),
                            impl_trait: None,
                            impl_category: None,
                            provided_trait_methods: None,
                            required_trait_methods: details.required_trait_methods,
                            default_trait_methods: details.default_trait_methods,
                            type_: details.type_,
                            variant_kind: details.variant_kind,
                            discriminant: details.discriminant,
                            const_value: details.const_value,
                            bounds: details.bounds,
                            import_source: details.import_source,
                            import_name: details.import_name,
                            is_glob: details.is_glob,
                            extern_crate_name: details.extern_crate_name,
                            extern_crate_rename: details.extern_crate_rename,
                            macro_source: details.macro_source,
                            proc_macro_kind: details.proc_macro_kind,
                            proc_macro_helpers: details.proc_macro_helpers,
                        });
                        node_cache.insert(assoc_node_id.clone());
                    }

                    push_edge(
                        &mut graph,
                        &mut edge_cache,
                        impl_id.clone(),
                        assoc_node_id,
                        EdgeKind::Defines,
                        Confidence::Static,
                    );
                }

                impl_id
            }
            _ => match resolve_id(krate, crate_name, &path_index, item.id) {
                Some(id) => id,
                None => continue,
            },
        };

        let mut type_ids = HashSet::new();
        match &item.inner {
            rdt::ItemEnum::Struct(item_struct) => {
                collect_generics_ids(&item_struct.generics, &mut type_ids);
                collect_struct_field_ids(&krate.index, &item_struct.kind, &mut type_ids);
            }
            rdt::ItemEnum::Union(item_union) => {
                collect_generics_ids(&item_union.generics, &mut type_ids);
                collect_field_ids(&krate.index, &item_union.fields, &mut type_ids);
            }
            rdt::ItemEnum::Enum(item_enum) => {
                collect_generics_ids(&item_enum.generics, &mut type_ids);
                collect_enum_variant_ids(&krate.index, &item_enum.variants, &mut type_ids);
            }
            rdt::ItemEnum::Trait(item_trait) => {
                collect_generics_ids(&item_trait.generics, &mut type_ids);
                collect_bounds_ids(&item_trait.bounds, &mut type_ids);

                for assoc_id in &item_trait.items {
                    if let Some(assoc_node_id) =
                        resolve_id(krate, crate_name, &path_index, *assoc_id)
                    {
                        push_edge(
                            &mut graph,
                            &mut edge_cache,
                            owner_id.clone(),
                            assoc_node_id,
                            EdgeKind::Defines,
                            Confidence::Static,
                        );
                    }
                }
            }
            rdt::ItemEnum::TraitAlias(alias) => {
                collect_generics_ids(&alias.generics, &mut type_ids);
                collect_bounds_ids(&alias.params, &mut type_ids);
            }
            rdt::ItemEnum::TypeAlias(alias) => {
                collect_type_ids(&alias.type_, &mut type_ids);
                collect_generics_ids(&alias.generics, &mut type_ids);
            }
            rdt::ItemEnum::Function(function) => {
                collect_signature_ids(&function.sig, &mut type_ids);
                collect_generics_ids(&function.generics, &mut type_ids);
            }
            rdt::ItemEnum::Impl(impl_block) => {
                collect_generics_ids(&impl_block.generics, &mut type_ids);
                collect_type_ids(&impl_block.for_, &mut type_ids);
                if let Some(trait_path) = impl_block.trait_.as_ref() {
                    type_ids.insert(trait_path.id);
                    if let Some(args) = trait_path.args.as_deref() {
                        collect_generic_args_ids(args, &mut type_ids);
                    }
                }
            }
            rdt::ItemEnum::Constant { type_, .. } => {
                collect_type_ids(type_, &mut type_ids);
            }
            rdt::ItemEnum::Static(item_static) => {
                collect_type_ids(&item_static.type_, &mut type_ids);
            }
            _ => {}
        }

        add_uses_edges(
            &mut graph,
            &mut edge_cache,
            &owner_id,
            type_ids,
            krate,
            crate_name,
            &path_index,
        );

        add_derives_edges(
            &mut graph,
            &mut edge_cache,
            &owner_id,
            &item.attrs,
            &trait_lookup,
        );
    }

    if let Some((root_file, source_provider)) = opts.source {
        add_call_edges(
            &mut graph,
            &mut edge_cache,
            root_file,
            &function_index,
            opts.call_mode,
            source_provider,
        )?;
    }

    materialize_missing_external_edge_nodes(
        &mut graph,
        &mut node_cache,
        &workspace_members,
        &path_index,
    );
    prune_dangling_edges(&mut graph, &node_cache);

    // Persist the alias map so server URL routing can resolve user-friendly
    // paths back to their canonical node IDs.
    graph.aliases = aliases;

    Ok(graph)
}

fn collect_method_ids(krate: &rdt::Crate) -> HashSet<rdt::Id> {
    let mut method_ids = HashSet::new();
    for item in krate.index.values() {
        match &item.inner {
            rdt::ItemEnum::Impl(impl_block) => {
                method_ids.extend(impl_block.items.iter().copied());
            }
            rdt::ItemEnum::Trait(item_trait) => {
                method_ids.extend(item_trait.items.iter().copied());
            }
            _ => {}
        }
    }
    method_ids
}

#[derive(Debug, Default)]
struct PathIndex {
    known_paths: HashSet<String>,
    module_paths: HashSet<String>,
    node_kinds: HashMap<String, NodeKind>,
    node_ids_by_rustdoc_id: HashMap<rdt::Id, String>,
}

impl PathIndex {
    fn is_known_non_module(&self, id: &str) -> bool {
        self.known_paths.contains(id) && !self.module_paths.contains(id)
    }

    fn is_module(&self, id: &str) -> bool {
        self.module_paths.contains(id)
    }
}

fn build_path_index(krate: &rdt::Crate, default_crate_name: &str) -> PathIndex {
    let mut index = PathIndex::default();
    let mut entries_by_path: HashMap<String, Vec<(rdt::Id, NodeKind)>> = HashMap::new();

    for (item_id, summary) in &krate.paths {
        if summary.path.is_empty() {
            continue;
        }
        let crate_name = crate_name_for_id(krate, summary.crate_id, default_crate_name);
        let id = join_path(&crate_name, &summary.path);
        index.known_paths.insert(id.clone());
        if summary.kind == rdt::ItemKind::Module {
            index.module_paths.insert(id.clone());
        }
        if let Some(kind) = map_item_kind(&summary.kind, false) {
            entries_by_path
                .entry(id)
                .or_default()
                .push((*item_id, kind));
        }
    }

    for (path_id, mut entries) in entries_by_path {
        entries.sort_by_key(|(item_id, kind)| {
            let priority = if *kind == NodeKind::Module { 0 } else { 1 };
            (priority, item_id.0)
        });
        let has_collision = entries.len() > 1;
        let clean_item_id = entries
            .iter()
            .find(|(_, kind)| *kind == NodeKind::Module)
            .map(|(item_id, _)| *item_id)
            .or_else(|| entries.first().map(|(item_id, _)| *item_id));

        for (item_id, kind) in entries {
            let node_id = if has_collision && Some(item_id) != clean_item_id {
                format!("{}~{}-{}", path_id, node_kind_slug(kind), item_id.0)
            } else {
                path_id.clone()
            };
            index.node_kinds.insert(node_id.clone(), kind);
            index.node_ids_by_rustdoc_id.insert(item_id, node_id);
        }
    }

    index
}

fn structural_edge_kind(parent_id: &str, crate_name: &str, path_index: &PathIndex) -> EdgeKind {
    if parent_id == crate_name
        || path_index.is_module(parent_id)
        || !path_index.known_paths.contains(parent_id)
    {
        EdgeKind::Contains
    } else {
        EdgeKind::Defines
    }
}

fn node_kind_slug(kind: NodeKind) -> &'static str {
    match kind {
        NodeKind::Crate => "crate",
        NodeKind::Module => "module",
        NodeKind::Struct => "struct",
        NodeKind::StructField => "field",
        NodeKind::Union => "union",
        NodeKind::Enum => "enum",
        NodeKind::Variant => "variant",
        NodeKind::Trait => "trait",
        NodeKind::TraitAlias => "trait-alias",
        NodeKind::Impl => "impl",
        NodeKind::Function => "fn",
        NodeKind::TypeAlias => "type",
        NodeKind::AssocType => "assoc-type",
        NodeKind::Constant => "const",
        NodeKind::AssocConst => "assoc-const",
        NodeKind::Static => "static",
        NodeKind::Macro => "macro",
        NodeKind::Primitive => "primitive",
        NodeKind::ExternCrate => "extern-crate",
        NodeKind::Import => "import",
        NodeKind::ProcMacro => "proc-macro",
    }
}

fn build_trait_lookup(
    krate: &rdt::Crate,
    default_crate_name: &str,
    path_index: &PathIndex,
) -> HashMap<String, Vec<String>> {
    let mut lookup = HashMap::new();
    for (item_id, summary) in &krate.paths {
        if summary.kind != rdt::ItemKind::Trait {
            continue;
        }
        let crate_name = crate_name_for_id(krate, summary.crate_id, default_crate_name);
        let full_path = path_index
            .node_ids_by_rustdoc_id
            .get(item_id)
            .cloned()
            .unwrap_or_else(|| join_path(&crate_name, &summary.path));
        lookup
            .entry(full_path.clone())
            .or_insert_with(|| vec![full_path.clone()]);
        if let Some(name) = summary.path.last() {
            lookup.entry(name.clone()).or_default().push(full_path);
        }
    }
    lookup
}

fn map_item_kind(kind: &rdt::ItemKind, is_method: bool) -> Option<NodeKind> {
    match kind {
        rdt::ItemKind::Module => Some(NodeKind::Module),
        rdt::ItemKind::ExternCrate => Some(NodeKind::ExternCrate),
        rdt::ItemKind::Use => Some(NodeKind::Import),
        rdt::ItemKind::Struct => Some(NodeKind::Struct),
        rdt::ItemKind::StructField => Some(NodeKind::StructField),
        rdt::ItemKind::Union => Some(NodeKind::Union),
        rdt::ItemKind::Enum => Some(NodeKind::Enum),
        rdt::ItemKind::Variant => Some(NodeKind::Variant),
        rdt::ItemKind::Trait => Some(NodeKind::Trait),
        rdt::ItemKind::TraitAlias => Some(NodeKind::TraitAlias),
        rdt::ItemKind::Impl => Some(NodeKind::Impl),
        rdt::ItemKind::Function => Some(if is_method {
            NodeKind::Function
        } else {
            NodeKind::Function
        }),
        rdt::ItemKind::TypeAlias => Some(NodeKind::TypeAlias),
        rdt::ItemKind::Constant => Some(NodeKind::Constant),
        rdt::ItemKind::Static => Some(NodeKind::Static),
        rdt::ItemKind::Macro => Some(NodeKind::Macro),
        rdt::ItemKind::ProcAttribute | rdt::ItemKind::ProcDerive => Some(NodeKind::ProcMacro),
        rdt::ItemKind::AssocConst => Some(NodeKind::AssocConst),
        rdt::ItemKind::AssocType => Some(NodeKind::AssocType),
        rdt::ItemKind::Primitive => Some(NodeKind::Primitive),
        _ => None,
    }
}

fn map_visibility(visibility: &rdt::Visibility) -> Visibility {
    match visibility {
        rdt::Visibility::Public => Visibility::Public,
        rdt::Visibility::Crate => Visibility::Crate,
        rdt::Visibility::Restricted { path, .. } => Visibility::Restricted { path: path.clone() },
        rdt::Visibility::Default => Visibility::Inherited,
    }
}

fn map_span(span: &rdt::Span) -> Span {
    // rustdoc JSON spans are already 1-indexed for both lines and columns
    Span {
        file: span.filename.to_string_lossy().to_string(),
        line: span.begin.0 as u32,
        column: span.begin.1 as u32,
        end_line: Some(span.end.0 as u32),
        end_column: Some(span.end.1 as u32),
    }
}

fn line_count(span: &Option<Span>) -> Option<u32> {
    let span = span.as_ref()?;
    Some(
        span.end_line
            .filter(|end| *end >= span.line)
            .map(|end| end - span.line + 1)
            .unwrap_or(1),
    )
}

fn map_deprecation(deprecation: Option<&rdt::Deprecation>) -> Option<Deprecation> {
    deprecation.map(|deprecation| Deprecation {
        since: deprecation.since.clone(),
        note: deprecation.note.clone(),
    })
}

// ─── Type AST mapping ──────────────────────────────────────────────────
//
// Maps `rustdoc-types::Type` (and adjacent enums) to our `TypeRef` /
// `Generics` / `GenericBound` / etc. Faithful 1:1 mapping — preserves
// IDs (so the worker can build cross-crate links without a side table),
// lifetime quantifiers (higher-rank bounds), and synthetic-param flags
// (so renderers can hide them).

use codeview_core::{
    AssocItemConstraint as CvAssocItemConstraint,
    AssocItemConstraintKind as CvAssocItemConstraintKind, FunctionPointerSig as CvFnPointerSig,
    GenericArg as CvGenericArg, GenericArgs as CvGenericArgs, GenericBound as CvGenericBound,
    GenericParam as CvGenericParam, GenericParamKind as CvGenericParamKind, Generics as CvGenerics,
    NamedTypeRef as CvNamedTypeRef, PolyTrait as CvPolyTrait, PreciseCapture as CvPreciseCapture,
    Term as CvTerm, TraitBoundModifier as CvTraitBoundModifier, TypeRef, WherePredicate as CvWherePred,
};

fn map_type(ty: &rdt::Type) -> TypeRef {
    match ty {
        rdt::Type::ResolvedPath(path) => TypeRef::ResolvedPath {
            id: path.id.0.to_string(),
            path: path.path.clone(),
            args: path.args.as_deref().map(|args| Box::new(map_generic_args(args))),
        },
        rdt::Type::DynTrait(dt) => TypeRef::DynTrait {
            traits: dt.traits.iter().map(map_poly_trait).collect(),
            lifetime: dt.lifetime.clone(),
        },
        rdt::Type::Generic(name) => TypeRef::Generic { name: name.clone() },
        rdt::Type::Primitive(name) => TypeRef::Primitive { name: name.clone() },
        rdt::Type::FunctionPointer(fp) => TypeRef::FunctionPointer {
            sig: Box::new(map_function_pointer(fp)),
        },
        rdt::Type::Tuple(items) => TypeRef::Tuple {
            elements: items.iter().map(map_type).collect(),
        },
        rdt::Type::Slice(inner) => TypeRef::Slice {
            element: Box::new(map_type(inner)),
        },
        rdt::Type::Array { type_, len } => TypeRef::Array {
            element: Box::new(map_type(type_)),
            len: len.clone(),
        },
        rdt::Type::Pat { type_, __pat_unstable_do_not_use } => TypeRef::Pat {
            base: Box::new(map_type(type_)),
            pat: __pat_unstable_do_not_use.clone(),
        },
        rdt::Type::ImplTrait(bounds) => TypeRef::ImplTrait {
            bounds: bounds.iter().map(map_generic_bound).collect(),
        },
        rdt::Type::Infer => TypeRef::Infer,
        rdt::Type::RawPointer { is_mutable, type_ } => TypeRef::RawPointer {
            mutable: *is_mutable,
            inner: Box::new(map_type(type_)),
        },
        rdt::Type::BorrowedRef {
            lifetime,
            is_mutable,
            type_,
        } => TypeRef::BorrowedRef {
            lifetime: lifetime.clone(),
            mutable: *is_mutable,
            inner: Box::new(map_type(type_)),
        },
        rdt::Type::QualifiedPath {
            name,
            args,
            self_type,
            trait_,
        } => TypeRef::QualifiedPath {
            name: name.clone(),
            args: args.as_deref().map(|a| Box::new(map_generic_args(a))),
            self_type: Box::new(map_type(self_type)),
            trait_: trait_.as_ref().map(|p| {
                Box::new(TypeRef::ResolvedPath {
                    id: p.id.0.to_string(),
                    path: p.path.clone(),
                    args: p.args.as_deref().map(|a| Box::new(map_generic_args(a))),
                })
            }),
        },
    }
}

fn map_generic_args(args: &rdt::GenericArgs) -> CvGenericArgs {
    match args {
        rdt::GenericArgs::AngleBracketed { args, constraints } => CvGenericArgs::AngleBracketed {
            args: args.iter().map(map_generic_arg).collect(),
            constraints: constraints.iter().map(map_assoc_constraint).collect(),
        },
        rdt::GenericArgs::Parenthesized { inputs, output } => CvGenericArgs::Parenthesized {
            inputs: inputs.iter().map(map_type).collect(),
            output: output.as_ref().map(|t| Box::new(map_type(t))),
        },
        rdt::GenericArgs::ReturnTypeNotation => CvGenericArgs::ReturnTypeNotation,
    }
}

fn map_generic_arg(arg: &rdt::GenericArg) -> CvGenericArg {
    match arg {
        rdt::GenericArg::Lifetime(name) => CvGenericArg::Lifetime { name: name.clone() },
        rdt::GenericArg::Type(t) => CvGenericArg::Type { value: map_type(t) },
        rdt::GenericArg::Const(c) => CvGenericArg::Const {
            expr: c.value.clone().unwrap_or_else(|| c.expr.clone()),
            is_literal: c.is_literal,
        },
        rdt::GenericArg::Infer => CvGenericArg::Infer,
    }
}

fn map_assoc_constraint(c: &rdt::AssocItemConstraint) -> CvAssocItemConstraint {
    CvAssocItemConstraint {
        name: c.name.clone(),
        args: c.args.as_deref().map(|a| Box::new(map_generic_args(a))),
        binding: match &c.binding {
            rdt::AssocItemConstraintKind::Equality(term) => CvAssocItemConstraintKind::Equality {
                value: map_term(term),
            },
            rdt::AssocItemConstraintKind::Constraint(bounds) => {
                CvAssocItemConstraintKind::Constraint {
                    bounds: bounds.iter().map(map_generic_bound).collect(),
                }
            }
        },
    }
}

fn map_term(term: &rdt::Term) -> CvTerm {
    match term {
        rdt::Term::Type(t) => CvTerm::Type { value: map_type(t) },
        rdt::Term::Constant(c) => CvTerm::Const {
            expr: c.value.clone().unwrap_or_else(|| c.expr.clone()),
            is_literal: c.is_literal,
        },
    }
}

fn map_poly_trait(p: &rdt::PolyTrait) -> CvPolyTrait {
    CvPolyTrait {
        trait_: TypeRef::ResolvedPath {
            id: p.trait_.id.0.to_string(),
            path: p.trait_.path.clone(),
            args: p
                .trait_
                .args
                .as_deref()
                .map(|a| Box::new(map_generic_args(a))),
        },
        hrtb_params: p.generic_params.iter().map(map_generic_param).collect(),
    }
}

fn map_function_pointer(fp: &rdt::FunctionPointer) -> CvFnPointerSig {
    CvFnPointerSig {
        inputs: fp
            .sig
            .inputs
            .iter()
            .map(|(name, t)| CvNamedTypeRef {
                name: name.clone(),
                type_: map_type(t),
            })
            .collect(),
        output: fp.sig.output.as_ref().map(map_type),
        is_unsafe: fp.header.is_unsafe,
        is_const: fp.header.is_const,
        is_async: fp.header.is_async,
        abi: format_abi(&fp.header.abi),
        is_c_variadic: fp.sig.is_c_variadic,
        hrtb_params: fp.generic_params.iter().map(map_generic_param).collect(),
    }
}

fn map_generic_bound(bound: &rdt::GenericBound) -> CvGenericBound {
    match bound {
        rdt::GenericBound::TraitBound {
            trait_,
            generic_params,
            modifier,
        } => CvGenericBound::Trait {
            trait_: TypeRef::ResolvedPath {
                id: trait_.id.0.to_string(),
                path: trait_.path.clone(),
                args: trait_
                    .args
                    .as_deref()
                    .map(|a| Box::new(map_generic_args(a))),
            },
            modifier: map_trait_bound_modifier(*modifier),
            hrtb_params: generic_params.iter().map(map_generic_param).collect(),
        },
        rdt::GenericBound::Outlives(lifetime) => CvGenericBound::Outlives {
            lifetime: lifetime.clone(),
        },
        rdt::GenericBound::Use(captures) => CvGenericBound::Use {
            captures: captures
                .iter()
                .map(|c| match c {
                    rdt::PreciseCapturingArg::Lifetime(name) => {
                        CvPreciseCapture::Lifetime { name: name.clone() }
                    }
                    rdt::PreciseCapturingArg::Param(name) => {
                        CvPreciseCapture::Param { name: name.clone() }
                    }
                })
                .collect(),
        },
    }
}

fn map_trait_bound_modifier(m: rdt::TraitBoundModifier) -> CvTraitBoundModifier {
    match m {
        rdt::TraitBoundModifier::None => CvTraitBoundModifier::None,
        rdt::TraitBoundModifier::Maybe => CvTraitBoundModifier::Maybe,
        rdt::TraitBoundModifier::MaybeConst => CvTraitBoundModifier::MaybeConst,
    }
}

fn map_generic_param(p: &rdt::GenericParamDef) -> CvGenericParam {
    CvGenericParam {
        name: p.name.clone(),
        kind: match &p.kind {
            rdt::GenericParamDefKind::Lifetime { outlives } => CvGenericParamKind::Lifetime {
                outlives: outlives.clone(),
            },
            rdt::GenericParamDefKind::Type {
                bounds,
                default,
                is_synthetic,
            } => CvGenericParamKind::Type {
                bounds: bounds.iter().map(map_generic_bound).collect(),
                default: default.as_ref().map(map_type),
                synthetic: *is_synthetic,
            },
            rdt::GenericParamDefKind::Const { type_, default } => CvGenericParamKind::Const {
                type_: map_type(type_),
                default: default.clone(),
            },
        },
    }
}

fn map_where_predicate(p: &rdt::WherePredicate) -> CvWherePred {
    match p {
        rdt::WherePredicate::BoundPredicate {
            type_,
            bounds,
            generic_params,
        } => CvWherePred::Bound {
            type_: map_type(type_),
            bounds: bounds.iter().map(map_generic_bound).collect(),
            hrtb_params: generic_params.iter().map(map_generic_param).collect(),
        },
        rdt::WherePredicate::LifetimePredicate {
            lifetime,
            outlives,
        } => CvWherePred::Lifetime {
            lifetime: lifetime.clone(),
            outlives: outlives.clone(),
        },
        rdt::WherePredicate::EqPredicate { lhs, rhs } => CvWherePred::Eq {
            lhs: map_type(lhs),
            rhs: map_term(rhs),
        },
    }
}

fn map_generics(g: &rdt::Generics) -> CvGenerics {
    CvGenerics {
        params: g.params.iter().map(map_generic_param).collect(),
        where_predicates: g.where_predicates.iter().map(map_where_predicate).collect(),
    }
}

fn map_bounds(bounds: &[rdt::GenericBound]) -> Vec<CvGenericBound> {
    bounds.iter().map(map_generic_bound).collect()
}

fn extract_struct_fields(
    index: &HashMap<rdt::Id, rdt::Item>,
    kind: &rdt::StructKind,
) -> Option<Vec<FieldInfo>> {
    match kind {
        rdt::StructKind::Unit => None,
        rdt::StructKind::Tuple(fields) => {
            let field_infos: Vec<_> = fields
                .iter()
                .enumerate()
                .filter_map(|(i, id)| {
                    let id = (*id)?;
                    let item = index.get(&id)?;
                    let rdt::ItemEnum::StructField(ty) = &item.inner else {
                        return None;
                    };
                    Some(FieldInfo {
                        name: format!("{}", i),
                        type_: map_type(ty),
                        visibility: map_visibility(&item.visibility),
                    })
                })
                .collect();
            if field_infos.is_empty() {
                None
            } else {
                Some(field_infos)
            }
        }
        rdt::StructKind::Plain { fields, .. } => {
            let field_infos: Vec<_> = fields
                .iter()
                .filter_map(|id| {
                    let item = index.get(id)?;
                    let rdt::ItemEnum::StructField(ty) = &item.inner else {
                        return None;
                    };
                    Some(FieldInfo {
                        name: item.name.clone().unwrap_or_default(),
                        type_: map_type(ty),
                        visibility: map_visibility(&item.visibility),
                    })
                })
                .collect();
            if field_infos.is_empty() {
                None
            } else {
                Some(field_infos)
            }
        }
    }
}

fn extract_field_list(
    index: &HashMap<rdt::Id, rdt::Item>,
    fields: &[rdt::Id],
) -> Option<Vec<FieldInfo>> {
    let field_infos: Vec<_> = fields
        .iter()
        .filter_map(|id| {
            let item = index.get(id)?;
            let rdt::ItemEnum::StructField(ty) = &item.inner else {
                return None;
            };
            Some(FieldInfo {
                name: item.name.clone().unwrap_or_default(),
                type_: map_type(ty),
                visibility: map_visibility(&item.visibility),
            })
        })
        .collect();
    if field_infos.is_empty() {
        None
    } else {
        Some(field_infos)
    }
}

fn extract_enum_variants(
    index: &HashMap<rdt::Id, rdt::Item>,
    variants: &[rdt::Id],
) -> Option<Vec<VariantInfo>> {
    let variant_infos: Vec<_> = variants
        .iter()
        .filter_map(|id| {
            let item = index.get(id)?;
            let rdt::ItemEnum::Variant(variant) = &item.inner else {
                return None;
            };
            let fields = match &variant.kind {
                rdt::VariantKind::Plain => Vec::new(),
                rdt::VariantKind::Tuple(fields) => fields
                    .iter()
                    .enumerate()
                    .filter_map(|(i, field_id)| {
                        let field_id = (*field_id)?;
                        let field_item = index.get(&field_id)?;
                        let rdt::ItemEnum::StructField(ty) = &field_item.inner else {
                            return None;
                        };
                        Some(FieldInfo {
                            name: format!("{}", i),
                            type_: map_type(ty),
                            visibility: Visibility::Inherited,
                        })
                    })
                    .collect(),
                rdt::VariantKind::Struct { fields, .. } => fields
                    .iter()
                    .filter_map(|field_id| {
                        let field_item = index.get(field_id)?;
                        let rdt::ItemEnum::StructField(ty) = &field_item.inner else {
                            return None;
                        };
                        Some(FieldInfo {
                            name: field_item.name.clone().unwrap_or_default(),
                            type_: map_type(ty),
                            visibility: map_visibility(&field_item.visibility),
                        })
                    })
                    .collect(),
            };
            Some(VariantInfo {
                name: item.name.clone().unwrap_or_default(),
                fields,
            })
        })
        .collect();
    if variant_infos.is_empty() {
        None
    } else {
        Some(variant_infos)
    }
}

fn struct_has_stripped_fields(kind: &rdt::StructKind) -> bool {
    match kind {
        rdt::StructKind::Plain {
            has_stripped_fields,
            ..
        } => *has_stripped_fields,
        rdt::StructKind::Tuple(fields) => fields.iter().any(Option::is_none),
        rdt::StructKind::Unit => false,
    }
}

fn variant_has_stripped_fields(kind: &rdt::VariantKind) -> bool {
    match kind {
        rdt::VariantKind::Struct {
            has_stripped_fields,
            ..
        } => *has_stripped_fields,
        rdt::VariantKind::Tuple(fields) => fields.iter().any(Option::is_none),
        rdt::VariantKind::Plain => false,
    }
}

fn extract_function_signature(
    sig: &rdt::FunctionSignature,
    header: &rdt::FunctionHeader,
    generics: &rdt::Generics,
) -> FunctionSignature {
    FunctionSignature {
        inputs: sig
            .inputs
            .iter()
            .map(|(name, ty)| ArgumentInfo {
                name: name.clone(),
                type_: map_type(ty),
            })
            .collect(),
        output: sig.output.as_ref().map(map_type),
        is_async: header.is_async,
        is_unsafe: header.is_unsafe,
        is_const: header.is_const,
        abi: format_abi(&header.abi),
        is_c_variadic: sig.is_c_variadic,
        generics: map_generics(generics),
    }
}

fn format_abi(abi: &rdt::Abi) -> Option<String> {
    let text = match abi {
        rdt::Abi::Rust => return None,
        rdt::Abi::C { unwind } => abi_with_unwind("C", *unwind),
        rdt::Abi::Cdecl { unwind } => abi_with_unwind("cdecl", *unwind),
        rdt::Abi::Stdcall { unwind } => abi_with_unwind("stdcall", *unwind),
        rdt::Abi::Fastcall { unwind } => abi_with_unwind("fastcall", *unwind),
        rdt::Abi::Aapcs { unwind } => abi_with_unwind("aapcs", *unwind),
        rdt::Abi::Win64 { unwind } => abi_with_unwind("win64", *unwind),
        rdt::Abi::SysV64 { unwind } => abi_with_unwind("sysv64", *unwind),
        rdt::Abi::System { unwind } => abi_with_unwind("system", *unwind),
        rdt::Abi::Other(name) => name.clone(),
    };
    Some(text)
}

fn abi_with_unwind(name: &str, unwind: bool) -> String {
    if unwind {
        format!("{name}-unwind")
    } else {
        name.to_string()
    }
}

fn format_proc_macro_kind(kind: rdt::MacroKind) -> String {
    match kind {
        rdt::MacroKind::Bang => "bang",
        rdt::MacroKind::Attr => "attr",
        rdt::MacroKind::Derive => "derive",
    }
    .to_string()
}

/// Strip module-prefix and `$crate::` leakage to a single segment for
/// display. `core::fmt::Debug` → `Debug`. Used by the link extractors.
fn clean_path(path: &str) -> String {
    path.rsplit("::").next().unwrap_or(path).to_string()
}

/// Get the generics from an item's inner data, if any. Used by the
/// link extractors.
fn item_generics(item: &rdt::Item) -> Option<&rdt::Generics> {
    match &item.inner {
        rdt::ItemEnum::Struct(s) => Some(&s.generics),
        rdt::ItemEnum::Union(u) => Some(&u.generics),
        rdt::ItemEnum::Enum(e) => Some(&e.generics),
        rdt::ItemEnum::Function(f) => Some(&f.generics),
        rdt::ItemEnum::Trait(t) => Some(&t.generics),
        rdt::ItemEnum::TraitAlias(a) => Some(&a.generics),
        rdt::ItemEnum::TypeAlias(a) => Some(&a.generics),
        rdt::ItemEnum::AssocType { generics, .. } => Some(generics),
        _ => None,
    }
}

/// Collect resolved type links from a Type tree.
/// Maps cleaned display name → resolved node ID for every ResolvedPath encountered.
fn collect_type_links(
    ty: &rdt::Type,
    krate: &rdt::Crate,
    crate_name: &str,
    path_index: &PathIndex,
    links: &mut HashMap<String, String>,
) {
    match ty {
        rdt::Type::ResolvedPath(path) => {
            let display = clean_path(&path.path);
            if let Some(node_id) = resolve_id(krate, crate_name, path_index, path.id) {
                links.insert(display, node_id);
            }
            if let Some(args) = &path.args {
                collect_generic_args_links(args, krate, crate_name, path_index, links);
            }
        }
        rdt::Type::DynTrait(dyn_trait) => {
            for poly in &dyn_trait.traits {
                let display = clean_path(&poly.trait_.path);
                if let Some(node_id) = resolve_id(krate, crate_name, path_index, poly.trait_.id) {
                    links.insert(display, node_id);
                }
                if let Some(args) = &poly.trait_.args {
                    collect_generic_args_links(args, krate, crate_name, path_index, links);
                }
            }
        }
        rdt::Type::BorrowedRef { type_, .. }
        | rdt::Type::RawPointer { type_, .. }
        | rdt::Type::Slice(type_)
        | rdt::Type::Array { type_, .. }
        | rdt::Type::Pat { type_, .. } => {
            collect_type_links(type_, krate, crate_name, path_index, links);
        }
        rdt::Type::Tuple(types) => {
            for t in types {
                collect_type_links(t, krate, crate_name, path_index, links);
            }
        }
        rdt::Type::FunctionPointer(fp) => {
            for (_, t) in &fp.sig.inputs {
                collect_type_links(t, krate, crate_name, path_index, links);
            }
            if let Some(out) = &fp.sig.output {
                collect_type_links(out, krate, crate_name, path_index, links);
            }
        }
        rdt::Type::ImplTrait(bounds) => {
            for bound in bounds {
                if let rdt::GenericBound::TraitBound { trait_, .. } = bound {
                    let display = clean_path(&trait_.path);
                    if let Some(node_id) = resolve_id(krate, crate_name, path_index, trait_.id) {
                        links.insert(display, node_id);
                    }
                    if let Some(args) = &trait_.args {
                        collect_generic_args_links(args, krate, crate_name, path_index, links);
                    }
                }
            }
        }
        rdt::Type::QualifiedPath {
            self_type,
            trait_,
            args,
            ..
        } => {
            collect_type_links(self_type, krate, crate_name, path_index, links);
            if let Some(trait_path) = trait_ {
                let display = clean_path(&trait_path.path);
                if let Some(node_id) = resolve_id(krate, crate_name, path_index, trait_path.id) {
                    links.insert(display, node_id);
                }
                if let Some(args) = &trait_path.args {
                    collect_generic_args_links(args, krate, crate_name, path_index, links);
                }
            }
            if let Some(args) = args.as_deref() {
                collect_generic_args_links(args, krate, crate_name, path_index, links);
            }
        }
        _ => {}
    }
}

fn collect_generic_args_links(
    args: &rdt::GenericArgs,
    krate: &rdt::Crate,
    crate_name: &str,
    path_index: &PathIndex,
    links: &mut HashMap<String, String>,
) {
    match args {
        rdt::GenericArgs::AngleBracketed { args, constraints } => {
            for arg in args {
                if let rdt::GenericArg::Type(t) = arg {
                    collect_type_links(t, krate, crate_name, path_index, links);
                }
            }
            for constraint in constraints {
                collect_assoc_constraint_links(constraint, krate, crate_name, path_index, links);
            }
        }
        rdt::GenericArgs::Parenthesized { inputs, output } => {
            for input in inputs {
                collect_type_links(input, krate, crate_name, path_index, links);
            }
            if let Some(out) = output {
                collect_type_links(out, krate, crate_name, path_index, links);
            }
        }
        rdt::GenericArgs::ReturnTypeNotation => {}
    }
}

fn collect_assoc_constraint_links(
    constraint: &rdt::AssocItemConstraint,
    krate: &rdt::Crate,
    crate_name: &str,
    path_index: &PathIndex,
    links: &mut HashMap<String, String>,
) {
    if let Some(args) = constraint.args.as_deref() {
        collect_generic_args_links(args, krate, crate_name, path_index, links);
    }
    match &constraint.binding {
        rdt::AssocItemConstraintKind::Equality(term) => {
            collect_term_links(term, krate, crate_name, path_index, links);
        }
        rdt::AssocItemConstraintKind::Constraint(bounds) => {
            for (display, node_id) in collect_bound_links(bounds, krate, crate_name, path_index) {
                links.insert(display, node_id);
            }
        }
    }
}

fn collect_term_links(
    term: &rdt::Term,
    krate: &rdt::Crate,
    crate_name: &str,
    path_index: &PathIndex,
    links: &mut HashMap<String, String>,
) {
    if let rdt::Term::Type(ty) = term {
        collect_type_links(ty, krate, crate_name, path_index, links);
    }
}

/// Extract type links from a function signature (inputs + output).
fn extract_signature_links(
    sig: &rdt::FunctionSignature,
    krate: &rdt::Crate,
    crate_name: &str,
    path_index: &PathIndex,
) -> HashMap<String, String> {
    let mut links = HashMap::new();
    for (_, ty) in &sig.inputs {
        collect_type_links(ty, krate, crate_name, path_index, &mut links);
    }
    if let Some(output) = &sig.output {
        collect_type_links(output, krate, crate_name, path_index, &mut links);
    }
    links
}

/// Extract type links from struct/enum fields.
fn extract_field_type_links(
    index: &HashMap<rdt::Id, rdt::Item>,
    field_ids: &[rdt::Id],
    krate: &rdt::Crate,
    crate_name: &str,
    path_index: &PathIndex,
) -> HashMap<String, String> {
    let mut links = HashMap::new();
    for field_id in field_ids {
        if let Some(item) = index.get(field_id)
            && let rdt::ItemEnum::StructField(ty) = &item.inner
        {
            collect_type_links(ty, krate, crate_name, path_index, &mut links);
        }
    }
    links
}

/// Collect resolved trait bound links from a slice of generic bounds.
/// Returns a map from cleaned display name → resolved node ID.
fn collect_bound_links(
    bounds: &[rdt::GenericBound],
    krate: &rdt::Crate,
    crate_name: &str,
    path_index: &PathIndex,
) -> HashMap<String, String> {
    let mut links = HashMap::new();
    for bound in bounds {
        if let rdt::GenericBound::TraitBound {
            trait_,
            generic_params,
            ..
        } = bound
        {
            let display = clean_path(&trait_.path);
            if let Some(node_id) = resolve_id(krate, crate_name, path_index, trait_.id) {
                links.insert(display, node_id);
            }
            if let Some(args) = &trait_.args {
                collect_generic_args_links(args, krate, crate_name, path_index, &mut links);
            }
            collect_generic_param_def_links(
                generic_params,
                krate,
                crate_name,
                path_index,
                &mut links,
            );
        }
    }
    links
}

fn collect_generic_param_def_links(
    params: &[rdt::GenericParamDef],
    krate: &rdt::Crate,
    crate_name: &str,
    path_index: &PathIndex,
    links: &mut HashMap<String, String>,
) {
    for param in params {
        match &param.kind {
            rdt::GenericParamDefKind::Lifetime { .. } => {}
            rdt::GenericParamDefKind::Type {
                bounds, default, ..
            } => {
                for (display, node_id) in collect_bound_links(bounds, krate, crate_name, path_index)
                {
                    links.insert(display, node_id);
                }
                if let Some(default) = default {
                    collect_type_links(default, krate, crate_name, path_index, links);
                }
            }
            rdt::GenericParamDefKind::Const { type_, .. } => {
                collect_type_links(type_, krate, crate_name, path_index, links);
            }
        }
    }
}

fn extract_docs(item: &rdt::Item) -> Option<String> {
    item.docs.clone()
}

/// Extract and resolve intra-doc links from an item.
/// Returns a map from link text to resolved node ID.
fn extract_doc_links(
    item: &rdt::Item,
    krate: &rdt::Crate,
    default_crate_name: &str,
    path_index: &PathIndex,
    canonical_to_alias: &HashMap<String, String>,
) -> HashMap<String, String> {
    item.links
        .iter()
        .filter_map(|(text, id)| {
            resolve_id(krate, default_crate_name, path_index, *id).map(|resolved| {
                // Prefer the user-friendly re-export alias over the verbose
                // canonical path when available.
                let target = canonical_to_alias
                    .get(&resolved)
                    .cloned()
                    .unwrap_or(resolved);
                (text.clone(), target)
            })
        })
        .collect()
}

#[derive(Default)]
struct ItemDetails {
    fields: Option<Vec<FieldInfo>>,
    variants: Option<Vec<VariantInfo>>,
    signature: Option<FunctionSignature>,
    /// Structured generics (params + where-clause).
    generics: CvGenerics,
    docs: Option<String>,
    is_unsafe: bool,
    is_auto: bool,
    is_mutable: bool,
    is_stripped: bool,
    has_stripped_fields: bool,
    has_stripped_variants: bool,
    is_dyn_compatible: Option<bool>,
    required_trait_methods: Option<Vec<String>>,
    default_trait_methods: Option<Vec<String>>,
    /// Structured type expression (replaces the old `type_name: String`).
    type_: Option<TypeRef>,
    variant_kind: Option<CvVariantKind>,
    discriminant: Option<String>,
    const_value: Option<String>,
    /// Structured bounds (replaces the old `bounds: Vec<String>`).
    bounds: Vec<CvGenericBound>,
    import_source: Option<String>,
    import_name: Option<String>,
    is_glob: bool,
    extern_crate_name: Option<String>,
    extern_crate_rename: Option<String>,
    macro_source: Option<String>,
    proc_macro_kind: Option<String>,
    proc_macro_helpers: Vec<String>,
}

fn trait_method_sets(
    index: &HashMap<rdt::Id, rdt::Item>,
    trait_items: &[rdt::Id],
) -> (Option<Vec<String>>, Option<Vec<String>>) {
    let mut required = Vec::new();
    let mut defaulted = Vec::new();
    for trait_item_id in trait_items {
        let Some(trait_item) = index.get(trait_item_id) else {
            continue;
        };
        let rdt::ItemEnum::Function(function) = &trait_item.inner else {
            continue;
        };
        let Some(name) = trait_item.name.clone() else {
            continue;
        };
        if function.has_body {
            defaulted.push(name);
        } else {
            required.push(name);
        }
    }
    required.sort();
    defaulted.sort();
    (
        if required.is_empty() {
            None
        } else {
            Some(required)
        },
        if defaulted.is_empty() {
            None
        } else {
            Some(defaulted)
        },
    )
}

fn extract_item_details(index: &HashMap<rdt::Id, rdt::Item>, item: &rdt::Item) -> ItemDetails {
    let docs = extract_docs(item);
    match &item.inner {
        rdt::ItemEnum::Module(module) => ItemDetails {
            is_stripped: module.is_stripped,
            docs,
            ..Default::default()
        },
        rdt::ItemEnum::Struct(item_struct) => ItemDetails {
            fields: extract_struct_fields(index, &item_struct.kind),
            generics: map_generics(&item_struct.generics),
            has_stripped_fields: struct_has_stripped_fields(&item_struct.kind),
            docs,
            ..Default::default()
        },
        rdt::ItemEnum::Union(item_union) => {
            let fields: Vec<_> = item_union
                .fields
                .iter()
                .filter_map(|id| {
                    let field_item = index.get(id)?;
                    let rdt::ItemEnum::StructField(ty) = &field_item.inner else {
                        return None;
                    };
                    Some(FieldInfo {
                        name: field_item.name.clone().unwrap_or_default(),
                        type_: map_type(ty),
                        visibility: map_visibility(&field_item.visibility),
                    })
                })
                .collect();
            ItemDetails {
                fields: if fields.is_empty() {
                    None
                } else {
                    Some(fields)
                },
                generics: map_generics(&item_union.generics),
                has_stripped_fields: item_union.has_stripped_fields,
                docs,
                ..Default::default()
            }
        }
        rdt::ItemEnum::Enum(item_enum) => ItemDetails {
            variants: extract_enum_variants(index, &item_enum.variants),
            generics: map_generics(&item_enum.generics),
            has_stripped_variants: item_enum.has_stripped_variants,
            docs,
            ..Default::default()
        },
        rdt::ItemEnum::Variant(variant) => {
            let (variant_kind, field_ids): (CvVariantKind, Vec<rdt::Id>) = match &variant.kind {
                rdt::VariantKind::Plain => (CvVariantKind::Unit, Vec::new()),
                rdt::VariantKind::Tuple(fields) => (
                    CvVariantKind::Tuple,
                    fields.iter().filter_map(|id| *id).collect(),
                ),
                rdt::VariantKind::Struct { fields, .. } => (CvVariantKind::Struct, fields.clone()),
            };
            ItemDetails {
                fields: extract_field_list(index, &field_ids),
                variant_kind: Some(variant_kind),
                discriminant: variant.discriminant.as_ref().map(|d| d.expr.clone()),
                has_stripped_fields: variant_has_stripped_fields(&variant.kind),
                docs,
                ..Default::default()
            }
        }
        rdt::ItemEnum::StructField(ty) => ItemDetails {
            type_: Some(map_type(ty)),
            docs,
            ..Default::default()
        },
        rdt::ItemEnum::Function(function) => ItemDetails {
            signature: Some(extract_function_signature(
                &function.sig,
                &function.header,
                &function.generics,
            )),
            generics: map_generics(&function.generics),
            docs,
            ..Default::default()
        },
        rdt::ItemEnum::Trait(item_trait) => {
            let (required_trait_methods, default_trait_methods) =
                trait_method_sets(index, &item_trait.items);
            ItemDetails {
                generics: map_generics(&item_trait.generics),
                is_unsafe: item_trait.is_unsafe,
                is_auto: item_trait.is_auto,
                is_dyn_compatible: Some(item_trait.is_dyn_compatible),
                bounds: map_bounds(&item_trait.bounds),
                required_trait_methods,
                default_trait_methods,
                docs,
                ..Default::default()
            }
        }
        rdt::ItemEnum::TraitAlias(alias) => ItemDetails {
            generics: map_generics(&alias.generics),
            bounds: map_bounds(&alias.params),
            docs,
            ..Default::default()
        },
        rdt::ItemEnum::TypeAlias(alias) => ItemDetails {
            generics: map_generics(&alias.generics),
            type_: Some(map_type(&alias.type_)),
            docs,
            ..Default::default()
        },
        rdt::ItemEnum::Constant { type_, const_ } => ItemDetails {
            type_: Some(map_type(type_)),
            const_value: Some(const_.expr.clone()),
            docs,
            ..Default::default()
        },
        rdt::ItemEnum::Static(item_static) => ItemDetails {
            type_: Some(map_type(&item_static.type_)),
            const_value: Some(item_static.expr.clone()),
            is_mutable: item_static.is_mutable,
            is_unsafe: item_static.is_unsafe,
            docs,
            ..Default::default()
        },
        rdt::ItemEnum::Use(use_item) => ItemDetails {
            import_source: Some(use_item.source.clone()),
            import_name: Some(use_item.name.clone()),
            is_glob: use_item.is_glob,
            docs,
            ..Default::default()
        },
        rdt::ItemEnum::ExternCrate { name, rename } => ItemDetails {
            extern_crate_name: Some(name.clone()),
            extern_crate_rename: rename.clone(),
            docs,
            ..Default::default()
        },
        rdt::ItemEnum::Macro(source) => ItemDetails {
            macro_source: Some(source.clone()),
            docs,
            ..Default::default()
        },
        rdt::ItemEnum::ProcMacro(proc_macro) => ItemDetails {
            proc_macro_kind: Some(format_proc_macro_kind(proc_macro.kind)),
            proc_macro_helpers: proc_macro.helpers.clone(),
            docs,
            ..Default::default()
        },
        rdt::ItemEnum::AssocType {
            generics,
            bounds,
            type_,
        } => ItemDetails {
            generics: map_generics(generics),
            bounds: map_bounds(bounds),
            type_: type_.as_ref().map(map_type),
            docs,
            ..Default::default()
        },
        rdt::ItemEnum::AssocConst { type_, value } => ItemDetails {
            type_: Some(map_type(type_)),
            const_value: value.clone(),
            docs,
            ..Default::default()
        },
        // Primitive item kinds carry only `name` + an `impls` list; the
        // impl IDs are processed separately by the edge-resolution path
        // (each impl becomes an Implements edge), so there's nothing to
        // extract into ItemDetails beyond the docs.
        rdt::ItemEnum::Primitive(_) => ItemDetails {
            docs,
            ..Default::default()
        },
        // `extern { type Foo; }` — opaque, no payload, no impls.
        rdt::ItemEnum::ExternType => ItemDetails {
            docs,
            ..Default::default()
        },
        // Impl blocks are handled by `process_impl` in the edge-resolution
        // path, not here. Falling through means impl items somehow leaked
        // out of that path — preserve docs and continue.
        rdt::ItemEnum::Impl(_) => ItemDetails {
            docs,
            ..Default::default()
        },
        // No catch-all: a missing arm fails compile when rustdoc-types
        // adds a new variant, which is precisely the schema-drift signal
        // we want at the maintainer's CI step rather than as silent data
        // loss in production. The format-version warning in
        // parse_rustdoc_lenient surfaces drift at parse time as a
        // secondary defence.
    }
}

fn ensure_crate_node(
    graph: &mut Graph,
    node_cache: &mut HashSet<String>,
    crate_name: &str,
    visibility: Visibility,
    is_external: bool,
) {
    if node_cache.contains(crate_name) {
        return;
    }

    graph.add_node(Node {
        id: crate_name.to_string(),
        name: crate_name.to_string(),
        kind: NodeKind::Crate,
        visibility,
        line_count: None,
        span: None,
        attrs: Vec::new(),
        is_external,
        is_deprecated: false,
        is_unsafe: false,
        is_auto: false,
        is_mutable: false,
        is_stripped: false,
        has_stripped_fields: false,
        has_stripped_variants: false,
        is_dyn_compatible: None,
        deprecation: None,
        fields: None,
        variants: None,
        signature: None,
        generics: CvGenerics::default(),
        docs: None,
        doc_links: HashMap::new(),
        impl_type: None,
        parent_impl: None,
        impl_trait: None,
        impl_category: None,
        provided_trait_methods: None,
        required_trait_methods: None,
        default_trait_methods: None,
        type_: None,
        variant_kind: None,
        discriminant: None,
        const_value: None,
        bounds: Vec::new(),
        import_source: None,
        import_name: None,
        is_glob: false,
        extern_crate_name: None,
        extern_crate_rename: None,
        macro_source: None,
        proc_macro_kind: None,
        proc_macro_helpers: Vec::new(),
    });
    node_cache.insert(crate_name.to_string());
}

fn ensure_module_nodes(
    graph: &mut Graph,
    node_cache: &mut HashSet<String>,
    edge_cache: &mut HashSet<String>,
    placeholder_module_nodes: &mut HashSet<String>,
    crate_name: &str,
    path: &[String],
    path_index: &PathIndex,
    is_external: bool,
) {
    if path.len() <= 1 {
        return;
    }

    let mut parent_id = crate_name.to_string();
    for (index, segment) in path[..path.len() - 1].iter().enumerate() {
        let module_id = join_path(crate_name, &path[..=index]);
        if path_index.is_known_non_module(&module_id) {
            break;
        }
        if !node_cache.contains(&module_id) {
            graph.add_node(Node {
                id: module_id.clone(),
                name: segment.clone(),
                kind: NodeKind::Module,
                visibility: Visibility::Unknown,
                line_count: None,
                span: None,
                attrs: Vec::new(),
                is_external,
                is_deprecated: false,
                is_unsafe: false,
                is_auto: false,
                is_mutable: false,
                is_stripped: false,
                has_stripped_fields: false,
                has_stripped_variants: false,
                is_dyn_compatible: None,
                deprecation: None,
                fields: None,
                variants: None,
                signature: None,
                generics: CvGenerics::default(),
                docs: None,
                doc_links: HashMap::new(),
                impl_type: None,
                parent_impl: None,
                impl_trait: None,
                impl_category: None,
                provided_trait_methods: None,
                required_trait_methods: None,
                default_trait_methods: None,
                type_: None,
                variant_kind: None,
                discriminant: None,
                const_value: None,
                bounds: Vec::new(),
                import_source: None,
                import_name: None,
                is_glob: false,
                extern_crate_name: None,
                extern_crate_rename: None,
                macro_source: None,
                proc_macro_kind: None,
                proc_macro_helpers: Vec::new(),
            });
            node_cache.insert(module_id.clone());
            placeholder_module_nodes.insert(module_id.clone());
        }

        // Skip self-loops
        if parent_id != module_id {
            push_edge(
                graph,
                edge_cache,
                parent_id.clone(),
                module_id.clone(),
                EdgeKind::Contains,
                Confidence::Static,
            );
        }

        parent_id = module_id;
    }
}

fn upsert_node(
    graph: &mut Graph,
    node_cache: &mut HashSet<String>,
    placeholder_module_nodes: &mut HashSet<String>,
    node: Node,
) {
    let id = node.id.clone();
    if placeholder_module_nodes.remove(&id) {
        if let Some(existing) = graph.nodes.iter_mut().find(|existing| existing.id == id) {
            *existing = node;
        } else {
            graph.add_node(node);
        }
        node_cache.insert(id);
        return;
    }

    if node_cache.insert(id) {
        graph.add_node(node);
    }
}

fn materialize_missing_external_edge_nodes(
    graph: &mut Graph,
    node_cache: &mut HashSet<String>,
    workspace_members: &HashSet<String>,
    path_index: &PathIndex,
) {
    let mut missing = HashSet::new();
    for edge in &graph.edges {
        if !node_cache.contains(&edge.from) {
            missing.insert(edge.from.clone());
        }
        if !node_cache.contains(&edge.to) {
            missing.insert(edge.to.clone());
        }
    }

    for id in missing {
        let crate_name = id.split("::").next().unwrap_or(id.as_str());
        if workspace_members.contains(crate_name) {
            continue;
        }
        let Some(kind) = path_index.node_kinds.get(&id).copied() else {
            continue;
        };
        ensure_crate_node(graph, node_cache, crate_name, Visibility::Public, true);
        if node_cache.insert(id.clone()) {
            graph.add_node(external_stub_node(id, kind));
        }
    }
}

fn prune_dangling_edges(graph: &mut Graph, node_cache: &HashSet<String>) {
    graph
        .edges
        .retain(|edge| node_cache.contains(&edge.from) && node_cache.contains(&edge.to));
}

fn external_stub_node(id: String, kind: NodeKind) -> Node {
    Node {
        name: last_segment(id.clone()),
        id,
        kind,
        visibility: Visibility::Unknown,
        line_count: None,
        span: None,
        attrs: Vec::new(),
        is_external: true,
        is_deprecated: false,
        is_unsafe: false,
        is_auto: false,
        is_mutable: false,
        is_stripped: false,
        has_stripped_fields: false,
        has_stripped_variants: false,
        is_dyn_compatible: None,
        deprecation: None,
        fields: None,
        variants: None,
        signature: None,
        generics: CvGenerics::default(),
        docs: None,
        doc_links: HashMap::new(),
        impl_type: None,
        parent_impl: None,
        impl_trait: None,
        impl_category: None,
        provided_trait_methods: None,
        required_trait_methods: None,
        default_trait_methods: None,
        type_: None,
        variant_kind: None,
        discriminant: None,
        const_value: None,
        bounds: Vec::new(),
        import_source: None,
        import_name: None,
        is_glob: false,
        extern_crate_name: None,
        extern_crate_rename: None,
        macro_source: None,
        proc_macro_kind: None,
        proc_macro_helpers: Vec::new(),
    }
}

fn parent_path_id(crate_name: &str, path: &[String]) -> Option<String> {
    if path.is_empty() {
        return None;
    }

    if path.len() == 1 {
        return Some(crate_name.to_string());
    }

    Some(join_path(crate_name, &path[..path.len() - 1]))
}

fn join_path(crate_name: &str, path: &[String]) -> String {
    if path.is_empty() {
        crate_name.to_string()
    } else {
        // Rustdoc paths include the crate name as the first element.
        // Skip it to avoid duplication like "crate::crate::module::Item".
        let start = if path.first().map(|s| s.as_str()) == Some(crate_name) {
            1
        } else {
            0
        };
        if start >= path.len() {
            crate_name.to_string()
        } else {
            format!("{crate_name}::{}", path[start..].join("::"))
        }
    }
}

fn crate_name_for_id(krate: &rdt::Crate, crate_id: u32, fallback: &str) -> String {
    krate
        .external_crates
        .get(&crate_id)
        .map(|krate| krate.name.replace('-', "_"))
        .unwrap_or_else(|| fallback.to_string())
}

fn resolve_id(
    krate: &rdt::Crate,
    default_crate_name: &str,
    path_index: &PathIndex,
    id: rdt::Id,
) -> Option<String> {
    if let Some(node_id) = path_index.node_ids_by_rustdoc_id.get(&id) {
        return Some(node_id.clone());
    }
    krate.paths.get(&id).map(|summary| {
        let crate_name = crate_name_for_id(krate, summary.crate_id, default_crate_name);
        join_path(&crate_name, &summary.path)
    })
}

/// Build the alias map: `public_path → canonical_node_id`.
///
/// For each non-glob `pub use Module::Item` re-export, this records the
/// re-export's location (`parent_module::Item`) as an alias of the canonical
/// definition path. Only registers when the public path is strictly shorter
/// than the canonical (the common case being a private same-name submodule
/// that's re-exported from its parent, e.g. `core::async_iter::async_iter::X`
/// publicly reachable as `core::async_iter::X`).
fn build_aliases(
    krate: &rdt::Crate,
    default_crate_name: &str,
    path_index: &PathIndex,
    item_to_parent: &HashMap<rdt::Id, rdt::Id>,
) -> HashMap<String, String> {
    let mut aliases: HashMap<String, String> = HashMap::new();
    for (use_item_id, item) in &krate.index {
        let rdt::ItemEnum::Use(use_item) = &item.inner else {
            continue;
        };
        if use_item.is_glob {
            continue;
        }
        let Some(target_id) = use_item.id else {
            continue;
        };
        let Some(canonical) = resolve_id(krate, default_crate_name, path_index, target_id) else {
            continue;
        };
        let Some(parent_id) = item_to_parent.get(use_item_id) else {
            continue;
        };
        let Some(parent_canonical) =
            resolve_id(krate, default_crate_name, path_index, *parent_id)
        else {
            continue;
        };

        let public_path = format!("{parent_canonical}::{}", use_item.name);
        if public_path == canonical {
            continue;
        }
        // Skip when the public path is no shorter than the canonical — those
        // are just sibling aliases and don't help URL ergonomics.
        if public_path.split("::").count() >= canonical.split("::").count() {
            continue;
        }
        // First alias wins; further re-exports of the same target keep the
        // shortest-discovered path stable.
        aliases.entry(public_path).or_insert(canonical);
    }
    aliases
}

/// Inverse alias map: canonical_id → shortest_public_alias.
/// Used to rewrite intra-doc link targets so links land on the user-friendly
/// URL rather than the verbose canonical path.
fn invert_aliases(aliases: &HashMap<String, String>) -> HashMap<String, String> {
    let mut inverse: HashMap<String, String> = HashMap::new();
    for (alias, canonical) in aliases {
        match inverse.entry(canonical.clone()) {
            std::collections::hash_map::Entry::Vacant(e) => {
                e.insert(alias.clone());
            }
            std::collections::hash_map::Entry::Occupied(mut e) => {
                if alias.len() < e.get().len() {
                    e.insert(alias.clone());
                }
            }
        }
    }
    inverse
}

fn type_to_id(ty: &rdt::Type) -> Option<rdt::Id> {
    match ty {
        rdt::Type::ResolvedPath(path) => Some(path.id),
        rdt::Type::QualifiedPath { self_type, .. } => type_to_id(self_type),
        _ => None,
    }
}

fn impl_node_id(crate_name: &str, id: rdt::Id) -> String {
    format!("{crate_name}::impl-{}", id.0)
}

fn impl_node_name(
    krate: &rdt::Crate,
    default_crate_name: &str,
    path_index: &PathIndex,
    impl_block: &rdt::Impl,
) -> String {
    let type_name = type_to_id(&impl_block.for_)
        .and_then(|id| resolve_id(krate, default_crate_name, path_index, id))
        .map(last_segment)
        .unwrap_or_else(|| "type".to_string());

    if let Some(trait_path) = impl_block.trait_.as_ref() {
        let trait_name = resolve_id(krate, default_crate_name, path_index, trait_path.id)
            .map(last_segment)
            .unwrap_or_else(|| last_segment(trait_path.path.clone()));
        format!("impl {trait_name} for {type_name}")
    } else {
        format!("impl {type_name}")
    }
}

fn last_segment(path: String) -> String {
    path.split("::").last().unwrap_or(&path).to_string()
}

fn collect_struct_field_ids(
    index: &HashMap<rdt::Id, rdt::Item>,
    kind: &rdt::StructKind,
    type_ids: &mut HashSet<rdt::Id>,
) {
    match kind {
        rdt::StructKind::Unit => {}
        rdt::StructKind::Tuple(fields) => {
            for field_id in fields.iter().filter_map(|id| *id) {
                collect_field_ids(index, &[field_id], type_ids);
            }
        }
        rdt::StructKind::Plain { fields, .. } => {
            collect_field_ids(index, fields, type_ids);
        }
    }
}

fn collect_enum_variant_ids(
    index: &HashMap<rdt::Id, rdt::Item>,
    variants: &[rdt::Id],
    type_ids: &mut HashSet<rdt::Id>,
) {
    for variant_id in variants {
        let Some(item) = index.get(variant_id) else {
            continue;
        };
        let rdt::ItemEnum::Variant(variant) = &item.inner else {
            continue;
        };
        match &variant.kind {
            rdt::VariantKind::Plain => {}
            rdt::VariantKind::Tuple(fields) => {
                for field_id in fields.iter().filter_map(|id| *id) {
                    collect_field_ids(index, &[field_id], type_ids);
                }
            }
            rdt::VariantKind::Struct { fields, .. } => {
                collect_field_ids(index, fields, type_ids);
            }
        }
    }
}

fn collect_field_ids(
    index: &HashMap<rdt::Id, rdt::Item>,
    fields: &[rdt::Id],
    type_ids: &mut HashSet<rdt::Id>,
) {
    for field_id in fields {
        let Some(item) = index.get(field_id) else {
            continue;
        };
        if let rdt::ItemEnum::StructField(field_type) = &item.inner {
            collect_type_ids(field_type, type_ids);
        }
    }
}

fn collect_type_ids(ty: &rdt::Type, type_ids: &mut HashSet<rdt::Id>) {
    match ty {
        rdt::Type::ResolvedPath(path) => {
            type_ids.insert(path.id);
            if let Some(args) = path.args.as_deref() {
                collect_generic_args_ids(args, type_ids);
            }
        }
        rdt::Type::DynTrait(dyn_trait) => {
            for poly in &dyn_trait.traits {
                type_ids.insert(poly.trait_.id);
                if let Some(args) = poly.trait_.args.as_deref() {
                    collect_generic_args_ids(args, type_ids);
                }
                collect_generic_param_defs(&poly.generic_params, type_ids);
            }
        }
        rdt::Type::FunctionPointer(pointer) => {
            collect_signature_ids(&pointer.sig, type_ids);
            collect_generic_param_defs(&pointer.generic_params, type_ids);
        }
        rdt::Type::Tuple(items) => {
            for item in items {
                collect_type_ids(item, type_ids);
            }
        }
        rdt::Type::Slice(inner) => collect_type_ids(inner, type_ids),
        rdt::Type::Array { type_, .. } => collect_type_ids(type_, type_ids),
        rdt::Type::Pat { type_, .. } => collect_type_ids(type_, type_ids),
        rdt::Type::ImplTrait(bounds) => collect_bounds_ids(bounds, type_ids),
        rdt::Type::RawPointer { type_, .. } => collect_type_ids(type_, type_ids),
        rdt::Type::BorrowedRef { type_, .. } => collect_type_ids(type_, type_ids),
        rdt::Type::QualifiedPath {
            self_type,
            trait_,
            args,
            ..
        } => {
            collect_type_ids(self_type, type_ids);
            if let Some(trait_path) = trait_ {
                type_ids.insert(trait_path.id);
                if let Some(args) = trait_path.args.as_deref() {
                    collect_generic_args_ids(args, type_ids);
                }
            }
            if let Some(args) = args.as_deref() {
                collect_generic_args_ids(args, type_ids);
            }
        }
        _ => {}
    }
}

fn collect_generic_args_ids(args: &rdt::GenericArgs, type_ids: &mut HashSet<rdt::Id>) {
    match args {
        rdt::GenericArgs::AngleBracketed { args, constraints } => {
            for arg in args {
                collect_generic_arg_ids(arg, type_ids);
            }
            for constraint in constraints {
                collect_assoc_constraint_ids(constraint, type_ids);
            }
        }
        rdt::GenericArgs::Parenthesized { inputs, output } => {
            for input in inputs {
                collect_type_ids(input, type_ids);
            }
            if let Some(output) = output {
                collect_type_ids(output, type_ids);
            }
        }
        rdt::GenericArgs::ReturnTypeNotation => {}
    }
}

fn collect_generic_arg_ids(arg: &rdt::GenericArg, type_ids: &mut HashSet<rdt::Id>) {
    if let rdt::GenericArg::Type(ty) = arg {
        collect_type_ids(ty, type_ids);
    }
}

fn collect_assoc_constraint_ids(
    constraint: &rdt::AssocItemConstraint,
    type_ids: &mut HashSet<rdt::Id>,
) {
    if let Some(args) = constraint.args.as_deref() {
        collect_generic_args_ids(args, type_ids);
    }
    match &constraint.binding {
        rdt::AssocItemConstraintKind::Equality(term) => {
            collect_term_ids(term, type_ids);
        }
        rdt::AssocItemConstraintKind::Constraint(bounds) => {
            collect_bounds_ids(bounds, type_ids);
        }
    }
}

fn collect_term_ids(term: &rdt::Term, type_ids: &mut HashSet<rdt::Id>) {
    if let rdt::Term::Type(ty) = term {
        collect_type_ids(ty, type_ids);
    }
}

fn collect_bounds_ids(bounds: &[rdt::GenericBound], type_ids: &mut HashSet<rdt::Id>) {
    for bound in bounds {
        match bound {
            rdt::GenericBound::TraitBound {
                trait_,
                generic_params,
                ..
            } => {
                type_ids.insert(trait_.id);
                if let Some(args) = trait_.args.as_deref() {
                    collect_generic_args_ids(args, type_ids);
                }
                collect_generic_param_defs(generic_params, type_ids);
            }
            rdt::GenericBound::Outlives(_) => {}
            rdt::GenericBound::Use(_) => {}
        }
    }
}

fn collect_generic_param_defs(params: &[rdt::GenericParamDef], type_ids: &mut HashSet<rdt::Id>) {
    for param in params {
        match &param.kind {
            rdt::GenericParamDefKind::Lifetime { .. } => {}
            rdt::GenericParamDefKind::Type {
                bounds, default, ..
            } => {
                collect_bounds_ids(bounds, type_ids);
                if let Some(default) = default {
                    collect_type_ids(default, type_ids);
                }
            }
            rdt::GenericParamDefKind::Const { type_, .. } => {
                collect_type_ids(type_, type_ids);
            }
        }
    }
}

fn collect_generics_ids(generics: &rdt::Generics, type_ids: &mut HashSet<rdt::Id>) {
    collect_generic_param_defs(&generics.params, type_ids);
    for predicate in &generics.where_predicates {
        collect_where_predicate_ids(predicate, type_ids);
    }
}

fn collect_where_predicate_ids(predicate: &rdt::WherePredicate, type_ids: &mut HashSet<rdt::Id>) {
    match predicate {
        rdt::WherePredicate::BoundPredicate {
            type_,
            bounds,
            generic_params,
        } => {
            collect_type_ids(type_, type_ids);
            collect_bounds_ids(bounds, type_ids);
            collect_generic_param_defs(generic_params, type_ids);
        }
        rdt::WherePredicate::LifetimePredicate { .. } => {}
        rdt::WherePredicate::EqPredicate { lhs, rhs } => {
            collect_type_ids(lhs, type_ids);
            collect_term_ids(rhs, type_ids);
        }
    }
}

fn collect_signature_ids(sig: &rdt::FunctionSignature, type_ids: &mut HashSet<rdt::Id>) {
    for (_, ty) in &sig.inputs {
        collect_type_ids(ty, type_ids);
    }
    if let Some(output) = sig.output.as_ref() {
        collect_type_ids(output, type_ids);
    }
}

fn add_uses_edges(
    graph: &mut Graph,
    edge_cache: &mut HashSet<String>,
    owner_id: &str,
    type_ids: HashSet<rdt::Id>,
    krate: &rdt::Crate,
    default_crate_name: &str,
    path_index: &PathIndex,
) {
    for type_id in type_ids {
        if let Some(target_id) = resolve_id(krate, default_crate_name, path_index, type_id) {
            if target_id == owner_id {
                continue;
            }
            push_edge(
                graph,
                edge_cache,
                owner_id.to_string(),
                target_id,
                EdgeKind::UsesType,
                Confidence::Static,
            );
        }
    }
}

fn add_use_import_edges_with_parent_map(
    graph: &mut Graph,
    edge_cache: &mut HashSet<String>,
    krate: &rdt::Crate,
    default_crate_name: &str,
    path_index: &PathIndex,
    item_to_parent: &HashMap<rdt::Id, rdt::Id>,
) {
    // Process use items and create edges from parent module to target
    for (item_id, item) in &krate.index {
        let rdt::ItemEnum::Use(use_item) = &item.inner else {
            continue;
        };
        let Some(target_id) = use_item.id else {
            continue;
        };

        // Find the parent module of this use item
        let parent_module_id = if let Some(parent_id) = item_to_parent.get(item_id) {
            *parent_id
        } else {
            continue;
        };

        // Resolve the parent module to a node ID
        let Some(parent_node_id) =
            resolve_id(krate, default_crate_name, path_index, parent_module_id)
        else {
            continue;
        };

        // Resolve the target to a node ID
        let Some(target_node_id) = resolve_id(krate, default_crate_name, path_index, target_id)
        else {
            continue;
        };

        // Create edge from parent module to re-exported item
        push_edge_with_glob(
            graph,
            edge_cache,
            parent_node_id,
            target_node_id,
            EdgeKind::ReExports,
            Confidence::Static,
            use_item.is_glob,
        );
    }
}

fn add_derives_edges(
    graph: &mut Graph,
    edge_cache: &mut HashSet<String>,
    owner_id: &str,
    attrs: &[rdt::Attribute],
    trait_lookup: &HashMap<String, Vec<String>>,
) {
    for trait_name in parse_derive_traits(attrs) {
        if trait_name.contains("::") {
            if let Some(paths) = trait_lookup.get(&trait_name) {
                for path in paths {
                    push_edge(
                        graph,
                        edge_cache,
                        owner_id.to_string(),
                        path.clone(),
                        EdgeKind::Derives,
                        Confidence::Inferred,
                    );
                }
            }
        } else if let Some(paths) = trait_lookup.get(&trait_name)
            && paths.len() == 1
        {
            push_edge(
                graph,
                edge_cache,
                owner_id.to_string(),
                paths[0].clone(),
                EdgeKind::Derives,
                Confidence::Inferred,
            );
        }
    }
}

fn parse_derive_traits(attrs: &[rdt::Attribute]) -> Vec<String> {
    let mut traits = Vec::new();
    for attr in attrs.iter().filter_map(attribute_to_string) {
        let trimmed = attr.trim();
        let Some(start) = trimmed.find("derive(") else {
            continue;
        };
        let remainder = &trimmed[start + "derive(".len()..];
        let Some(end) = remainder.find(')') else {
            continue;
        };
        let inside = &remainder[..end];
        for name in inside.split(',') {
            let name = name.trim();
            if !name.is_empty() {
                traits.push(name.to_string());
            }
        }
    }
    traits
}

fn format_attributes(attrs: &[rdt::Attribute]) -> Vec<String> {
    attrs.iter().filter_map(attribute_to_string).collect()
}

fn attribute_to_string(attr: &rdt::Attribute) -> Option<String> {
    match attr {
        rdt::Attribute::NonExhaustive => Some("#[non_exhaustive]".to_string()),
        rdt::Attribute::MustUse { reason } => Some(match reason {
            Some(reason) => format!("#[must_use = \"{reason}\"]"),
            None => "#[must_use]".to_string(),
        }),
        rdt::Attribute::MacroExport => Some("#[macro_export]".to_string()),
        rdt::Attribute::ExportName(name) => Some(format!("#[export_name = \"{name}\"]")),
        rdt::Attribute::LinkSection(name) => Some(format!("#[link_section = \"{name}\"]")),
        rdt::Attribute::AutomaticallyDerived => Some("#[automatically_derived]".to_string()),
        rdt::Attribute::Repr(repr) => Some(format!("#[repr({})]", format_repr(repr))),
        rdt::Attribute::NoMangle => Some("#[no_mangle]".to_string()),
        rdt::Attribute::TargetFeature { enable } => {
            let joined = enable
                .iter()
                .map(|feature| format!("enable = \"{feature}\""))
                .collect::<Vec<_>>()
                .join(", ");
            Some(format!("#[target_feature({joined})]"))
        }
        rdt::Attribute::Other(value) => clean_other_attr(value),
    }
}

/// Clean up compiler-internal trace attributes left by `#[cfg]`/`#[cfg_attr]` expansion.
/// Rustdoc emits `<cfg_attr_trace>` and `<cfg_trace>` as internal markers; convert them
/// back to the user-facing `cfg_attr` / `cfg` names.
fn clean_trace_attrs(value: &str) -> String {
    value
        .replace("<cfg_attr_trace>", "cfg_attr")
        .replace("<cfg_trace>", "cfg")
}

/// Convert nightly rustdoc's `#[attr = DebugRepr…]` strings back into source-level
/// attribute syntax. Newer rustdoc JSON emits structured attrs as `Other` strings
/// containing the compiler-internal `Debug` representation, which is unreadable
/// in a UI. We pattern-match the common cases (Stability, Inline, Cold, etc.) and
/// drop internal-only markers (CfgAttrTrace, CfgTrace).
fn clean_other_attr(value: &str) -> Option<String> {
    let cleaned = clean_trace_attrs(value);
    // Normalise multi-line debug output to a single line — the compiler often
    // wraps long argument lists.
    let one_line: String = cleaned
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");

    // Strip the standard `#[attr = X]` wrapper to get the bare Debug payload.
    let payload = one_line
        .strip_prefix("#[attr = ")
        .and_then(|rest| rest.strip_suffix(']'));

    let Some(payload) = payload else {
        // Not in the Debug-wrapper form — pass through (already source-shaped
        // like `#[must_use = "..."]`).
        return Some(one_line);
    };

    // ── Internal compiler markers we never want to show users ──
    // Match both bare unit forms (`CfgAttrTrace`) and tuple/struct forms with
    // args (`CfgTrace([...])`, `AllowInternalUnstable([...])`).
    const INTERNAL_PREFIXES: &[&str] = &[
        "CfgAttrTrace",
        "CfgTrace",
        "AllowInternalUnsafe",
        "AllowInternalUnstable",
        "AllowConstFn",
        "RustcAllowConstFnUnstable",
        "Feature",
        "DocAlias",
        "ProcMacro",
        "Used",
        "Coverage",
        "PassByValue",
        "PointeeSized",
        "ConstParamTy",
    ];
    if INTERNAL_PREFIXES
        .iter()
        .any(|p| payload == *p || payload.starts_with(&format!("{p}(")))
    {
        return None;
    }

    // ── Lang(VariantName) → #[lang = "snake_name"] ──
    if let Some(arg) = payload.strip_prefix("Lang(").and_then(|s| s.strip_suffix(')')) {
        return Some(format!("#[lang = \"{}\"]", camel_to_snake(arg)));
    }

    // ── RustcDiagnosticItem("Name") → #[rustc_diagnostic_item = "Name"] ──
    if let Some(arg) = payload
        .strip_prefix("RustcDiagnosticItem(\"")
        .and_then(|s| s.strip_suffix("\")"))
    {
        return Some(format!("#[rustc_diagnostic_item = \"{arg}\"]"));
    }

    // ── Stability { stability: Stability { level: ..., feature: "..." } } ──
    if payload.starts_with("Stability ") {
        if let Some(rendered) = render_stability(payload) {
            return Some(rendered);
        }
    }

    // ── ConstStability / BodyStability / DefaultBodyStability — same shape ──
    for prefix in ["ConstStability ", "DefaultBodyStability ", "BodyStability "] {
        if payload.starts_with(prefix) {
            if let Some(rendered) = render_stability(payload) {
                return Some(rendered);
            }
        }
    }

    // ── Inline(Hint | Always | Never | No) ──
    if let Some(arg) = payload.strip_prefix("Inline(").and_then(|s| s.strip_suffix(')')) {
        return match arg {
            "Hint" => Some("#[inline]".to_string()),
            "Always" => Some("#[inline(always)]".to_string()),
            "Never" => Some("#[inline(never)]".to_string()),
            "No" => None, // default — not worth showing
            _ => Some("#[inline]".to_string()),
        };
    }

    // ── Optimize(Speed | Size | None) ──
    if let Some(arg) = payload
        .strip_prefix("Optimize(")
        .and_then(|s| s.strip_suffix(')'))
    {
        return match arg {
            "Speed" => Some("#[optimize(speed)]".to_string()),
            "Size" => Some("#[optimize(size)]".to_string()),
            "None" => None,
            _ => Some(format!("#[optimize({})]", arg.to_lowercase())),
        };
    }

    // ── Bare unit variants → lowercase attribute name ──
    if payload.chars().all(|c| c.is_alphanumeric() || c == '_')
        && payload.chars().next().is_some_and(char::is_uppercase)
    {
        return Some(format!("#[{}]", camel_to_snake(payload)));
    }

    // ── Final fallback: keep the cleaned form so users see *something*, but
    //    strip the noisy `#[attr = ]` wrapper and the wrapping `Foo { … }`. ──
    Some(format!("#[{payload}]"))
}

/// Parse a `Stability { stability: Stability { level: …, feature: "…" } }` Debug
/// payload back into `#[stable(feature = "…", since = "X.Y.Z")]` or
/// `#[unstable(feature = "…", issue = "N")]`.
fn render_stability(payload: &str) -> Option<String> {
    let feature = capture_between(payload, "feature: \"", "\"")?;

    if payload.contains("level: Stable ") {
        let major = capture_between(payload, "major: ", ",")?;
        let minor = capture_between(payload, "minor: ", ",")?;
        let patch = capture_between(payload, "patch: ", " ")?
            .trim_end_matches(['}', ')'])
            .to_string();
        return Some(format!(
            "#[stable(feature = \"{feature}\", since = \"{major}.{minor}.{patch}\")]"
        ));
    }

    if payload.contains("level: Unstable ") {
        let issue = capture_between(payload, "issue: ", "}")
            .map(|s| s.trim().trim_end_matches([',', ')']).to_string())
            .unwrap_or_else(|| "None".to_string());
        let reason = capture_between(payload, "reason: Some(\"", "\")");
        let mut parts = vec![format!("feature = \"{feature}\"")];
        if issue != "None" && !issue.is_empty() {
            parts.push(format!("issue = \"{issue}\""));
        }
        if let Some(reason) = reason {
            parts.push(format!("reason = \"{reason}\""));
        }
        return Some(format!("#[unstable({})]", parts.join(", ")));
    }

    None
}

/// Find a substring between `start` and `end` markers (first occurrence after start).
fn capture_between(s: &str, start: &str, end: &str) -> Option<String> {
    let begin = s.find(start)? + start.len();
    let rest = &s[begin..];
    let stop = rest.find(end)?;
    Some(rest[..stop].to_string())
}

/// Camel-or-Pascal case to snake_case. `MustUse` → `must_use`, `MacroExport` →
/// `macro_export`. Conservative — only inserts `_` before uppercase letters that
/// follow a lowercase letter.
fn camel_to_snake(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    let mut prev_lower = false;
    for c in s.chars() {
        if c.is_uppercase() && prev_lower {
            out.push('_');
        }
        out.push(c.to_ascii_lowercase());
        prev_lower = c.is_lowercase();
    }
    out
}

fn format_repr(repr: &rdt::AttributeRepr) -> String {
    let mut parts = Vec::new();
    parts.push(
        match repr.kind {
            rdt::ReprKind::Rust => "rust",
            rdt::ReprKind::C => "C",
            rdt::ReprKind::Transparent => "transparent",
            rdt::ReprKind::Simd => "simd",
        }
        .to_string(),
    );

    if let Some(int) = &repr.int {
        parts.push(int.clone());
    }
    if let Some(align) = repr.align {
        parts.push(format!("align({align})"));
    }
    if let Some(packed) = repr.packed {
        parts.push(format!("packed({packed})"));
    }

    parts.join(", ")
}

fn build_function_index(
    krate: &rdt::Crate,
    method_ids: &HashSet<rdt::Id>,
    default_crate_name: &str,
) -> FunctionIndex {
    let mut index = FunctionIndex::new();
    for (item_id, summary) in &krate.paths {
        if summary.kind != rdt::ItemKind::Function {
            continue;
        }
        if summary.path.is_empty() {
            continue;
        }
        // Skip internal/generated paths
        if summary
            .path
            .iter()
            .any(|seg| seg == "_" || seg.starts_with("__"))
        {
            continue;
        }
        let crate_name = crate_name_for_id(krate, summary.crate_id, default_crate_name);
        let full_path = join_path(&crate_name, &summary.path);
        let name = summary
            .path
            .last()
            .cloned()
            .unwrap_or_else(|| full_path.clone());
        index.add_callable(full_path.clone(), name.clone());
        if method_ids.contains(item_id) {
            index.add_method(full_path, name);
        }
    }
    index
}

/// Abstraction for reading source files — allows both filesystem and in-memory access.
pub trait SourceProvider {
    fn read_file(&self, path: &Path) -> Result<String, RustdocError>;
    fn file_exists(&self, path: &Path) -> bool;
}

/// Reads source files from the local filesystem.
#[cfg(feature = "native")]
pub struct FsSourceProvider;

#[cfg(feature = "native")]
impl SourceProvider for FsSourceProvider {
    fn read_file(&self, path: &Path) -> Result<String, RustdocError> {
        Ok(fs::read_to_string(path)?)
    }
    fn file_exists(&self, path: &Path) -> bool {
        path.exists()
    }
}

/// Reads source files from an in-memory map (for WASM / cloud workflows).
pub struct MemorySourceProvider {
    files: HashMap<String, String>,
}

fn normalize_memory_key(path: &str) -> String {
    path.replace('\\', "/")
}

fn normalize_memory_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

impl MemorySourceProvider {
    pub fn new(files: HashMap<String, String>) -> Self {
        Self {
            files: files
                .into_iter()
                .map(|(k, v)| (normalize_memory_key(&k), v))
                .collect(),
        }
    }
}

impl SourceProvider for MemorySourceProvider {
    fn read_file(&self, path: &Path) -> Result<String, RustdocError> {
        let key = normalize_memory_path(path);
        self.files.get(&key).cloned().ok_or_else(|| {
            RustdocError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("file not in memory source map: {}", path.display()),
            ))
        })
    }
    fn file_exists(&self, path: &Path) -> bool {
        let key = normalize_memory_path(path);
        self.files.contains_key(&key)
    }
}

/// Add call edges from source files using any SourceProvider.
#[allow(private_interfaces)]
fn add_call_edges(
    graph: &mut Graph,
    edge_cache: &mut HashSet<String>,
    root_file: &Path,
    function_index: &FunctionIndex,
    call_mode: CallMode,
    source_provider: &dyn SourceProvider,
) -> Result<(), RustdocError> {
    let mut parser = SourceParser::new(
        function_index,
        graph,
        edge_cache,
        call_mode,
        source_provider,
    );
    parser.parse_module_file(root_file, Vec::new())?;
    Ok(())
}

pub(crate) struct FunctionIndex {
    callables: Vec<String>,
    callables_by_name: HashMap<String, Vec<String>>,
    methods: Vec<String>,
    methods_by_name: HashMap<String, Vec<String>>,
}

impl FunctionIndex {
    fn new() -> Self {
        Self {
            callables: Vec::new(),
            callables_by_name: HashMap::new(),
            methods: Vec::new(),
            methods_by_name: HashMap::new(),
        }
    }

    fn add_callable(&mut self, path: String, name: String) {
        self.callables.push(path.clone());
        self.callables_by_name.entry(name).or_default().push(path);
    }

    fn add_method(&mut self, path: String, name: String) {
        self.methods.push(path.clone());
        self.methods_by_name.entry(name).or_default().push(path);
    }

    fn resolve_callable_by_suffix(&self, segments: &[String]) -> Option<String> {
        resolve_by_suffix(&self.callables, segments)
    }

    fn resolve_callable_by_suffix_all(&self, segments: &[String]) -> Vec<String> {
        resolve_all_by_suffix(&self.callables, segments)
    }

    fn resolve_method_by_suffix(&self, segments: &[String]) -> Option<String> {
        resolve_by_suffix(&self.methods, segments)
    }

    fn resolve_method_by_suffix_all(&self, segments: &[String]) -> Vec<String> {
        resolve_all_by_suffix(&self.methods, segments)
    }

    fn resolve_callable_by_name_unique(&self, name: &str) -> Option<String> {
        resolve_by_unique_name(&self.callables_by_name, name)
    }

    fn resolve_callable_by_name_all(&self, name: &str) -> Vec<String> {
        resolve_by_name(&self.callables_by_name, name)
    }

    fn resolve_method_by_name_unique(&self, name: &str) -> Option<String> {
        resolve_by_unique_name(&self.methods_by_name, name)
    }

    fn resolve_method_by_name_all(&self, name: &str) -> Vec<String> {
        resolve_by_name(&self.methods_by_name, name)
    }
}

fn resolve_by_suffix(paths: &[String], segments: &[String]) -> Option<String> {
    let mut matches = resolve_all_by_suffix(paths, segments);
    if matches.len() == 1 {
        matches.pop()
    } else {
        None
    }
}

fn resolve_all_by_suffix(paths: &[String], segments: &[String]) -> Vec<String> {
    if segments.is_empty() {
        return Vec::new();
    }
    let suffix = format!("::{}", segments.join("::"));
    paths
        .iter()
        .filter(|path| path.ends_with(&suffix))
        .cloned()
        .collect()
}

fn resolve_by_unique_name(map: &HashMap<String, Vec<String>>, name: &str) -> Option<String> {
    let paths = resolve_by_name(map, name);
    if paths.len() == 1 {
        paths.into_iter().next()
    } else {
        None
    }
}

fn resolve_by_name(map: &HashMap<String, Vec<String>>, name: &str) -> Vec<String> {
    map.get(name).cloned().unwrap_or_default()
}

struct SourceParser<'a> {
    function_index: &'a FunctionIndex,
    graph: &'a mut Graph,
    edge_cache: &'a mut HashSet<String>,
    call_mode: CallMode,
    visited_files: HashSet<PathBuf>,
    source_provider: &'a dyn SourceProvider,
}

impl<'a> SourceParser<'a> {
    fn new(
        function_index: &'a FunctionIndex,
        graph: &'a mut Graph,
        edge_cache: &'a mut HashSet<String>,
        call_mode: CallMode,
        source_provider: &'a dyn SourceProvider,
    ) -> Self {
        Self {
            function_index,
            graph,
            edge_cache,
            call_mode,
            visited_files: HashSet::new(),
            source_provider,
        }
    }

    fn parse_module_file(
        &mut self,
        path: &Path,
        module_path: Vec<String>,
    ) -> Result<(), RustdocError> {
        let path = path.to_path_buf();
        if !self.visited_files.insert(path.clone()) {
            return Ok(());
        }
        let content = self.source_provider.read_file(&path)?;
        let file = syn::parse_file(&content)?;
        let current_dir = path.parent().unwrap_or_else(|| Path::new("."));
        self.parse_items(&file.items, &module_path, current_dir)?;
        Ok(())
    }

    fn parse_items(
        &mut self,
        items: &[syn::Item],
        module_path: &[String],
        current_dir: &Path,
    ) -> Result<(), RustdocError> {
        for item in items {
            match item {
                syn::Item::Fn(item_fn) => {
                    self.handle_fn(item_fn, module_path);
                }
                syn::Item::Impl(item_impl) => {
                    self.handle_impl(item_impl, module_path);
                }
                syn::Item::Trait(item_trait) => {
                    self.handle_trait(item_trait, module_path);
                }
                syn::Item::Mod(item_mod) => {
                    self.handle_mod(item_mod, module_path, current_dir)?;
                }
                _ => {}
            }
        }
        Ok(())
    }

    fn handle_mod(
        &mut self,
        item_mod: &syn::ItemMod,
        module_path: &[String],
        current_dir: &Path,
    ) -> Result<(), RustdocError> {
        let name = item_mod.ident.to_string();
        let mut next_path = module_path.to_vec();
        next_path.push(name.clone());

        if let Some((_, items)) = &item_mod.content {
            self.parse_items(items, &next_path, current_dir)?;
            return Ok(());
        }

        let module_file = resolve_module_file(current_dir, item_mod, self.source_provider);
        if let Some(module_file) = module_file {
            self.parse_module_file(&module_file, next_path)?;
        }
        Ok(())
    }

    fn handle_fn(&mut self, item_fn: &syn::ItemFn, module_path: &[String]) {
        let name = item_fn.sig.ident.to_string();
        let Some(caller_id) = self.resolve_free_fn_caller(module_path, &name) else {
            return;
        };
        let calls = collect_calls(&item_fn.block);
        self.add_call_edges(&caller_id, module_path, None, &calls);
    }

    fn handle_impl(&mut self, item_impl: &syn::ItemImpl, module_path: &[String]) {
        let type_segments = type_segments_from_syn_type(&item_impl.self_ty)
            .map(|segments| resolve_type_segments(&segments, module_path))
            .filter(|segments| !segments.segments.is_empty());

        for item in &item_impl.items {
            let syn::ImplItem::Fn(impl_fn) = item else {
                continue;
            };
            let name = impl_fn.sig.ident.to_string();
            let Some(caller_id) =
                self.resolve_method_caller(module_path, type_segments.as_ref(), &name)
            else {
                continue;
            };
            let calls = collect_calls(&impl_fn.block);
            self.add_call_edges(&caller_id, module_path, type_segments.as_ref(), &calls);
        }
    }

    fn handle_trait(&mut self, item_trait: &syn::ItemTrait, module_path: &[String]) {
        let trait_segments = vec![item_trait.ident.to_string()];
        let trait_segments = resolve_type_segments(&trait_segments, module_path);

        for item in &item_trait.items {
            let syn::TraitItem::Fn(trait_fn) = item else {
                continue;
            };
            let Some(block) = trait_fn.default.as_ref() else {
                continue;
            };
            let name = trait_fn.sig.ident.to_string();
            let Some(caller_id) =
                self.resolve_method_caller(module_path, Some(&trait_segments), &name)
            else {
                continue;
            };
            let calls = collect_calls(block);
            self.add_call_edges(&caller_id, module_path, Some(&trait_segments), &calls);
        }
    }

    fn add_call_edges(
        &mut self,
        caller_id: &str,
        module_path: &[String],
        self_type_segments: Option<&TypeSegments>,
        calls: &[CallExpr],
    ) {
        for call in calls {
            let candidates = match call {
                CallExpr::Path(segments) => {
                    self.resolve_callee_path_candidates(segments, module_path)
                }
                CallExpr::Method(name) => {
                    self.resolve_callee_method_candidates(name, module_path, self_type_segments)
                }
            };

            for (callee_id, confidence) in candidates {
                if caller_id == callee_id {
                    continue;
                }
                push_edge(
                    self.graph,
                    self.edge_cache,
                    caller_id.to_string(),
                    callee_id,
                    EdgeKind::CallsStatic,
                    confidence,
                );
            }
        }
    }

    fn resolve_free_fn_caller(&self, module_path: &[String], name: &str) -> Option<String> {
        let mut segments = module_path.to_vec();
        segments.push(name.to_string());
        self.function_index
            .resolve_callable_by_suffix(&segments)
            .or_else(|| self.function_index.resolve_callable_by_name_unique(name))
    }

    fn resolve_method_caller(
        &self,
        module_path: &[String],
        type_segments: Option<&TypeSegments>,
        name: &str,
    ) -> Option<String> {
        if let Some(type_segments) = type_segments {
            let mut suffix = type_segments.segments.clone();
            suffix.push(name.to_string());
            if let Some(id) = self.function_index.resolve_method_by_suffix(&suffix) {
                return Some(id);
            }
            if !type_segments.is_scoped {
                let mut scoped = module_path.to_vec();
                scoped.extend_from_slice(&type_segments.segments);
                scoped.push(name.to_string());
                if let Some(id) = self.function_index.resolve_method_by_suffix(&scoped) {
                    return Some(id);
                }
            }
        }

        self.function_index.resolve_method_by_name_unique(name)
    }

    fn resolve_callee_path_candidates(
        &self,
        segments: &[String],
        module_path: &[String],
    ) -> Vec<(String, Confidence)> {
        let (anchor, rest) = split_path_anchor(segments);
        let normalized = rest.to_vec();
        if normalized.is_empty() {
            return Vec::new();
        }

        let mut candidates = HashMap::new();
        let mut found = false;

        if matches!(anchor, PathAnchor::Relative) {
            let direct = self
                .function_index
                .resolve_callable_by_suffix_all(&normalized);
            found |= self.add_candidates(&mut candidates, direct);
        }

        let scoped = scoped_segments(anchor, rest, module_path);
        let scoped_matches = self.function_index.resolve_callable_by_suffix_all(&scoped);
        found |= self.add_candidates(&mut candidates, scoped_matches);

        if !found && normalized.len() == 1 && matches!(anchor, PathAnchor::Relative) {
            let by_name = self
                .function_index
                .resolve_callable_by_name_all(&normalized[0]);
            self.add_candidates(&mut candidates, by_name);
        }

        candidates.into_iter().collect()
    }

    fn resolve_callee_method_candidates(
        &self,
        name: &str,
        module_path: &[String],
        self_type_segments: Option<&TypeSegments>,
    ) -> Vec<(String, Confidence)> {
        let mut candidates = HashMap::new();
        let mut found = false;

        if let Some(type_segments) = self_type_segments {
            let mut suffix = type_segments.segments.clone();
            suffix.push(name.to_string());
            let direct = self.function_index.resolve_method_by_suffix_all(&suffix);
            found |= self.add_candidates(&mut candidates, direct);
            if !type_segments.is_scoped {
                let mut scoped = module_path.to_vec();
                scoped.extend_from_slice(&type_segments.segments);
                scoped.push(name.to_string());
                let scoped_matches = self.function_index.resolve_method_by_suffix_all(&scoped);
                found |= self.add_candidates(&mut candidates, scoped_matches);
            }
        }

        if !found {
            let by_name = self.function_index.resolve_method_by_name_all(name);
            self.add_candidates(&mut candidates, by_name);
        }

        candidates.into_iter().collect()
    }

    fn add_candidates(
        &self,
        candidates: &mut HashMap<String, Confidence>,
        matches: Vec<String>,
    ) -> bool {
        if matches.is_empty() {
            return false;
        }
        let confidence = if matches.len() == 1 {
            Confidence::Static
        } else {
            Confidence::Inferred
        };
        if matches.len() > 1 && !self.call_mode.allow_ambiguous() {
            return false;
        }
        for candidate in matches {
            let entry = candidates.entry(candidate).or_insert(confidence);
            *entry = merge_confidence(*entry, confidence);
        }
        true
    }
}

fn resolve_module_file(
    current_dir: &Path,
    item_mod: &syn::ItemMod,
    source_provider: &dyn SourceProvider,
) -> Option<PathBuf> {
    if let Some(path_override) = module_path_override(item_mod) {
        let full_path = if path_override.is_absolute() {
            path_override
        } else {
            current_dir.join(path_override)
        };
        if source_provider.file_exists(&full_path) {
            return Some(full_path);
        }
    }

    let name = item_mod.ident.to_string();
    let candidate = current_dir.join(format!("{name}.rs"));
    if source_provider.file_exists(&candidate) {
        return Some(candidate);
    }
    let mod_rs = current_dir.join(&name).join("mod.rs");
    if source_provider.file_exists(&mod_rs) {
        return Some(mod_rs);
    }
    None
}

fn module_path_override(item_mod: &syn::ItemMod) -> Option<PathBuf> {
    for attr in &item_mod.attrs {
        if !attr.path().is_ident("path") {
            continue;
        }
        let syn::Meta::NameValue(meta) = &attr.meta else {
            continue;
        };
        let syn::Expr::Lit(expr_lit) = &meta.value else {
            continue;
        };
        let syn::Lit::Str(lit_str) = &expr_lit.lit else {
            continue;
        };
        return Some(PathBuf::from(lit_str.value()));
    }
    None
}

fn type_segments_from_syn_type(ty: &syn::Type) -> Option<Vec<String>> {
    let syn::Type::Path(type_path) = ty else {
        return None;
    };
    Some(path_segments(&type_path.path))
}

fn path_segments(path: &syn::Path) -> Vec<String> {
    path.segments
        .iter()
        .map(|segment| segment.ident.to_string())
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PathAnchor {
    Relative,
    Crate,
    Self_,
    Super(usize),
}

#[derive(Debug, Clone)]
struct TypeSegments {
    segments: Vec<String>,
    is_scoped: bool,
}

fn split_path_anchor(segments: &[String]) -> (PathAnchor, &[String]) {
    let mut index = 0;
    let mut super_count = 0;
    let mut anchor = PathAnchor::Relative;
    while index < segments.len() {
        match segments[index].as_str() {
            "crate" => {
                anchor = PathAnchor::Crate;
                index += 1;
                break;
            }
            "self" | "Self" => {
                anchor = PathAnchor::Self_;
                index += 1;
                break;
            }
            "super" => {
                super_count += 1;
                anchor = PathAnchor::Super(super_count);
                index += 1;
            }
            _ => break,
        }
    }
    (anchor, &segments[index..])
}

fn scoped_segments(anchor: PathAnchor, rest: &[String], module_path: &[String]) -> Vec<String> {
    let base = match anchor {
        PathAnchor::Crate => Vec::new(),
        PathAnchor::Super(count) => {
            let base_len = module_path.len().saturating_sub(count);
            module_path[..base_len].to_vec()
        }
        PathAnchor::Self_ | PathAnchor::Relative => module_path.to_vec(),
    };
    let mut scoped = base;
    scoped.extend(rest.iter().cloned());
    scoped
}

fn resolve_type_segments(segments: &[String], module_path: &[String]) -> TypeSegments {
    let (anchor, rest) = split_path_anchor(segments);
    match anchor {
        PathAnchor::Crate => TypeSegments {
            segments: rest.to_vec(),
            is_scoped: true,
        },
        PathAnchor::Super(_) => TypeSegments {
            segments: scoped_segments(anchor, rest, module_path),
            is_scoped: true,
        },
        PathAnchor::Self_ | PathAnchor::Relative => TypeSegments {
            segments: rest.to_vec(),
            is_scoped: false,
        },
    }
}

#[derive(Debug, Clone)]
enum CallExpr {
    Path(Vec<String>),
    Method(String),
}

fn collect_calls(block: &syn::Block) -> Vec<CallExpr> {
    let mut collector = CallCollector { calls: Vec::new() };
    collector.visit_block(block);
    collector.calls
}

struct CallCollector {
    calls: Vec<CallExpr>,
}

impl<'ast> Visit<'ast> for CallCollector {
    fn visit_expr_call(&mut self, node: &'ast syn::ExprCall) {
        if let Some(path) = expr_to_path(&node.func) {
            let segments = path_segments(path);
            if !segments.is_empty() {
                self.calls.push(CallExpr::Path(segments));
            }
        }
        syn::visit::visit_expr_call(self, node);
    }

    fn visit_expr_method_call(&mut self, node: &'ast syn::ExprMethodCall) {
        self.calls.push(CallExpr::Method(node.method.to_string()));
        syn::visit::visit_expr_method_call(self, node);
    }
}

fn expr_to_path(expr: &syn::Expr) -> Option<&syn::Path> {
    match expr {
        syn::Expr::Path(expr_path) => Some(&expr_path.path),
        syn::Expr::Paren(expr_paren) => expr_to_path(&expr_paren.expr),
        syn::Expr::Group(expr_group) => expr_to_path(&expr_group.expr),
        syn::Expr::Reference(expr_ref) => expr_to_path(&expr_ref.expr),
        syn::Expr::Unary(expr_unary) => expr_to_path(&expr_unary.expr),
        syn::Expr::Cast(expr_cast) => expr_to_path(&expr_cast.expr),
        _ => None,
    }
}

fn merge_confidence(left: Confidence, right: Confidence) -> Confidence {
    match (left, right) {
        (Confidence::Runtime, _) | (_, Confidence::Runtime) => Confidence::Runtime,
        (Confidence::Static, _) | (_, Confidence::Static) => Confidence::Static,
        _ => Confidence::Inferred,
    }
}

fn push_edge(
    graph: &mut Graph,
    edge_cache: &mut HashSet<String>,
    from: String,
    to: String,
    kind: EdgeKind,
    confidence: Confidence,
) {
    push_edge_with_glob(graph, edge_cache, from, to, kind, confidence, false);
}

fn push_edge_with_glob(
    graph: &mut Graph,
    edge_cache: &mut HashSet<String>,
    from: String,
    to: String,
    kind: EdgeKind,
    confidence: Confidence,
    is_glob: bool,
) {
    let key = format!(
        "{from}|{to}|{kind:?}|{}",
        if is_glob { "glob" } else { "named" }
    );
    if edge_cache.insert(key) {
        graph.add_edge(Edge {
            from,
            to,
            kind,
            confidence,
            is_glob,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_other_attr_stability_stable() {
        let input = "#[attr = Stability {stability: Stability {level: Stable {since: Version(RustcVersion { major: 1, minor: 28, patch: 0 })}, feature: \"global_alloc\"}}]";
        assert_eq!(
            clean_other_attr(input),
            Some("#[stable(feature = \"global_alloc\", since = \"1.28.0\")]".to_string()),
        );
    }

    #[test]
    fn clean_other_attr_stability_unstable() {
        let input = "#[attr = Stability {stability: Stability {level: Unstable {reason: None, issue: 107540}, feature: \"btree_cursors\"}}]";
        assert_eq!(
            clean_other_attr(input),
            Some("#[unstable(feature = \"btree_cursors\", issue = \"107540\")]".to_string()),
        );
    }

    #[test]
    fn clean_other_attr_inline_hint() {
        assert_eq!(
            clean_other_attr("#[attr = Inline(Hint)]"),
            Some("#[inline]".to_string()),
        );
    }

    #[test]
    fn clean_other_attr_inline_always() {
        assert_eq!(
            clean_other_attr("#[attr = Inline(Always)]"),
            Some("#[inline(always)]".to_string()),
        );
    }

    #[test]
    fn clean_other_attr_internal_filtered() {
        assert_eq!(clean_other_attr("#[attr = CfgAttrTrace]"), None);
        assert_eq!(
            clean_other_attr("#[attr = CfgTrace([All([Not(NameValue { name: \"miri\" })])])]"),
            None,
        );
        assert_eq!(
            clean_other_attr("#[attr = AllowInternalUnstable([\"liballoc_internals\"])]"),
            None,
        );
    }

    #[test]
    fn clean_other_attr_passthrough_source_form() {
        // Already in user-source form — should round-trip unchanged.
        assert_eq!(
            clean_other_attr("#[allow(deprecated)]"),
            Some("#[allow(deprecated)]".to_string()),
        );
    }

    fn path_index(known: &[&str], modules: &[&str]) -> PathIndex {
        let module_paths: HashSet<String> = modules.iter().map(|id| (*id).to_string()).collect();
        PathIndex {
            known_paths: known.iter().map(|id| (*id).to_string()).collect(),
            module_paths: module_paths.clone(),
            node_kinds: known
                .iter()
                .map(|id| {
                    let id = (*id).to_string();
                    let kind = if module_paths.contains(&id) {
                        NodeKind::Module
                    } else {
                        NodeKind::Trait
                    };
                    (id, kind)
                })
                .collect(),
            node_ids_by_rustdoc_id: HashMap::new(),
        }
    }

    fn test_node(id: &str, kind: NodeKind) -> Node {
        Node {
            id: id.to_string(),
            name: id.rsplit("::").next().unwrap_or(id).to_string(),
            kind,
            visibility: Visibility::Public,
            line_count: None,
            span: None,
            attrs: Vec::new(),
            is_external: false,
            is_deprecated: false,
            is_unsafe: false,
            is_auto: false,
            is_mutable: false,
            is_stripped: false,
            has_stripped_fields: false,
            has_stripped_variants: false,
            is_dyn_compatible: None,
            deprecation: None,
            fields: None,
            variants: None,
            signature: None,
            generics: CvGenerics::default(),
            docs: None,
            doc_links: HashMap::new(),
            impl_type: None,
            parent_impl: None,
            impl_trait: None,
            impl_category: None,
            provided_trait_methods: None,
            required_trait_methods: None,
            default_trait_methods: None,
            type_: None,
            variant_kind: None,
            discriminant: None,
            const_value: None,
            bounds: Vec::new(),
            import_source: None,
            import_name: None,
            is_glob: false,
            extern_crate_name: None,
            extern_crate_rename: None,
            macro_source: None,
            proc_macro_kind: None,
            proc_macro_helpers: Vec::new(),
        }
    }

    fn minimal_crate(
        paths: impl IntoIterator<Item = (rdt::Id, Vec<&'static str>, rdt::ItemKind)>,
    ) -> rdt::Crate {
        rdt::Crate {
            root: rdt::Id(0),
            crate_version: None,
            includes_private: false,
            index: HashMap::new(),
            paths: paths
                .into_iter()
                .map(|(id, path, kind)| {
                    (
                        id,
                        rdt::ItemSummary {
                            crate_id: 0,
                            path: path.into_iter().map(str::to_string).collect(),
                            kind,
                        },
                    )
                })
                .collect(),
            external_crates: HashMap::new(),
            target: rdt::Target {
                triple: String::new(),
                target_features: Vec::new(),
            },
            format_version: rdt::FORMAT_VERSION,
        }
    }

    #[test]
    fn non_module_path_prefix_is_not_created_as_module() {
        let mut graph = Graph::new();
        let mut node_cache = HashSet::from(["fixture".to_string()]);
        let mut edge_cache = HashSet::new();
        let mut placeholder_modules = HashSet::new();
        let path_index = path_index(
            &["fixture", "fixture::Trait", "fixture::Trait::method"],
            &["fixture"],
        );
        let path = ["fixture", "Trait", "method"].map(str::to_string);

        ensure_module_nodes(
            &mut graph,
            &mut node_cache,
            &mut edge_cache,
            &mut placeholder_modules,
            "fixture",
            &path,
            &path_index,
            false,
        );

        assert!(!node_cache.contains("fixture::Trait"));
        assert!(!placeholder_modules.contains("fixture::Trait"));
        assert!(graph.nodes.is_empty());
        assert_eq!(
            structural_edge_kind("fixture::Trait", "fixture", &path_index),
            EdgeKind::Defines
        );
    }

    #[test]
    fn placeholder_module_is_replaced_by_real_module_node() {
        let mut graph = Graph::new();
        let mut node_cache = HashSet::from(["fixture".to_string()]);
        let mut edge_cache = HashSet::new();
        let mut placeholder_modules = HashSet::new();
        let path_index = path_index(
            &["fixture", "fixture::module", "fixture::module::Item"],
            &["fixture", "fixture::module"],
        );
        let path = ["fixture", "module", "Item"].map(str::to_string);

        ensure_module_nodes(
            &mut graph,
            &mut node_cache,
            &mut edge_cache,
            &mut placeholder_modules,
            "fixture",
            &path,
            &path_index,
            false,
        );
        assert!(placeholder_modules.contains("fixture::module"));

        let mut real = test_node("fixture::module", NodeKind::Module);
        real.docs = Some("real docs".to_string());
        upsert_node(&mut graph, &mut node_cache, &mut placeholder_modules, real);

        let modules: Vec<_> = graph
            .nodes
            .iter()
            .filter(|node| node.id == "fixture::module")
            .collect();
        assert_eq!(modules.len(), 1);
        assert_eq!(modules[0].docs.as_deref(), Some("real docs"));
        assert!(!placeholder_modules.contains("fixture::module"));
    }

    #[test]
    fn namespace_collision_keeps_module_branch_and_disambiguates_value_item() {
        let krate = minimal_crate([
            (rdt::Id(1), vec!["fixture", "parse"], rdt::ItemKind::Module),
            (
                rdt::Id(2),
                vec!["fixture", "parse"],
                rdt::ItemKind::Function,
            ),
            (
                rdt::Id(3),
                vec!["fixture", "parse", "Parser"],
                rdt::ItemKind::Trait,
            ),
        ]);

        let graph = build_graph(
            &krate,
            "fixture",
            BuildGraphOptions {
                workspace_members: Some(HashSet::from(["fixture".to_string()])),
                source: None,
                call_mode: CallMode::Strict,
                skip_external_nodes: false,
                rustdoc_name: None,
            },
        )
        .expect("fixture graph builds");

        assert!(
            graph
                .nodes
                .iter()
                .any(|node| node.id == "fixture::parse" && node.kind == NodeKind::Module)
        );
        assert!(graph.nodes.iter().any(|node| {
            node.id.starts_with("fixture::parse~fn-")
                && node.name == "parse"
                && node.kind == NodeKind::Function
        }));
        assert!(graph.edges.iter().any(|edge| {
            edge.from == "fixture::parse"
                && edge.to == "fixture::parse::Parser"
                && edge.kind == EdgeKind::Contains
        }));
        assert!(graph.edges.iter().any(|edge| {
            edge.from == "fixture"
                && edge.to.starts_with("fixture::parse~fn-")
                && edge.kind == EdgeKind::Contains
        }));
    }

    #[test]
    fn generic_arg_constraints_are_formatted_and_linked() {
        let output_path = rdt::Path {
            path: "fixture::Output".to_string(),
            id: rdt::Id(2),
            args: None,
        };
        let args = rdt::GenericArgs::AngleBracketed {
            args: Vec::new(),
            constraints: vec![rdt::AssocItemConstraint {
                name: "Item".to_string(),
                args: None,
                binding: rdt::AssocItemConstraintKind::Equality(rdt::Term::Type(
                    rdt::Type::ResolvedPath(output_path),
                )),
            }],
        };
        let krate = minimal_crate([(rdt::Id(2), vec!["fixture", "Output"], rdt::ItemKind::Struct)]);
        let path_index = build_path_index(&krate, "fixture");
        let mut links = HashMap::new();

        collect_generic_args_links(&args, &krate, "fixture", &path_index, &mut links);

        assert_eq!(format_generic_args(&args), "<Item = Output>");
        assert_eq!(
            links.get("Output").map(String::as_str),
            Some("fixture::Output")
        );
    }

    #[test]
    fn missing_external_edge_targets_are_materialized_as_stubs() {
        let mut graph = Graph::new();
        graph.add_node(test_node("fixture::Type", NodeKind::Struct));
        graph.add_edge(Edge {
            from: "fixture::Type".to_string(),
            to: "core::clone::Clone".to_string(),
            kind: EdgeKind::Implements,
            confidence: Confidence::Static,
            is_glob: false,
        });
        graph.add_edge(Edge {
            from: "fixture::missing_generated".to_string(),
            to: "fixture::Type".to_string(),
            kind: EdgeKind::UsesType,
            confidence: Confidence::Static,
            is_glob: false,
        });
        let mut node_cache = HashSet::from(["fixture::Type".to_string()]);
        let mut path_index = path_index(&["core::clone::Clone"], &[]);
        path_index
            .node_kinds
            .insert("core::clone::Clone".to_string(), NodeKind::Trait);
        let workspace_members = HashSet::from(["fixture".to_string()]);

        materialize_missing_external_edge_nodes(
            &mut graph,
            &mut node_cache,
            &workspace_members,
            &path_index,
        );
        prune_dangling_edges(&mut graph, &node_cache);

        let external = graph
            .nodes
            .iter()
            .find(|node| node.id == "core::clone::Clone")
            .expect("external stub should be created");
        assert_eq!(external.kind, NodeKind::Trait);
        assert!(external.is_external);
        assert!(graph.nodes.iter().any(|node| node.id == "core"));
        assert_eq!(graph.edges.len(), 1);
        assert_eq!(graph.edges[0].to, "core::clone::Clone");
    }
}
