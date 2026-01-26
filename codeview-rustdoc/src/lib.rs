use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use cargo_metadata::{MetadataCommand, TargetKind};
use codeview_core::{
    ArgumentInfo, Confidence, Edge, EdgeKind, FieldInfo, FunctionSignature, Graph, Node, NodeKind,
    Span, VariantInfo, Visibility,
};
use rustdoc_types as rdt;
use syn::visit::Visit;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum RustdocError {
    #[error("failed to read rustdoc json: {0}")]
    Io(#[from] std::io::Error),
    #[error("failed to parse rustdoc json: {0}")]
    Json(#[from] serde_json::Error),
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

fn get_workspace_members(manifest_path: &Path) -> Result<HashSet<String>, RustdocError> {
    let metadata = MetadataCommand::new().manifest_path(manifest_path).exec()?;
    let members: HashSet<String> = metadata
        .workspace_packages()
        .iter()
        .map(|pkg| pkg.name.replace('-', "_"))
        .collect();
    Ok(members)
}

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
pub fn generate_workspace_rustdoc_json(manifest_path: &Path) -> Result<Vec<RustdocJson>, RustdocError> {
    let metadata = MetadataCommand::new().manifest_path(manifest_path).exec()?;
    let workspace_root = metadata.workspace_root.as_std_path().to_path_buf();
    let target_dir = metadata.target_directory.as_std_path().to_path_buf();

    let mut results = Vec::new();

    for package in metadata.workspace_packages() {
        // Normalize crate name: Cargo uses hyphens but Rust uses underscores internally
        let crate_name = package.name.replace('-', "_");
        let pkg_manifest = package.manifest_path.as_std_path();

        eprintln!("Documenting {} ...", crate_name);

        let status = Command::new("cargo")
            .arg("+nightly")
            .arg("rustdoc")
            .arg("--manifest-path")
            .arg(pkg_manifest)
            .arg("--")
            .arg("-Zunstable-options")
            .arg("--output-format")
            .arg("json")
            .current_dir(&workspace_root)
            .status()?;

        if !status.success() {
            eprintln!("Warning: rustdoc failed for {}", crate_name);
            continue;
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

/// Load and merge graphs from multiple rustdoc JSON files
pub fn load_workspace_graph(
    rustdoc_jsons: &[RustdocJson],
    manifest_path: &Path,
    call_mode: CallMode,
) -> Result<Graph, RustdocError> {
    let mut nodes_by_id: HashMap<String, Node> = HashMap::new();
    let mut edge_keys = HashSet::new();
    let mut edges = Vec::new();

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

    Ok(Graph {
        nodes: nodes_by_id.into_values().collect(),
        edges,
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

pub fn load_graph_from_path(path: &Path, crate_name: &str) -> Result<Graph, RustdocError> {
    let content = fs::read_to_string(path)?;
    extract_graph(&content, crate_name)
}

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
    build_graph(&krate, crate_name, None, None, CallMode::Strict)
}

pub fn extract_graph_with_sources(
    json: &str,
    crate_name: &str,
    workspace_manifest_path: &Path,
    crate_manifest_path: &Path,
    call_mode: CallMode,
) -> Result<Graph, RustdocError> {
    let krate: rdt::Crate = serde_json::from_str(json)?;
    build_graph(
        &krate,
        crate_name,
        Some(workspace_manifest_path),
        Some(crate_manifest_path),
        call_mode,
    )
}

fn build_graph(
    krate: &rdt::Crate,
    crate_name: &str,
    workspace_manifest_path: Option<&Path>,
    crate_manifest_path: Option<&Path>,
    call_mode: CallMode,
) -> Result<Graph, RustdocError> {
    let mut graph = Graph::new();
    let mut node_cache = HashSet::new();
    let mut edge_cache = HashSet::new();
    let method_ids = collect_method_ids(krate);
    let function_index = build_function_index(krate, &method_ids, crate_name);
    let trait_lookup = build_trait_lookup(krate, crate_name);

    // Get workspace members to determine which crates are external
    let workspace_members = workspace_manifest_path
        .map(get_workspace_members)
        .transpose()?
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

            let (fields, variants, signature, generics, docs) = item
                .map(|item| extract_item_details(&krate.index, item))
                .unwrap_or_default();

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
                docs,
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

    add_use_import_edges(&mut graph, &mut edge_cache, krate, crate_name);

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
                if !node_cache.contains(&impl_id) {
                    let name = impl_node_name(krate, crate_name, impl_block);
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
                        docs: extract_docs(item),
                    });
                    node_cache.insert(impl_id.clone());
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
                    if let Some(assoc_node_id) = resolve_id(krate, crate_name, *assoc_id) {
                        push_edge(
                            &mut graph,
                            &mut edge_cache,
                            impl_id.clone(),
                            assoc_node_id,
                            EdgeKind::Defines,
                            Confidence::Static,
                        );
                    }
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

    if let Some(crate_manifest) = crate_manifest_path {
        add_static_call_edges(
            &mut graph,
            &mut edge_cache,
            crate_manifest,
            &function_index,
            call_mode,
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
    Span {
        file: span.filename.to_string_lossy().to_string(),
        line: span.begin.0.saturating_add(1) as u32,
        column: span.begin.1.saturating_add(1) as u32,
    }
}

fn format_type(ty: &rdt::Type) -> String {
    match ty {
        rdt::Type::ResolvedPath(path) => {
            let mut result = path.path.clone();
            if let Some(args) = &path.args {
                result.push_str(&format_generic_args(args));
            }
            result
        }
        rdt::Type::DynTrait(dyn_trait) => {
            let traits: Vec<_> = dyn_trait
                .traits
                .iter()
                .map(|p| p.trait_.path.clone())
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
                    rdt::GenericBound::TraitBound { trait_, .. } => Some(trait_.path.clone()),
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
                    .filter_map(|a| match a {
                        rdt::GenericArg::Type(t) => Some(format_type(t)),
                        rdt::GenericArg::Lifetime(l) => Some(l.clone()),
                        rdt::GenericArg::Const(c) => Some(c.value.clone().unwrap_or_default()),
                        rdt::GenericArg::Infer => Some("_".to_string()),
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

fn extract_function_signature(sig: &rdt::FunctionSignature, header: &rdt::FunctionHeader) -> FunctionSignature {
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

fn extract_generics(generics: &rdt::Generics) -> Option<Vec<String>> {
    let params: Vec<_> = generics
        .params
        .iter()
        .filter_map(|p| match &p.kind {
            rdt::GenericParamDefKind::Type { bounds, default, .. } => {
                let mut s = p.name.clone();
                if !bounds.is_empty() {
                    let bound_strs: Vec<_> = bounds
                        .iter()
                        .filter_map(|b| match b {
                            rdt::GenericBound::TraitBound { trait_, .. } => {
                                Some(trait_.path.clone())
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
                Some(s)
            }
            rdt::GenericParamDefKind::Lifetime { .. } => Some(p.name.clone()),
            rdt::GenericParamDefKind::Const { type_, .. } => {
                Some(format!("const {}: {}", p.name, format_type(type_)))
            }
        })
        .collect();
    if params.is_empty() {
        None
    } else {
        Some(params)
    }
}

fn extract_docs(item: &rdt::Item) -> Option<String> {
    item.docs.clone()
}

fn extract_item_details(
    index: &HashMap<rdt::Id, rdt::Item>,
    item: &rdt::Item,
) -> (
    Option<Vec<FieldInfo>>,
    Option<Vec<VariantInfo>>,
    Option<FunctionSignature>,
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
                if fields.is_empty() { None } else { Some(fields) },
                None,
                None,
                extract_generics(&item_union.generics),
                docs,
            )
        }
        rdt::ItemEnum::Enum(item_enum) => (
            None,
            extract_enum_variants(index, &item_enum.variants),
            None,
            extract_generics(&item_enum.generics),
            docs,
        ),
        rdt::ItemEnum::Function(function) => (
            None,
            None,
            Some(extract_function_signature(&function.sig, &function.header)),
            extract_generics(&function.generics),
            docs,
        ),
        rdt::ItemEnum::Trait(item_trait) => (
            None,
            None,
            None,
            extract_generics(&item_trait.generics),
            docs,
        ),
        rdt::ItemEnum::TraitAlias(alias) => (
            None,
            None,
            None,
            extract_generics(&alias.generics),
            docs,
        ),
        rdt::ItemEnum::TypeAlias(alias) => (
            None,
            None,
            None,
            extract_generics(&alias.generics),
            docs,
        ),
        _ => (None, None, None, None, docs),
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
        docs: None,
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
                docs: None,
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

fn add_use_import_edges(
    graph: &mut Graph,
    edge_cache: &mut HashSet<String>,
    krate: &rdt::Crate,
    default_crate_name: &str,
) {
    for item in krate.index.values() {
        let rdt::ItemEnum::Use(use_item) = &item.inner else {
            continue;
        };
        let Some(target_id) = use_item.id else {
            continue;
        };
        let Some(summary) = krate.paths.get(&item.id) else {
            continue;
        };
        let crate_name = crate_name_for_id(krate, summary.crate_id, default_crate_name);
        let Some(owner_id) = parent_path_id(&crate_name, &summary.path) else {
            continue;
        };
        let Some(target_node_id) = resolve_id(krate, default_crate_name, target_id) else {
            continue;
        };
        push_edge(
            graph,
            edge_cache,
            owner_id,
            target_node_id,
            EdgeKind::UsesType,
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

fn add_static_call_edges(
    graph: &mut Graph,
    edge_cache: &mut HashSet<String>,
    manifest_path: &Path,
    function_index: &FunctionIndex,
    call_mode: CallMode,
) -> Result<(), RustdocError> {
    let root_file = crate_root_source(manifest_path)?;
    let mut parser = SourceParser::new(function_index, graph, edge_cache, call_mode);
    parser.parse_module_file(&root_file, Vec::new())?;
    Ok(())
}

fn crate_root_source(manifest_path: &Path) -> Result<PathBuf, RustdocError> {
    let metadata = MetadataCommand::new().manifest_path(manifest_path).exec()?;
    let package = metadata
        .root_package()
        .ok_or(RustdocError::MissingRootPackage)?;
    let target = package
        .targets
        .iter()
        .find(|target| {
            target.kind.iter().any(|kind| {
                matches!(kind, TargetKind::Lib | TargetKind::ProcMacro)
            })
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

struct FunctionIndex {
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
}

impl<'a> SourceParser<'a> {
    fn new(
        function_index: &'a FunctionIndex,
        graph: &'a mut Graph,
        edge_cache: &'a mut HashSet<String>,
        call_mode: CallMode,
    ) -> Self {
        Self {
            function_index,
            graph,
            edge_cache,
            call_mode,
            visited_files: HashSet::new(),
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
        let content = fs::read_to_string(&path)?;
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

        let module_file = resolve_module_file(current_dir, item_mod);
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
            let Some(caller_id) = self.resolve_method_caller(module_path, type_segments.as_ref(), &name)
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

fn resolve_module_file(current_dir: &Path, item_mod: &syn::ItemMod) -> Option<PathBuf> {
    if let Some(path_override) = module_path_override(item_mod) {
        let full_path = if path_override.is_absolute() {
            path_override
        } else {
            current_dir.join(path_override)
        };
        if full_path.exists() {
            return Some(full_path);
        }
    }

    let name = item_mod.ident.to_string();
    let candidate = current_dir.join(format!("{name}.rs"));
    if candidate.exists() {
        return Some(candidate);
    }
    let mod_rs = current_dir.join(&name).join("mod.rs");
    if mod_rs.exists() {
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
