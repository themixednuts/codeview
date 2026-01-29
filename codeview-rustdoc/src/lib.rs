use std::collections::{HashMap, HashSet};
#[cfg(feature = "native")]
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(feature = "native")]
use std::process::Command;

#[cfg(feature = "native")]
use cargo_metadata::{MetadataCommand, TargetKind};
use codeview_core::{
    ArgumentInfo, Confidence, CrateGraph, Edge, EdgeKind, ExternalCrate, FieldInfo,
    FunctionSignature, Graph, ImplType, Node, NodeKind, Span, VariantInfo, Visibility, Workspace,
};
use rustdoc_types as rdt;
use syn::visit::Visit;
use thiserror::Error;

#[cfg(feature = "wasm")]
mod wasm;

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
    #[error("missing crate root source file")]
    MissingCrateRoot,
}

#[cfg(feature = "native")]
#[derive(Debug, Clone)]
pub struct RustdocJson {
    pub crate_name: String,
    pub json_path: PathBuf,
    pub manifest_path: PathBuf,
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
    let crate_file = format!("{crate_name}.json");
    let json_path = target_dir.join("doc").join(crate_file);

    Ok(RustdocJson {
        crate_name,
        json_path,
        manifest_path: manifest_path.to_path_buf(),
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
        let has_lib = package.targets.iter().any(|t| {
            t.kind
                .iter()
                .any(|k| matches!(k, TargetKind::Lib | TargetKind::ProcMacro))
        });
        let first_bin = package
            .targets
            .iter()
            .find(|t| t.kind.iter().any(|k| matches!(k, TargetKind::Bin)))
            .map(|t| t.name.clone());

        let mut cmd = Command::new("cargo");
        cmd.arg("+nightly")
            .arg("rustdoc")
            .arg("--manifest-path")
            .arg(pkg_manifest);

        if has_lib {
            cmd.arg("--lib");
        } else if let Some(bin_name) = &first_bin {
            cmd.arg("--bin").arg(bin_name);
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

        let crate_file = format!("{}.json", crate_name.replace('-', "_"));
        let json_path = target_dir.join("doc").join(crate_file);

        if json_path.exists() {
            results.push(RustdocJson {
                crate_name,
                json_path,
                manifest_path: pkg_manifest.to_path_buf(),
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
    let mut crate_versions = HashMap::new();
    let workspace_members: HashSet<String> =
        if let Ok(metadata) = MetadataCommand::new().manifest_path(manifest_path).exec() {
            for package in metadata.workspace_packages() {
                let crate_name = package.name.replace('-', "_");
                crate_versions.insert(crate_name.clone(), package.version.to_string());
            }
            crate_versions.keys().cloned().collect()
        } else {
            HashSet::new()
        };

    for rustdoc in rustdoc_jsons {
        let graph = load_graph_from_path_with_sources(
            &rustdoc.json_path,
            &rustdoc.crate_name,
            manifest_path,
            &rustdoc.manifest_path,
            call_mode,
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
        let version = crate_versions
            .get(member)
            .cloned()
            .unwrap_or_else(|| "0.0.0".to_string());
        crate_graphs.push(CrateGraph {
            id: member.clone(),
            name: member.clone(),
            version,
            nodes,
            edges,
        });
    }
    crate_graphs.sort_by(|a, b| a.id.cmp(&b.id));

    // Build external crate stubs from remaining nodes
    let mut external_crates = Vec::new();
    let mut remaining_crate_names: Vec<String> = crate_nodes.keys().cloned().collect();
    remaining_crate_names.sort();
    for ext_name in remaining_crate_names {
        let nodes = crate_nodes.remove(&ext_name).unwrap_or_default();
        // Also include any intra-crate edges for external crates
        let _edges = crate_edges.remove(&ext_name).unwrap_or_default();
        external_crates.push(ExternalCrate {
            id: ext_name.clone(),
            name: ext_name,
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
    if node.generics.is_some() {
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
    crate_manifest_path: &Path,
    call_mode: CallMode,
) -> Result<Graph, RustdocError> {
    let content = fs::read_to_string(path)?;
    extract_graph_with_sources(
        &content,
        crate_name,
        workspace_manifest_path,
        crate_manifest_path,
        call_mode,
    )
}

pub fn extract_graph(json: &str, crate_name: &str) -> Result<Graph, RustdocError> {
    let krate: rdt::Crate = serde_json::from_str(json)?;
    build_graph(&krate, crate_name, BuildGraphOptions {
        workspace_members: None,
        source: None,
        call_mode: CallMode::Strict,
    })
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
    let krate: rdt::Crate = serde_json::from_str(json)?;
    let provider = MemorySourceProvider::new(source_files);
    build_graph(&krate, crate_name, BuildGraphOptions {
        workspace_members: None,
        source: Some((Path::new(root_file), &provider)),
        call_mode,
    })
}

#[cfg(feature = "native")]
pub fn extract_graph_with_sources(
    json: &str,
    crate_name: &str,
    workspace_manifest_path: &Path,
    crate_manifest_path: &Path,
    call_mode: CallMode,
) -> Result<Graph, RustdocError> {
    let krate: rdt::Crate = serde_json::from_str(json)?;
    let workspace_members = get_workspace_members(workspace_manifest_path)?;
    let root_file = crate_root_source(crate_manifest_path)?;
    build_graph(&krate, crate_name, BuildGraphOptions {
        workspace_members: Some(workspace_members),
        source: Some((&root_file, &FsSourceProvider)),
        call_mode,
    })
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
}

fn build_graph(
    krate: &rdt::Crate,
    crate_name: &str,
    opts: BuildGraphOptions<'_>,
) -> Result<Graph, RustdocError> {
    let mut graph = Graph::new();
    let mut node_cache = HashSet::new();
    let mut edge_cache = HashSet::new();
    let method_ids = collect_method_ids(krate);
    let function_index = build_function_index(krate, &method_ids, crate_name);
    let trait_lookup = build_trait_lookup(krate, crate_name);

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
            &item_crate_name,
            &summary.path,
            is_external,
        );

        let node_id = join_path(&item_crate_name, &summary.path);
        if !node_cache.contains(&node_id) {
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

            let (fields, variants, signature, generics, where_clause, docs) = item
                .map(|item| extract_item_details(&krate.index, item))
                .unwrap_or_default();

            let doc_links = item
                .map(|item| extract_doc_links(item, krate, crate_name))
                .unwrap_or_default();

            let mut bound_links = item
                .and_then(|item| item_generics(item))
                .map(|g| extract_bound_links(g, krate, crate_name))
                .unwrap_or_default();

            // Add type links from signatures
            if let Some(item) = item {
                match &item.inner {
                    rdt::ItemEnum::Function(f) => {
                        bound_links.extend(extract_signature_links(&f.sig, krate, crate_name));
                    }
                    rdt::ItemEnum::Struct(s) => {
                        let field_ids: Vec<_> = match &s.kind {
                            rdt::StructKind::Plain { fields, .. } => fields.clone(),
                            rdt::StructKind::Tuple(fields) => fields.iter().filter_map(|f| *f).collect(),
                            rdt::StructKind::Unit => vec![],
                        };
                        bound_links.extend(extract_field_type_links(&krate.index, &field_ids, krate, crate_name));
                    }
                    rdt::ItemEnum::Enum(e) => {
                        for variant_id in &e.variants {
                            if let Some(variant_item) = krate.index.get(variant_id) {
                                if let rdt::ItemEnum::Variant(v) = &variant_item.inner {
                                    let field_ids: Vec<_> = match &v.kind {
                                        rdt::VariantKind::Plain => vec![],
                                        rdt::VariantKind::Tuple(fields) => fields.iter().filter_map(|f| *f).collect(),
                                        rdt::VariantKind::Struct { fields, .. } => fields.clone(),
                                    };
                                    bound_links.extend(extract_field_type_links(&krate.index, &field_ids, krate, crate_name));
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }

            graph.add_node(Node {
                id: node_id.clone(),
                name,
                kind: node_kind,
                visibility,
                span,
                attrs,
                is_external,
                fields,
                variants,
                signature,
                generics,
                where_clause,
                docs,
                doc_links,
                bound_links,
                impl_type: None,
                parent_impl: None,
                impl_trait: None,
            });
            node_cache.insert(node_id.clone());
        }

        if let Some(parent_id) = parent_path_id(&item_crate_name, &summary.path) {
            // Skip self-loops (can happen when path is just the crate name)
            if parent_id != node_id {
                push_edge(
                    &mut graph,
                    &mut edge_cache,
                    parent_id,
                    node_id,
                    EdgeKind::Contains,
                    Confidence::Static,
                );
            }
        }
    }

    // Build item_to_parent map from module children (used for re-exports and impl parenting)
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

    add_use_import_edges_with_parent_map(
        &mut graph,
        &mut edge_cache,
        krate,
        crate_name,
        &item_to_parent,
    );

    for item in krate.index.values() {
        let owner_id = match &item.inner {
            rdt::ItemEnum::Impl(impl_block) => {
                let item_crate_name = crate_name_for_id(krate, item.crate_id, crate_name);
                let is_external = !workspace_members.contains(&item_crate_name);
                ensure_crate_node(
                    &mut graph,
                    &mut node_cache,
                    &item_crate_name,
                    Visibility::Public,
                    is_external,
                );
                let impl_id = impl_node_id(&item_crate_name, item.id);
                // Resolve the trait ID for trait impls
                let impl_trait_id = impl_block
                    .trait_
                    .as_ref()
                    .and_then(|trait_path| resolve_id(krate, crate_name, trait_path.id));

                if !node_cache.contains(&impl_id) {
                    let name = impl_node_name(krate, crate_name, impl_block);
                    let impl_type = if impl_block.trait_.is_some() {
                        Some(ImplType::Trait)
                    } else {
                        Some(ImplType::Inherent)
                    };
                    graph.add_node(Node {
                        id: impl_id.clone(),
                        name,
                        kind: NodeKind::Impl,
                        visibility: map_visibility(&item.visibility),
                        span: item.span.as_ref().map(map_span),
                        attrs: format_attributes(&item.attrs),
                        is_external,
                        fields: None,
                        variants: None,
                        signature: None,
                        generics: extract_generics(&impl_block.generics),
                        where_clause: extract_where_clause(&impl_block.generics),
                        docs: extract_docs(item),
                        doc_links: extract_doc_links(item, krate, crate_name),
                        bound_links: extract_bound_links(&impl_block.generics, krate, crate_name),
                        impl_type,
                        parent_impl: None,
                        impl_trait: impl_trait_id.clone(),
                    });
                    node_cache.insert(impl_id.clone());
                }

                // Add Contains edge from parent module to impl node
                if let Some(parent_id) = item_to_parent.get(&item.id)
                    && let Some(parent_node_id) = resolve_id(krate, crate_name, *parent_id)
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
                    && let Some(type_node_id) = resolve_id(krate, crate_name, for_id)
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
                        && let Some(trait_node_id) = resolve_id(krate, crate_name, trait_path.id)
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

                    let kind = match &assoc_item.inner {
                        rdt::ItemEnum::Function(_) => NodeKind::Method,
                        rdt::ItemEnum::Constant { .. } => continue,
                        rdt::ItemEnum::TypeAlias(_) => NodeKind::TypeAlias,
                        _ => continue,
                    };

                    // Create a per-impl node so each impl block owns its own child.
                    // This avoids shared children when the same rustdoc ID appears
                    // in multiple impl blocks (e.g. blanket impls like `impl<T> Any for T`).
                    let assoc_node_id = format!("{}::method-{}", impl_id, assoc_id.0);
                    if !node_cache.contains(&assoc_node_id) {
                        let name = assoc_item
                            .name
                            .clone()
                            .unwrap_or_else(|| assoc_node_id.clone());
                        let (fields, variants, signature, generics, where_clause, docs) =
                            extract_item_details(&krate.index, assoc_item);
                        let mut bound_links = item_generics(assoc_item)
                            .map(|g| extract_bound_links(g, krate, crate_name))
                            .unwrap_or_default();
                        // Add type links from method signature
                        if let rdt::ItemEnum::Function(f) = &assoc_item.inner {
                            bound_links.extend(extract_signature_links(&f.sig, krate, crate_name));
                        }
                        graph.add_node(Node {
                            id: assoc_node_id.clone(),
                            name,
                            kind,
                            visibility: map_visibility(&assoc_item.visibility),
                            span: assoc_item.span.as_ref().map(map_span),
                            attrs: format_attributes(&assoc_item.attrs),
                            is_external,
                            fields,
                            variants,
                            signature,
                            generics,
                            where_clause,
                            docs,
                            doc_links: extract_doc_links(assoc_item, krate, crate_name),
                            bound_links,
                            impl_type: None,
                            parent_impl: Some(impl_id.clone()),
                            impl_trait: None,
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
            _ => match resolve_id(krate, crate_name, item.id) {
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
                    if let Some(assoc_node_id) = resolve_id(krate, crate_name, *assoc_id) {
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

fn build_trait_lookup(
    krate: &rdt::Crate,
    default_crate_name: &str,
) -> HashMap<String, Vec<String>> {
    let mut lookup = HashMap::new();
    for summary in krate.paths.values() {
        if summary.kind != rdt::ItemKind::Trait {
            continue;
        }
        let crate_name = crate_name_for_id(krate, summary.crate_id, default_crate_name);
        let full_path = join_path(&crate_name, &summary.path);
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
        rdt::ItemKind::Struct => Some(NodeKind::Struct),
        rdt::ItemKind::Union => Some(NodeKind::Union),
        rdt::ItemKind::Enum => Some(NodeKind::Enum),
        rdt::ItemKind::Trait => Some(NodeKind::Trait),
        rdt::ItemKind::TraitAlias => Some(NodeKind::TraitAlias),
        rdt::ItemKind::Impl => Some(NodeKind::Impl),
        rdt::ItemKind::Function => Some(if is_method {
            NodeKind::Method
        } else {
            NodeKind::Function
        }),
        rdt::ItemKind::TypeAlias => Some(NodeKind::TypeAlias),
        _ => None,
    }
}

fn map_visibility(visibility: &rdt::Visibility) -> Visibility {
    match visibility {
        rdt::Visibility::Public => Visibility::Public,
        rdt::Visibility::Crate => Visibility::Crate,
        rdt::Visibility::Restricted { .. } => Visibility::Restricted,
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

/// Strip `$crate::` prefixes that leak from rustdoc macro expansions.
/// `$crate::clone::Clone` → `Clone`, `$crate::fmt::Debug` → `Debug`.
fn clean_path(path: &str) -> String {
    // For display, use just the final type name segment.
    // e.g. "crate::config::Config" → "Config",
    //      "$crate::clone::Clone" → "Clone",
    //      "std::path::Path" → "Path"
    path.rsplit("::").next().unwrap_or(path).to_string()
}

fn format_type(ty: &rdt::Type) -> String {
    match ty {
        rdt::Type::ResolvedPath(path) => {
            let mut result = clean_path(&path.path);
            if let Some(args) = &path.args {
                result.push_str(&format_generic_args(args));
            }
            result
        }
        rdt::Type::DynTrait(dyn_trait) => {
            let traits: Vec<_> = dyn_trait
                .traits
                .iter()
                .map(|p| clean_path(&p.trait_.path))
                .collect();
            format!("dyn {}", traits.join(" + "))
        }
        rdt::Type::Generic(name) => name.clone(),
        rdt::Type::Primitive(name) => name.clone(),
        rdt::Type::FunctionPointer(fp) => {
            let inputs: Vec<_> = fp.sig.inputs.iter().map(|(_, t)| format_type(t)).collect();
            let output = fp
                .sig
                .output
                .as_ref()
                .map(|t| format!(" -> {}", format_type(t)))
                .unwrap_or_default();
            format!("fn({}){}", inputs.join(", "), output)
        }
        rdt::Type::Tuple(types) => {
            let inner: Vec<_> = types.iter().map(format_type).collect();
            format!("({})", inner.join(", "))
        }
        rdt::Type::Slice(inner) => format!("[{}]", format_type(inner)),
        rdt::Type::Array { type_, len } => format!("[{}; {}]", format_type(type_), len),
        rdt::Type::Pat { type_, .. } => format_type(type_),
        rdt::Type::ImplTrait(bounds) => {
            let bound_strs: Vec<_> = bounds
                .iter()
                .filter_map(|b| match b {
                    rdt::GenericBound::TraitBound { trait_, .. } => Some(clean_path(&trait_.path)),
                    _ => None,
                })
                .collect();
            format!("impl {}", bound_strs.join(" + "))
        }
        rdt::Type::Infer => "_".to_string(),
        rdt::Type::RawPointer { is_mutable, type_ } => {
            let mutability = if *is_mutable { "mut" } else { "const" };
            format!("*{} {}", mutability, format_type(type_))
        }
        rdt::Type::BorrowedRef {
            is_mutable, type_, ..
        } => {
            let mutability = if *is_mutable { "mut " } else { "" };
            format!("&{}{}", mutability, format_type(type_))
        }
        rdt::Type::QualifiedPath {
            self_type, name, ..
        } => {
            format!("<{}>::{}", format_type(self_type), name)
        }
    }
}

fn format_generic_args(args: &rdt::GenericArgs) -> String {
    match args {
        rdt::GenericArgs::AngleBracketed { args, .. } => {
            if args.is_empty() {
                String::new()
            } else {
                let arg_strs: Vec<_> = args
                    .iter()
                    .map(|a| match a {
                        rdt::GenericArg::Type(t) => format_type(t),
                        rdt::GenericArg::Lifetime(l) => l.clone(),
                        rdt::GenericArg::Const(c) => c.value.clone().unwrap_or_default(),
                        rdt::GenericArg::Infer => "_".to_string(),
                    })
                    .collect();
                format!("<{}>", arg_strs.join(", "))
            }
        }
        rdt::GenericArgs::Parenthesized { inputs, output } => {
            let input_strs: Vec<_> = inputs.iter().map(format_type).collect();
            let output_str = output
                .as_ref()
                .map(|t| format!(" -> {}", format_type(t)))
                .unwrap_or_default();
            format!("({}){}", input_strs.join(", "), output_str)
        }
        rdt::GenericArgs::ReturnTypeNotation => "(..)".to_string(),
    }
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
                        type_name: format_type(ty),
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
                        type_name: format_type(ty),
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
                            type_name: format_type(ty),
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
                            type_name: format_type(ty),
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

fn extract_function_signature(
    sig: &rdt::FunctionSignature,
    header: &rdt::FunctionHeader,
) -> FunctionSignature {
    FunctionSignature {
        inputs: sig
            .inputs
            .iter()
            .map(|(name, ty)| ArgumentInfo {
                name: name.clone(),
                type_name: format_type(ty),
            })
            .collect(),
        output: sig.output.as_ref().map(format_type),
        is_async: header.is_async,
        is_unsafe: header.is_unsafe,
        is_const: header.is_const,
    }
}

/// Get the generics from an item's inner data, if any.
fn item_generics(item: &rdt::Item) -> Option<&rdt::Generics> {
    match &item.inner {
        rdt::ItemEnum::Struct(s) => Some(&s.generics),
        rdt::ItemEnum::Union(u) => Some(&u.generics),
        rdt::ItemEnum::Enum(e) => Some(&e.generics),
        rdt::ItemEnum::Function(f) => Some(&f.generics),
        rdt::ItemEnum::Trait(t) => Some(&t.generics),
        rdt::ItemEnum::TraitAlias(a) => Some(&a.generics),
        rdt::ItemEnum::TypeAlias(a) => Some(&a.generics),
        _ => None,
    }
}

/// Collect resolved type links from a Type tree.
/// Maps cleaned display name → resolved node ID for every ResolvedPath encountered.
fn collect_type_links(
    ty: &rdt::Type,
    krate: &rdt::Crate,
    crate_name: &str,
    links: &mut HashMap<String, String>,
) {
    match ty {
        rdt::Type::ResolvedPath(path) => {
            let display = clean_path(&path.path);
            if let Some(node_id) = resolve_id(krate, crate_name, path.id) {
                links.insert(display, node_id);
            }
            if let Some(args) = &path.args {
                collect_generic_args_links(args, krate, crate_name, links);
            }
        }
        rdt::Type::DynTrait(dyn_trait) => {
            for poly in &dyn_trait.traits {
                let display = clean_path(&poly.trait_.path);
                if let Some(node_id) = resolve_id(krate, crate_name, poly.trait_.id) {
                    links.insert(display, node_id);
                }
                if let Some(args) = &poly.trait_.args {
                    collect_generic_args_links(args, krate, crate_name, links);
                }
            }
        }
        rdt::Type::BorrowedRef { type_, .. }
        | rdt::Type::RawPointer { type_, .. }
        | rdt::Type::Slice(type_)
        | rdt::Type::Array { type_, .. }
        | rdt::Type::Pat { type_, .. } => {
            collect_type_links(type_, krate, crate_name, links);
        }
        rdt::Type::Tuple(types) => {
            for t in types {
                collect_type_links(t, krate, crate_name, links);
            }
        }
        rdt::Type::FunctionPointer(fp) => {
            for (_, t) in &fp.sig.inputs {
                collect_type_links(t, krate, crate_name, links);
            }
            if let Some(out) = &fp.sig.output {
                collect_type_links(out, krate, crate_name, links);
            }
        }
        rdt::Type::ImplTrait(bounds) => {
            for bound in bounds {
                if let rdt::GenericBound::TraitBound { trait_, .. } = bound {
                    let display = clean_path(&trait_.path);
                    if let Some(node_id) = resolve_id(krate, crate_name, trait_.id) {
                        links.insert(display, node_id);
                    }
                }
            }
        }
        rdt::Type::QualifiedPath { self_type, .. } => {
            collect_type_links(self_type, krate, crate_name, links);
        }
        _ => {}
    }
}

fn collect_generic_args_links(
    args: &rdt::GenericArgs,
    krate: &rdt::Crate,
    crate_name: &str,
    links: &mut HashMap<String, String>,
) {
    match args {
        rdt::GenericArgs::AngleBracketed { args, .. } => {
            for arg in args {
                if let rdt::GenericArg::Type(t) = arg {
                    collect_type_links(t, krate, crate_name, links);
                }
            }
        }
        rdt::GenericArgs::Parenthesized { inputs, output } => {
            for input in inputs {
                collect_type_links(input, krate, crate_name, links);
            }
            if let Some(out) = output {
                collect_type_links(out, krate, crate_name, links);
            }
        }
        rdt::GenericArgs::ReturnTypeNotation => {}
    }
}

/// Extract type links from a function signature (inputs + output).
fn extract_signature_links(
    sig: &rdt::FunctionSignature,
    krate: &rdt::Crate,
    crate_name: &str,
) -> HashMap<String, String> {
    let mut links = HashMap::new();
    for (_, ty) in &sig.inputs {
        collect_type_links(ty, krate, crate_name, &mut links);
    }
    if let Some(output) = &sig.output {
        collect_type_links(output, krate, crate_name, &mut links);
    }
    links
}

/// Extract type links from struct/enum fields.
fn extract_field_type_links(
    index: &HashMap<rdt::Id, rdt::Item>,
    field_ids: &[rdt::Id],
    krate: &rdt::Crate,
    crate_name: &str,
) -> HashMap<String, String> {
    let mut links = HashMap::new();
    for field_id in field_ids {
        if let Some(item) = index.get(field_id) {
            if let rdt::ItemEnum::StructField(ty) = &item.inner {
                collect_type_links(ty, krate, crate_name, &mut links);
            }
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
) -> HashMap<String, String> {
    let mut links = HashMap::new();
    for bound in bounds {
        if let rdt::GenericBound::TraitBound { trait_, .. } = bound {
            let display = clean_path(&trait_.path);
            if let Some(node_id) = resolve_id(krate, crate_name, trait_.id) {
                links.insert(display, node_id);
            }
        }
    }
    links
}

fn extract_generics(generics: &rdt::Generics) -> Option<Vec<String>> {
    let params: Vec<_> = generics
        .params
        .iter()
        .map(|p| match &p.kind {
            rdt::GenericParamDefKind::Type {
                bounds, default, ..
            } => {
                let mut s = p.name.clone();
                if !bounds.is_empty() {
                    let bound_strs: Vec<_> = bounds
                        .iter()
                        .filter_map(|b| match b {
                            rdt::GenericBound::TraitBound { trait_, .. } => {
                                Some(clean_path(&trait_.path))
                            }
                            rdt::GenericBound::Outlives(lt) => Some(lt.clone()),
                            _ => None,
                        })
                        .collect();
                    if !bound_strs.is_empty() {
                        s.push_str(": ");
                        s.push_str(&bound_strs.join(" + "));
                    }
                }
                if let Some(default) = default {
                    s.push_str(" = ");
                    s.push_str(&format_type(default));
                }
                s
            }
            rdt::GenericParamDefKind::Lifetime { .. } => p.name.clone(),
            rdt::GenericParamDefKind::Const { type_, .. } => {
                format!("const {}: {}", p.name, format_type(type_))
            }
        })
        .collect();
    if params.is_empty() {
        None
    } else {
        Some(params)
    }
}

/// Extract bound_links for all trait bounds in both generics params and where clauses.
fn extract_bound_links(
    generics: &rdt::Generics,
    krate: &rdt::Crate,
    crate_name: &str,
) -> HashMap<String, String> {
    let mut links = HashMap::new();
    // From generic params
    for param in &generics.params {
        if let rdt::GenericParamDefKind::Type { bounds, .. } = &param.kind {
            links.extend(collect_bound_links(bounds, krate, crate_name));
        }
    }
    // From where predicates
    for pred in &generics.where_predicates {
        if let rdt::WherePredicate::BoundPredicate { bounds, .. } = pred {
            links.extend(collect_bound_links(bounds, krate, crate_name));
        }
    }
    links
}

fn extract_where_clause(generics: &rdt::Generics) -> Option<Vec<String>> {
    let predicates: Vec<_> = generics
        .where_predicates
        .iter()
        .filter_map(|pred| match pred {
            rdt::WherePredicate::BoundPredicate { type_, bounds, .. } => {
                let ty = format_type(type_);
                let bound_strs: Vec<_> = bounds
                    .iter()
                    .filter_map(|b| match b {
                        rdt::GenericBound::TraitBound { trait_, .. } => {
                            Some(clean_path(&trait_.path))
                        }
                        rdt::GenericBound::Outlives(lt) => Some(lt.clone()),
                        _ => None,
                    })
                    .collect();
                if bound_strs.is_empty() {
                    None
                } else {
                    Some(format!("{}: {}", ty, bound_strs.join(" + ")))
                }
            }
            rdt::WherePredicate::LifetimePredicate { lifetime, outlives } => {
                if outlives.is_empty() {
                    None
                } else {
                    Some(format!("{}: {}", lifetime, outlives.join(" + ")))
                }
            }
            rdt::WherePredicate::EqPredicate { lhs, rhs } => {
                let rhs_str = match rhs {
                    rdt::Term::Type(ty) => format_type(ty),
                    rdt::Term::Constant(c) => c.value.clone().unwrap_or_default(),
                };
                Some(format!("{} = {}", format_type(lhs), rhs_str))
            }
        })
        .collect();
    if predicates.is_empty() {
        None
    } else {
        Some(predicates)
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
) -> HashMap<String, String> {
    item.links
        .iter()
        .filter_map(|(text, id)| {
            resolve_id(krate, default_crate_name, *id).map(|resolved| (text.clone(), resolved))
        })
        .collect()
}

#[allow(clippy::type_complexity)]
fn extract_item_details(
    index: &HashMap<rdt::Id, rdt::Item>,
    item: &rdt::Item,
) -> (
    Option<Vec<FieldInfo>>,
    Option<Vec<VariantInfo>>,
    Option<FunctionSignature>,
    Option<Vec<String>>,
    Option<Vec<String>>,
    Option<String>,
) {
    let docs = extract_docs(item);
    match &item.inner {
        rdt::ItemEnum::Struct(item_struct) => (
            extract_struct_fields(index, &item_struct.kind),
            None,
            None,
            extract_generics(&item_struct.generics),
            extract_where_clause(&item_struct.generics),
            docs,
        ),
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
                        type_name: format_type(ty),
                        visibility: map_visibility(&field_item.visibility),
                    })
                })
                .collect();
            (
                if fields.is_empty() {
                    None
                } else {
                    Some(fields)
                },
                None,
                None,
                extract_generics(&item_union.generics),
                extract_where_clause(&item_union.generics),
                docs,
            )
        }
        rdt::ItemEnum::Enum(item_enum) => (
            None,
            extract_enum_variants(index, &item_enum.variants),
            None,
            extract_generics(&item_enum.generics),
            extract_where_clause(&item_enum.generics),
            docs,
        ),
        rdt::ItemEnum::Function(function) => (
            None,
            None,
            Some(extract_function_signature(&function.sig, &function.header)),
            extract_generics(&function.generics),
            extract_where_clause(&function.generics),
            docs,
        ),
        rdt::ItemEnum::Trait(item_trait) => (
            None,
            None,
            None,
            extract_generics(&item_trait.generics),
            extract_where_clause(&item_trait.generics),
            docs,
        ),
        rdt::ItemEnum::TraitAlias(alias) => (
            None,
            None,
            None,
            extract_generics(&alias.generics),
            extract_where_clause(&alias.generics),
            docs,
        ),
        rdt::ItemEnum::TypeAlias(alias) => (
            None,
            None,
            None,
            extract_generics(&alias.generics),
            extract_where_clause(&alias.generics),
            docs,
        ),
        _ => (None, None, None, None, None, docs),
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
        span: None,
        attrs: Vec::new(),
        is_external,
        fields: None,
        variants: None,
        signature: None,
        generics: None,
        where_clause: None,
        docs: None,
        doc_links: HashMap::new(),
        bound_links: HashMap::new(),
        impl_type: None,
        parent_impl: None,
        impl_trait: None,
    });
    node_cache.insert(crate_name.to_string());
}

fn ensure_module_nodes(
    graph: &mut Graph,
    node_cache: &mut HashSet<String>,
    edge_cache: &mut HashSet<String>,
    crate_name: &str,
    path: &[String],
    is_external: bool,
) {
    if path.len() <= 1 {
        return;
    }

    let mut parent_id = crate_name.to_string();
    for (index, segment) in path[..path.len() - 1].iter().enumerate() {
        let module_id = join_path(crate_name, &path[..=index]);
        if !node_cache.contains(&module_id) {
            graph.add_node(Node {
                id: module_id.clone(),
                name: segment.clone(),
                kind: NodeKind::Module,
                visibility: Visibility::Unknown,
                span: None,
                attrs: Vec::new(),
                is_external,
                fields: None,
                variants: None,
                signature: None,
                generics: None,
                where_clause: None,
                docs: None,
                doc_links: HashMap::new(),
                bound_links: HashMap::new(),
                impl_type: None,
                parent_impl: None,
                impl_trait: None,
            });
            node_cache.insert(module_id.clone());
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

fn resolve_id(krate: &rdt::Crate, default_crate_name: &str, id: rdt::Id) -> Option<String> {
    krate.paths.get(&id).map(|summary| {
        let crate_name = crate_name_for_id(krate, summary.crate_id, default_crate_name);
        join_path(&crate_name, &summary.path)
    })
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

fn impl_node_name(krate: &rdt::Crate, default_crate_name: &str, impl_block: &rdt::Impl) -> String {
    let type_name = type_to_id(&impl_block.for_)
        .and_then(|id| resolve_id(krate, default_crate_name, id))
        .map(last_segment)
        .unwrap_or_else(|| "type".to_string());

    if let Some(trait_path) = impl_block.trait_.as_ref() {
        let trait_name = resolve_id(krate, default_crate_name, trait_path.id)
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
) {
    for type_id in type_ids {
        if let Some(target_id) = resolve_id(krate, default_crate_name, type_id) {
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
        let Some(parent_node_id) = resolve_id(krate, default_crate_name, parent_module_id) else {
            continue;
        };

        // Resolve the target to a node ID
        let Some(target_node_id) = resolve_id(krate, default_crate_name, target_id) else {
            continue;
        };

        // Create edge from parent module to re-exported item
        push_edge(
            graph,
            edge_cache,
            parent_node_id,
            target_node_id,
            EdgeKind::ReExports,
            Confidence::Static,
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
        rdt::Attribute::Other(value) => Some(value.clone()),
    }
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
        self.files
            .get(&key)
            .cloned()
            .ok_or_else(|| RustdocError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("file not in memory source map: {}", path.display()),
            )))
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
    let mut parser = SourceParser::new(function_index, graph, edge_cache, call_mode, source_provider);
    parser.parse_module_file(root_file, Vec::new())?;
    Ok(())
}

#[cfg(feature = "native")]
fn crate_root_source(manifest_path: &Path) -> Result<PathBuf, RustdocError> {
    let metadata = MetadataCommand::new().manifest_path(manifest_path).exec()?;
    let package = metadata
        .root_package()
        .ok_or(RustdocError::MissingRootPackage)?;
    let target = package
        .targets
        .iter()
        .find(|target| {
            target
                .kind
                .iter()
                .any(|kind| matches!(kind, TargetKind::Lib | TargetKind::ProcMacro))
        })
        .or_else(|| {
            package.targets.iter().find(|target| {
                target
                    .kind
                    .iter()
                    .any(|kind| matches!(kind, TargetKind::Bin))
            })
        })
        .ok_or(RustdocError::MissingCrateRoot)?;
    Ok(target.src_path.clone().into_std_path_buf())
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

fn resolve_module_file(current_dir: &Path, item_mod: &syn::ItemMod, source_provider: &dyn SourceProvider) -> Option<PathBuf> {
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
    let key = format!("{from}|{to}|{kind:?}");
    if edge_cache.insert(key) {
        graph.add_edge(Edge {
            from,
            to,
            kind,
            confidence,
        });
    }
}
