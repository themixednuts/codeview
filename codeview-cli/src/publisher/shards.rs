//! Static artifact builders.
//!
//! Given a parsed `CrateGraph`, produce the full set of R2 artifacts the
//! SvelteKit worker reads at runtime:
//!
//! - `manifest.json` — top-level (kind counts, roots, populated shards)
//! - `nodes/{bucket}.json` — sharded full Node payloads (FNV-1a × 128)
//! - `node-details/{bucket}.json` — local-page incoming/outgoing edges + ancestors
//! - `tree-children/{bucket}.json` — parent → children for lazy tree
//! - `search-manifest.json` + `search/{prefix}.json` — two-letter prefix
//! - `aliases.json` — public-path → canonical-id map
//! - `{version}.json` + `latest.json` + `stable.json` — version pointers
//!
//! Faithfully ports the algorithms from the deleted
//! `codeview-ui/scripts/static-artifacts.ts`.  Wire-format identical so
//! existing artifacts read cleanly under the new code.

use std::collections::{BTreeMap, HashMap, HashSet};

use codeview_core::{CrateGraph, Edge, EdgeKind, Node, NodeKind, Visibility};
use serde::{Deserialize, Serialize};

pub const STATIC_SCHEMA_VERSION: u32 = 2;
pub const NODE_VIEW_BUCKETS: u32 = 128;
pub const TREE_CHILDREN_BUCKETS: u32 = 128;

// ─── Bucket hash ──────────────────────────────────────────────────────

/// FNV-1a 32-bit. Matches the worker `fnv1a32` so Rust and TypeScript
/// read the same bucket keys.
pub fn fnv1a32(s: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for b in s.bytes() {
        hash ^= b as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// FNV-1a 64-bit for scheduler work sharding.
///
/// This is intentionally separate from the 32-bit artifact bucket hash:
/// parse workers shard stable work ids, while artifact buckets preserve
/// the historical frontend shard layout.
pub fn fnv1a64(s: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

pub fn work_id(kind: &str, name: &str, version: &str, channel_or_target: &str) -> String {
    format!("{kind}:{name}:{version}:{channel_or_target}")
}

pub fn work_bucket(work_id: &str, shard_count: usize) -> usize {
    debug_assert!(shard_count > 0);
    (fnv1a64(work_id) % shard_count as u64) as usize
}

pub fn node_view_bucket(node_id: &str, count: u32) -> String {
    let bucket = fnv1a32(node_id) % count;
    let width = std::cmp::max(3, ((count - 1) as f64).log(16.0).ceil() as usize);
    format!("{bucket:0width$x}")
}

pub fn tree_children_bucket(parent_id: &str, count: u32) -> String {
    node_view_bucket(parent_id, count) // same hash family
}

/// Two-character search prefix.  Pads with `_` for short names so every
/// shard key is exactly 2 chars and the query-side `startsWith` filter
/// works uniformly for 1- and 2-char queries.
pub fn search_prefix(name: &str) -> String {
    let normalised: String = name
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let mut chars = normalised.chars();
    let c0 = chars.next().unwrap_or('_');
    let c1 = chars.next().unwrap_or('_');
    format!("{c0}{c1}")
}

// ─── Wire types (R2-on-disk) ──────────────────────────────────────────

/// Subset of Node carried in the tree/search indices.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeSummary {
    pub id: String,
    pub name: String,
    pub kind: NodeKind,
    pub visibility: Visibility,
    #[serde(default, skip_serializing_if = "is_false")]
    pub is_external: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub is_deprecated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub impl_trait: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub impl_category: Option<codeview_core::ImplCategory>,
    #[serde(default, skip_serializing_if = "is_default_generics")]
    pub generics: codeview_core::Generics,
}

fn is_false(b: &bool) -> bool {
    !*b
}
fn is_default_generics(g: &codeview_core::Generics) -> bool {
    g.is_empty()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TreeNodeDto {
    pub node: NodeSummary,
    #[serde(rename = "hasChildren")]
    pub has_children: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrateIndexEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub is_external: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrateIndex {
    pub name: String,
    pub version: String,
    pub crates: Vec<CrateIndexEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PopulatedShards {
    pub nodes: Vec<String>,
    #[serde(rename = "nodeDetails")]
    pub node_details: Vec<String>,
    #[serde(rename = "treeChildren")]
    pub tree_children: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StaticCrateManifest {
    pub schema_version: u32,
    pub name: String,
    pub version: String,
    pub index: CrateIndex,
    #[serde(rename = "nodeCount")]
    pub node_count: usize,
    #[serde(rename = "edgeCount")]
    pub edge_count: usize,
    #[serde(rename = "kindCounts")]
    pub kind_counts: BTreeMap<String, u32>,
    pub roots: Vec<TreeNodeDto>,
    #[serde(rename = "rootChildren")]
    pub root_children: BTreeMap<String, Vec<TreeNodeDto>>,
    #[serde(rename = "populatedShards")]
    pub populated_shards: PopulatedShards,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StaticNodeShard {
    pub schema_version: u32,
    pub name: String,
    pub version: String,
    pub bucket: String,
    pub nodes: BTreeMap<String, Node>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StaticNodeDetailEntry {
    #[serde(rename = "nodeId")]
    pub node_id: String,
    pub edges: Vec<Edge>,
    #[serde(rename = "relatedIds")]
    pub related_ids: Vec<String>,
    pub ancestors: Vec<NodeSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StaticNodeDetailShard {
    pub schema_version: u32,
    pub name: String,
    pub version: String,
    pub bucket: String,
    pub details: BTreeMap<String, StaticNodeDetailEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StaticSearchManifest {
    pub schema_version: u32,
    pub name: String,
    pub version: String,
    pub prefixes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StaticSearchShard {
    pub schema_version: u32,
    pub name: String,
    pub version: String,
    pub prefix: String,
    pub entries: Vec<NodeSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TreeChildrenParentEntry {
    pub children: Vec<TreeNodeDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StaticTreeChildrenShard {
    pub schema_version: u32,
    pub name: String,
    pub version: String,
    pub bucket: String,
    pub parents: BTreeMap<String, TreeChildrenParentEntry>,
}

// ─── Tree construction ────────────────────────────────────────────────

/// Walk Contains/Defines edges to build the parent→children map.
pub(crate) fn build_tree_relations(
    graph: &CrateGraph,
) -> (HashMap<String, Vec<String>>, HashMap<String, String>) {
    let nodes_by_id: HashMap<&str, &Node> = graph
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect();
    let mut structural_outgoing: HashMap<&str, Vec<&Edge>> = HashMap::new();
    for edge in &graph.edges {
        if matches!(edge.kind, EdgeKind::Contains | EdgeKind::Defines) {
            structural_outgoing
                .entry(edge.from.as_str())
                .or_default()
                .push(edge);
        }
    }

    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    let mut parents: HashMap<String, String> = HashMap::new();
    let mut seen = HashSet::new();

    let mut add_relation = |parent: &str, child: &str| {
        if parent == child || !seen.insert((parent.to_string(), child.to_string())) {
            return;
        }
        children
            .entry(parent.to_string())
            .or_default()
            .push(child.to_string());
        parents
            .entry(child.to_string())
            .or_insert_with(|| parent.to_string());
    };

    for edge in &graph.edges {
        if !matches!(edge.kind, EdgeKind::Contains | EdgeKind::Defines) {
            continue;
        }

        let source = nodes_by_id.get(edge.from.as_str());
        let target = nodes_by_id.get(edge.to.as_str());
        if source.is_some_and(|node| node.kind == NodeKind::Impl) {
            continue;
        }

        if target.is_some_and(|node| node.kind == NodeKind::Impl) {
            // An impl is documentation attached to its owning type, not a page.
            // Prefer the semantic Defines owner and collapse its routeable
            // members directly beneath that owner in the navigation tree.
            if edge.kind == EdgeKind::Defines {
                for member_edge in structural_outgoing
                    .get(edge.to.as_str())
                    .into_iter()
                    .flatten()
                {
                    if nodes_by_id
                        .get(member_edge.to.as_str())
                        .is_some_and(|node| is_local_page_node(node))
                    {
                        add_relation(edge.from.as_str(), member_edge.to.as_str());
                    }
                }
            }
            continue;
        }

        add_relation(edge.from.as_str(), edge.to.as_str());
    }
    (children, parents)
}

pub(crate) fn add_alias_tree_nodes(
    graph: &CrateGraph,
    children: &mut HashMap<String, Vec<String>>,
    parents: &mut HashMap<String, String>,
) -> Vec<Node> {
    let nodes_by_id: HashMap<&str, &Node> = graph
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect();
    let known_aliases: HashSet<&str> = graph.aliases.keys().map(String::as_str).collect();
    let mut aliases: Vec<_> = graph.aliases.iter().collect();
    aliases.sort_by(|(left, _), (right, _)| left.cmp(right));

    let mut alias_nodes = Vec::new();
    for (alias, canonical) in aliases {
        if nodes_by_id.contains_key(alias.as_str()) {
            continue;
        }
        let Some((parent, _)) = alias.rsplit_once("::") else {
            continue;
        };
        if !nodes_by_id.contains_key(parent) && !known_aliases.contains(parent) {
            continue;
        }
        let Some(canonical_node) = nodes_by_id.get(canonical.as_str()) else {
            continue;
        };
        if !is_local_page_node(canonical_node) {
            continue;
        }

        let mut alias_node = (*canonical_node).clone();
        alias_node.id = alias.clone();
        children
            .entry(parent.to_string())
            .or_default()
            .push(alias.clone());
        parents.insert(alias.clone(), parent.to_string());
        alias_nodes.push(alias_node);
    }
    alias_nodes
}

pub(crate) fn project_reexport_aliases(
    parent_id: &str,
    edges: &mut Vec<Edge>,
    aliases: &HashMap<String, String>,
) {
    let mut by_canonical: HashMap<&str, Vec<&str>> = HashMap::new();
    for (alias, canonical) in aliases {
        if alias.rsplit_once("::").map(|(parent, _)| parent) == Some(parent_id) {
            by_canonical
                .entry(canonical.as_str())
                .or_default()
                .push(alias.as_str());
        }
    }
    for projected_aliases in by_canonical.values_mut() {
        projected_aliases.sort_unstable();
    }

    let mut projected = Vec::with_capacity(edges.len());
    for edge in edges.drain(..) {
        if edge.from == parent_id
            && edge.kind == EdgeKind::ReExports
            && let Some(projected_aliases) = by_canonical.get(edge.to.as_str())
        {
            for alias in projected_aliases {
                let mut alias_edge = edge.clone();
                alias_edge.to = (*alias).to_string();
                projected.push(alias_edge);
            }
        } else {
            projected.push(edge);
        }
    }
    *edges = projected;
}

pub(crate) fn summarise_node(n: &Node) -> NodeSummary {
    NodeSummary {
        id: n.id.clone(),
        name: n.name.clone(),
        kind: n.kind,
        visibility: n.visibility.clone(),
        is_external: n.is_external,
        is_deprecated: n.is_deprecated,
        impl_trait: n.impl_trait.clone(),
        impl_category: n.impl_category,
        generics: n.generics.clone(),
    }
}

pub(crate) struct EdgeLookup<'a> {
    incoming: HashMap<&'a str, Vec<&'a Edge>>,
    outgoing: HashMap<&'a str, Vec<&'a Edge>>,
}

impl<'a> EdgeLookup<'a> {
    pub(crate) fn new(edges: &'a [Edge]) -> Self {
        let mut incoming: HashMap<&str, Vec<&Edge>> = HashMap::new();
        let mut outgoing: HashMap<&str, Vec<&Edge>> = HashMap::new();
        for edge in edges {
            incoming.entry(&edge.to).or_default().push(edge);
            outgoing.entry(&edge.from).or_default().push(edge);
        }
        Self { incoming, outgoing }
    }

    fn edge_refs(&self, node_id: &str) -> Vec<&'a Edge> {
        let outgoing = self.outgoing.get(node_id);
        let incoming = self.incoming.get(node_id);
        let capacity = outgoing.map_or(0, Vec::len) + incoming.map_or(0, Vec::len);
        let mut edges = Vec::with_capacity(capacity);
        if let Some(outgoing) = outgoing {
            edges.extend(outgoing.iter().copied());
        }
        if let Some(incoming) = incoming {
            edges.extend(incoming.iter().copied());
        }
        edges
    }

    /// Direct edges for a type page, plus Contains/Defines edges hanging off
    /// each outgoing impl block. The UI needs those second-hop edges to render
    /// trait-impl methods/assoc items (signatures + docs) on the type page —
    /// matching the local provider's expansion behaviour.
    pub(crate) fn page_edges_with_impl_members(&self, node_id: &str) -> Vec<Edge> {
        let mut edges = Vec::new();
        let mut seen = HashSet::new();
        for edge in self.edge_refs(node_id) {
            if seen.insert((edge.from.as_str(), edge.to.as_str(), edge.kind)) {
                edges.push(edge);
            }
        }

        let impl_ids: Vec<&str> = edges
            .iter()
            .filter(|edge| {
                edge.from == node_id
                    && matches!(
                        edge.kind,
                        codeview_core::EdgeKind::Defines | codeview_core::EdgeKind::Contains
                    )
            })
            .map(|edge| edge.to.as_str())
            .collect();

        for impl_id in impl_ids {
            if let Some(outgoing) = self.outgoing.get(impl_id) {
                for edge in outgoing {
                    if !matches!(
                        edge.kind,
                        codeview_core::EdgeKind::Defines | codeview_core::EdgeKind::Contains
                    ) {
                        continue;
                    }
                    if seen.insert((edge.from.as_str(), edge.to.as_str(), edge.kind)) {
                        edges.push(edge);
                    }
                }
            }
        }
        edges.into_iter().cloned().collect()
    }
}

pub(crate) fn collect_related<T>(
    selected_id: &str,
    edges: &[Edge],
    mut map: impl FnMut(&str) -> Option<T>,
) -> Vec<T> {
    let mut seen = HashSet::with_capacity(edges.len().saturating_mul(2));
    let mut related = Vec::new();
    for edge in edges {
        for endpoint in [&edge.from, &edge.to] {
            if endpoint == selected_id || !seen.insert(endpoint.as_str()) {
                continue;
            }
            if let Some(value) = map(endpoint) {
                related.push(value);
            }
        }
    }
    related
}

pub(crate) fn ancestor_summaries(
    node_id: &str,
    parents: &HashMap<String, String>,
    nodes_by_id: &HashMap<&str, &Node>,
) -> Vec<NodeSummary> {
    let mut ancestors = Vec::new();
    let mut cursor = parents.get(node_id);
    while let Some(parent_id) = cursor {
        if let Some(parent_node) = nodes_by_id.get(parent_id.as_str()) {
            ancestors.push(summarise_node(parent_node));
        }
        cursor = parents.get(parent_id);
        if ancestors.len() > 64 {
            break;
        }
    }
    ancestors.reverse();
    ancestors
}

pub(crate) fn is_local_page_node(node: &Node) -> bool {
    !node.is_external
        && node.kind != NodeKind::Impl
        && !(node.parent_impl.is_some() && node.id.contains("::impl-"))
}

pub(crate) fn is_searchable_node(node: &Node) -> bool {
    is_local_page_node(node)
}

pub(crate) fn has_local_tree_children(
    node_id: &str,
    children_map: &HashMap<String, Vec<String>>,
    nodes_by_id: &HashMap<&str, &Node>,
) -> bool {
    children_map.get(node_id).is_some_and(|children| {
        children.iter().any(|child_id| {
            nodes_by_id
                .get(child_id.as_str())
                .is_some_and(|node| is_local_page_node(node))
        })
    })
}

pub(crate) fn compute_roots(nodes: &[Node], parents: &HashMap<String, String>) -> Vec<String> {
    let local_ids: HashSet<&str> = nodes
        .iter()
        .filter(|node| is_local_page_node(node))
        .map(|node| node.id.as_str())
        .collect();

    nodes
        .iter()
        .filter(|n| {
            if !is_local_page_node(n) {
                return false;
            }
            match parents.get(&n.id) {
                Some(parent_id) => !local_ids.contains(parent_id.as_str()),
                None => true,
            }
        })
        .map(|n| n.id.clone())
        .collect()
}

// ─── Per-artifact builders ────────────────────────────────────────────

pub fn build_node_shards(
    graph: &CrateGraph,
    storage_name: &str,
) -> BTreeMap<String, StaticNodeShard> {
    let mut shards: BTreeMap<String, StaticNodeShard> = BTreeMap::new();
    for node in &graph.nodes {
        let bucket = node_view_bucket(&node.id, NODE_VIEW_BUCKETS);
        let shard = shards
            .entry(bucket.clone())
            .or_insert_with(|| StaticNodeShard {
                schema_version: STATIC_SCHEMA_VERSION,
                name: storage_name.to_string(),
                version: graph.version.clone(),
                bucket: bucket.clone(),
                nodes: BTreeMap::new(),
            });
        shard.nodes.insert(node.id.clone(), node.clone());
    }
    shards
}

pub fn build_tree_children_shards(
    graph: &CrateGraph,
    storage_name: &str,
    children_map: &HashMap<String, Vec<String>>,
    nodes_by_id: &HashMap<&str, &Node>,
) -> BTreeMap<String, StaticTreeChildrenShard> {
    let mut shards: BTreeMap<String, StaticTreeChildrenShard> = BTreeMap::new();
    for (parent_id, child_ids) in children_map {
        let Some(parent_node) = nodes_by_id.get(parent_id.as_str()) else {
            continue;
        };
        if !is_local_page_node(parent_node) {
            continue;
        }
        let children: Vec<TreeNodeDto> = child_ids
            .iter()
            .filter_map(|cid| {
                nodes_by_id.get(cid.as_str()).and_then(|n| {
                    if !is_local_page_node(n) {
                        return None;
                    }
                    Some(TreeNodeDto {
                        node: summarise_node(n),
                        has_children: has_local_tree_children(cid, children_map, nodes_by_id),
                    })
                })
            })
            .collect();
        if children.is_empty() {
            continue;
        }
        let bucket = tree_children_bucket(parent_id, TREE_CHILDREN_BUCKETS);
        let shard = shards
            .entry(bucket.clone())
            .or_insert_with(|| StaticTreeChildrenShard {
                schema_version: STATIC_SCHEMA_VERSION,
                name: storage_name.to_string(),
                version: graph.version.clone(),
                bucket: bucket.clone(),
                parents: BTreeMap::new(),
            });
        shard
            .parents
            .insert(parent_id.clone(), TreeChildrenParentEntry { children });
    }
    shards
}

pub fn build_node_detail_shards(
    graph: &CrateGraph,
    storage_name: &str,
    parents: &HashMap<String, String>,
    nodes_by_id: &HashMap<&str, &Node>,
) -> BTreeMap<String, StaticNodeDetailShard> {
    let edge_lookup = EdgeLookup::new(&graph.edges);

    let mut shards: BTreeMap<String, StaticNodeDetailShard> = BTreeMap::new();
    for node in graph.nodes.iter().filter(|node| is_local_page_node(node)) {
        let bucket = node_view_bucket(&node.id, NODE_VIEW_BUCKETS);
        // Include second-hop edges from impl blocks → methods/assoc items so
        // the hosted detail page can list trait-impl members the way docs.rs does.
        let mut edges = edge_lookup.page_edges_with_impl_members(node.id.as_str());
        project_reexport_aliases(node.id.as_str(), &mut edges, &graph.aliases);
        let related_ids = collect_related(node.id.as_str(), &edges, |endpoint| {
            Some(endpoint.to_string())
        });
        let ancestors = ancestor_summaries(node.id.as_str(), parents, nodes_by_id);

        let shard = shards
            .entry(bucket.clone())
            .or_insert_with(|| StaticNodeDetailShard {
                schema_version: STATIC_SCHEMA_VERSION,
                name: storage_name.to_string(),
                version: graph.version.clone(),
                bucket: bucket.clone(),
                details: BTreeMap::new(),
            });
        shard.details.insert(
            node.id.clone(),
            StaticNodeDetailEntry {
                node_id: node.id.clone(),
                edges,
                related_ids,
                ancestors,
            },
        );
    }
    shards
}

pub fn build_search_shards(
    graph: &CrateGraph,
    storage_name: &str,
) -> (StaticSearchManifest, BTreeMap<String, StaticSearchShard>) {
    let mut shards: BTreeMap<String, StaticSearchShard> = BTreeMap::new();
    for node in graph.nodes.iter().filter(|node| is_searchable_node(node)) {
        let prefix = search_prefix(&node.name);
        let shard = shards
            .entry(prefix.clone())
            .or_insert_with(|| StaticSearchShard {
                schema_version: STATIC_SCHEMA_VERSION,
                name: storage_name.to_string(),
                version: graph.version.clone(),
                prefix: prefix.clone(),
                entries: Vec::new(),
            });
        shard.entries.push(summarise_node(node));
    }
    let manifest = StaticSearchManifest {
        schema_version: STATIC_SCHEMA_VERSION,
        name: storage_name.to_string(),
        version: graph.version.clone(),
        prefixes: shards.keys().cloned().collect(),
    };
    (manifest, shards)
}

pub fn build_manifest(
    graph: &CrateGraph,
    storage_name: &str,
    populated: PopulatedShards,
) -> StaticCrateManifest {
    let (mut children_map, mut parents) = build_tree_relations(graph);
    let alias_nodes = add_alias_tree_nodes(graph, &mut children_map, &mut parents);
    let nodes_by_id: HashMap<&str, &Node> = graph
        .nodes
        .iter()
        .chain(alias_nodes.iter())
        .map(|n| (n.id.as_str(), n))
        .collect();

    let local_nodes: Vec<&Node> = graph
        .nodes
        .iter()
        .filter(|node| is_local_page_node(node))
        .collect();
    let root_ids = compute_roots(&graph.nodes, &parents);
    let roots: Vec<TreeNodeDto> = root_ids
        .iter()
        .filter_map(|id| {
            nodes_by_id.get(id.as_str()).map(|n| TreeNodeDto {
                node: summarise_node(n),
                has_children: has_local_tree_children(id, &children_map, &nodes_by_id),
            })
        })
        .collect();

    let mut root_children: BTreeMap<String, Vec<TreeNodeDto>> = BTreeMap::new();
    for r in &root_ids {
        if let Some(child_ids) = children_map.get(r) {
            let entries: Vec<TreeNodeDto> = child_ids
                .iter()
                .filter_map(|cid| {
                    nodes_by_id.get(cid.as_str()).and_then(|n| {
                        if !is_local_page_node(n) {
                            return None;
                        }
                        Some(TreeNodeDto {
                            node: summarise_node(n),
                            has_children: has_local_tree_children(cid, &children_map, &nodes_by_id),
                        })
                    })
                })
                .collect();
            root_children.insert(r.clone(), entries);
        }
    }

    let index = CrateIndex {
        name: storage_name.to_string(),
        version: graph.version.clone(),
        crates: vec![CrateIndexEntry {
            id: graph.id.clone(),
            name: storage_name.to_string(),
            version: graph.version.clone(),
            is_external: false,
        }],
    };

    StaticCrateManifest {
        schema_version: STATIC_SCHEMA_VERSION,
        name: storage_name.to_string(),
        version: graph.version.clone(),
        index,
        node_count: local_nodes.len(),
        edge_count: graph.edges.len(),
        kind_counts: {
            let mut counts: BTreeMap<String, u32> = BTreeMap::new();
            for node in local_nodes {
                *counts.entry(format!("{:?}", node.kind)).or_insert(0) += 1;
            }
            counts
        },
        roots,
        root_children,
        populated_shards: populated,
    }
}

// ─── Orchestrator ─────────────────────────────────────────────────────

/// A single artifact ready to upload — key + body + content-type.
pub struct Artifact {
    pub key: String,
    pub body: Vec<u8>,
    pub content_type: &'static str,
}

const JSON: &str = "application/json; charset=utf-8";

/// Build every artifact for a single crate.  Pure: takes a graph in,
/// returns a list of (key, body) pairs.  Caller (`artifacts.rs`)
/// uploads them via the `R2` trait.
///
/// Validation: refuses to publish empty-graph or graph-with-only-external
/// nodes.
pub fn build_all(
    graph: &CrateGraph,
    storage_name: &str,
    aliases: &[&str],
) -> Result<Vec<Artifact>, anyhow::Error> {
    validate(graph)?;

    let prefix = format!("rust/{storage_name}/{}", graph.version);
    let nodes_by_id: HashMap<&str, &Node> =
        graph.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let (mut children_map, mut parents) = build_tree_relations(graph);
    let alias_nodes = add_alias_tree_nodes(graph, &mut children_map, &mut parents);
    let tree_nodes_by_id: HashMap<&str, &Node> = graph
        .nodes
        .iter()
        .chain(alias_nodes.iter())
        .map(|n| (n.id.as_str(), n))
        .collect();

    // Build shards first so the manifest can record populated lists.
    let node_shards = build_node_shards(graph, storage_name);
    let detail_shards = build_node_detail_shards(graph, storage_name, &parents, &nodes_by_id);
    let tree_shards =
        build_tree_children_shards(graph, storage_name, &children_map, &tree_nodes_by_id);

    let populated = PopulatedShards {
        nodes: node_shards.keys().cloned().collect(),
        node_details: detail_shards.keys().cloned().collect(),
        tree_children: tree_shards.keys().cloned().collect(),
    };

    let manifest = build_manifest(graph, storage_name, populated);
    let (search_manifest, search_shards) = build_search_shards(graph, storage_name);

    let mut out: Vec<Artifact> = Vec::new();

    // Top-level manifest
    out.push(Artifact {
        key: format!("{prefix}/manifest.json"),
        body: serde_json::to_vec(&manifest)?,
        content_type: JSON,
    });

    // Aliases — `graph.aliases` carries public-path → canonical-id
    if !graph.aliases.is_empty() {
        out.push(Artifact {
            key: format!("{prefix}/aliases.json"),
            body: serde_json::to_vec(&graph.aliases)?,
            content_type: JSON,
        });
    }

    // Tree children
    for (bucket, shard) in tree_shards {
        out.push(Artifact {
            key: format!("{prefix}/tree-children/{bucket}.json"),
            body: serde_json::to_vec(&shard)?,
            content_type: JSON,
        });
    }

    // Node payloads
    for (bucket, shard) in node_shards {
        out.push(Artifact {
            key: format!("{prefix}/nodes/{bucket}.json"),
            body: serde_json::to_vec(&shard)?,
            content_type: JSON,
        });
    }

    // Node detail (edges + relations + ancestors)
    for (bucket, shard) in detail_shards {
        out.push(Artifact {
            key: format!("{prefix}/node-details/{bucket}.json"),
            body: serde_json::to_vec(&shard)?,
            content_type: JSON,
        });
    }

    // Search index
    out.push(Artifact {
        key: format!("{prefix}/search-manifest.json"),
        body: serde_json::to_vec(&search_manifest)?,
        content_type: JSON,
    });
    for (prefix_key, shard) in search_shards {
        out.push(Artifact {
            key: format!("{prefix}/search/{prefix_key}.json"),
            body: serde_json::to_vec(&shard)?,
            content_type: JSON,
        });
    }

    // Version-alias pointers: `{name}/{alias}.json` → `{ version }`
    for alias in aliases {
        let body = serde_json::to_vec(&serde_json::json!({ "version": graph.version }))?;
        out.push(Artifact {
            key: format!("rust/{storage_name}/{alias}.json"),
            body,
            content_type: JSON,
        });
    }

    Ok(out)
}

fn validate(graph: &CrateGraph) -> Result<(), anyhow::Error> {
    let internal = graph.nodes.iter().filter(|n| !n.is_external).count();
    let external = graph.nodes.len() - internal;
    if graph.nodes.len() > 1 && internal <= 1 && external > 0 {
        anyhow::bail!(
            "refusing to publish {}@{}: {} nodes but only {} internal (use docs.rs or enable features)",
            graph.name,
            graph.version,
            graph.nodes.len(),
            internal,
        );
    }
    Ok(())
}

// ─── Deterministic graph hash ─────────────────────────────────────────

/// Canonical hash for idempotency.  Two runs that produce the same logical
/// graph yield the same hash regardless of internal `HashMap` iteration
/// order. Achieved by sorting nodes/edges and serialising via
/// `serde_json::to_value` then walking the tree with sorted object keys.
pub fn graph_hash(graph: &CrateGraph) -> String {
    use sha2::{Digest, Sha256};

    let mut nodes = graph.nodes.clone();
    nodes.sort_by(|a, b| a.id.cmp(&b.id));
    let mut edges = graph.edges.clone();
    edges.sort_by(|a, b| {
        a.from
            .cmp(&b.from)
            .then(a.to.cmp(&b.to))
            .then_with(|| format!("{:?}", a.kind).cmp(&format!("{:?}", b.kind)))
    });

    let value = serde_json::json!({
        "id": graph.id,
        "name": graph.name,
        "version": graph.version,
        "nodes": nodes,
        "edges": edges,
    });

    let mut hasher = Sha256::new();
    canonical_hash(&value, &mut hasher);
    hex::encode(hasher.finalize())
}

fn canonical_hash<H: sha2::Digest>(value: &serde_json::Value, h: &mut H) {
    use serde_json::Value::*;
    match value {
        Null => h.update(b"null"),
        Bool(b) => h.update(if *b {
            b"true" as &[_]
        } else {
            b"false" as &[_]
        }),
        Number(n) => h.update(n.to_string().as_bytes()),
        String(s) => {
            h.update(b"\"");
            h.update(s.as_bytes());
            h.update(b"\"");
        }
        Array(arr) => {
            h.update(b"[");
            for (i, v) in arr.iter().enumerate() {
                if i > 0 {
                    h.update(b",");
                }
                canonical_hash(v, h);
            }
            h.update(b"]");
        }
        Object(obj) => {
            h.update(b"{");
            // Disambiguate against `serde_json::Value::String` variant in scope.
            let mut keys: Vec<&std::string::String> = obj.keys().collect();
            keys.sort();
            for (i, k) in keys.into_iter().enumerate() {
                if i > 0 {
                    h.update(b",");
                }
                h.update(b"\"");
                h.update(k.as_bytes());
                h.update(b"\":");
                canonical_hash(&obj[k], h);
            }
            h.update(b"}");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use codeview_core::{Confidence, EdgeKind, Visibility};

    use super::*;

    fn node(id: &str, name: &str, kind: NodeKind) -> Node {
        Node::new(id, name, kind, Visibility::Public)
    }

    fn external_node(id: &str, name: &str, kind: NodeKind) -> Node {
        let mut node = node(id, name, kind);
        node.is_external = true;
        node
    }

    fn edge(from: &str, to: &str, kind: EdgeKind) -> Edge {
        Edge {
            from: from.to_string(),
            to: to.to_string(),
            kind,
            confidence: Confidence::Static,
            occurrences: Vec::new(),
            is_glob: false,
        }
    }

    fn graph_with_external_and_impls() -> CrateGraph {
        let mut trait_impl_method = node("demo::impl-1::clone", "clone", NodeKind::Function);
        trait_impl_method.parent_impl = Some("demo::impl-1".to_string());
        CrateGraph {
            id: "demo".to_string(),
            name: "demo".to_string(),
            version: "1.0.0".to_string(),
            nodes: vec![
                node("demo", "demo", NodeKind::Crate),
                node("demo::Thing", "Thing", NodeKind::Struct),
                node("demo::make", "make", NodeKind::Function),
                node("demo::impl-1", "impl Clone for Thing", NodeKind::Impl),
                trait_impl_method,
                node("demo::Wrapper", "Wrapper", NodeKind::Module),
                node("demo::Adopted", "Adopted", NodeKind::Struct),
                external_node("core", "core", NodeKind::Crate),
                external_node("core::clone::Clone", "Clone", NodeKind::Trait),
            ],
            edges: vec![
                edge("demo", "demo::Thing", EdgeKind::Defines),
                edge("demo", "demo::make", EdgeKind::Defines),
                edge("demo", "demo::Wrapper", EdgeKind::Defines),
                edge("demo::Thing", "demo::impl-1", EdgeKind::Defines),
                edge("demo::Wrapper", "core::clone::Clone", EdgeKind::Defines),
                edge("core", "demo::Adopted", EdgeKind::Defines),
                edge("demo::impl-1", "core::clone::Clone", EdgeKind::Implements),
                edge("demo::impl-1", "demo::impl-1::clone", EdgeKind::Defines),
                edge("demo::make", "core::clone::Clone", EdgeKind::UsesType),
            ],
            aliases: HashMap::new(),
        }
    }

    #[test]
    fn fnv1a64_matches_known_vector() {
        assert_eq!(fnv1a64(""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a64("hello"), 0xa430_d846_80aa_bd0b);
    }

    #[test]
    fn work_id_uses_stable_shape() {
        assert_eq!(
            work_id("crate", "serde", "1.0.228", "default"),
            "crate:serde:1.0.228:default"
        );
    }

    #[test]
    fn work_bucket_is_deterministic_and_evenish() {
        let shard_count = 16;
        let first = work_bucket("crate:serde:1.0.228:default", shard_count);
        let second = work_bucket("crate:serde:1.0.228:default", shard_count);
        assert_eq!(first, second);

        let mut buckets = vec![0usize; shard_count];
        for i in 0..4096 {
            let id = work_id("crate", &format!("crate-{i}"), "1.0.0", "default");
            buckets[work_bucket(&id, shard_count)] += 1;
        }
        let min = buckets.iter().copied().min().unwrap_or_default();
        let max = buckets.iter().copied().max().unwrap_or_default();
        assert!(min > 200, "bucket distribution too sparse: {buckets:?}");
        assert!(
            max < 320,
            "bucket distribution too concentrated: {buckets:?}"
        );
    }

    #[test]
    fn static_node_details_skip_external_page_entries_but_keep_related_ids() {
        let graph = graph_with_external_and_impls();
        let nodes_by_id: HashMap<&str, &Node> = graph
            .nodes
            .iter()
            .map(|node| (node.id.as_str(), node))
            .collect();
        let (_children, parents) = build_tree_relations(&graph);
        let detail_shards = build_node_detail_shards(&graph, "demo", &parents, &nodes_by_id);

        let external_bucket = node_view_bucket("core::clone::Clone", NODE_VIEW_BUCKETS);
        assert!(
            !detail_shards
                .get(&external_bucket)
                .is_some_and(|shard| shard.details.contains_key("core::clone::Clone")),
            "external nodes should remain related data, not page detail entries"
        );

        let local_bucket = node_view_bucket("demo::make", NODE_VIEW_BUCKETS);
        let local_entry = detail_shards
            .get(&local_bucket)
            .and_then(|shard| shard.details.get("demo::make"))
            .expect("local node detail entry");
        assert!(
            local_entry
                .related_ids
                .contains(&"core::clone::Clone".to_string()),
            "local pages still need external related nodes"
        );
    }

    #[test]
    fn static_node_details_keep_full_high_fanout_edges() {
        let mut graph = graph_with_external_and_impls();
        let extra_callers = 144;
        for index in 0..extra_callers {
            let id = format!("demo::caller_{index:03}");
            graph.nodes.push(node(&id, "caller", NodeKind::Function));
            graph
                .edges
                .push(edge(&id, "demo::Thing", EdgeKind::UsesType));
        }
        let nodes_by_id: HashMap<&str, &Node> = graph
            .nodes
            .iter()
            .map(|node| (node.id.as_str(), node))
            .collect();
        let (_children, parents) = build_tree_relations(&graph);
        let detail_shards = build_node_detail_shards(&graph, "demo", &parents, &nodes_by_id);
        let bucket = node_view_bucket("demo::Thing", NODE_VIEW_BUCKETS);
        let entry = detail_shards
            .get(&bucket)
            .and_then(|shard| shard.details.get("demo::Thing"))
            .expect("high-fanout node detail");

        assert_eq!(
            entry.edges.len(),
            1 + 1 + 1 + extra_callers,
            "one outgoing impl edge, one impl-member edge, one crate parent edge, and all incoming references"
        );
        assert!(
            entry.related_ids.contains(&"demo::caller_143".to_string()),
            "related ids should be derived from the complete edge set"
        );
        assert!(
            entry
                .related_ids
                .contains(&"demo::impl-1::clone".to_string()),
            "impl methods must be related so the UI can render signatures + docs"
        );
        assert!(
            entry
                .edges
                .iter()
                .any(|edge| { edge.from == "demo::impl-1" && edge.to == "demo::impl-1::clone" }),
            "type pages must include second-hop impl→member edges"
        );
    }

    #[test]
    fn static_tree_manifest_and_search_are_local_page_surfaces() {
        let graph = graph_with_external_and_impls();
        let nodes_by_id: HashMap<&str, &Node> = graph
            .nodes
            .iter()
            .map(|node| (node.id.as_str(), node))
            .collect();
        let (children, _parents) = build_tree_relations(&graph);

        let tree_shards = build_tree_children_shards(&graph, "demo", &children, &nodes_by_id);
        assert!(tree_shards.values().all(|shard| !shard.parents.is_empty()));
        assert!(
            tree_shards.values().all(|shard| {
                !shard.parents.contains_key("core")
                    && !shard.parents.contains_key("demo::Wrapper")
                    && !shard.parents.contains_key("demo::impl-1")
                    && shard.parents.values().all(|entry| {
                        entry.children.iter().all(|child| {
                            !child.node.is_external && child.node.kind != NodeKind::Impl
                        })
                    })
            }),
            "tree shards should only expose routeable local pages"
        );

        assert!(
            !children
                .values()
                .any(|ids| ids.iter().any(|id| id == "demo::impl-1::clone")),
            "trait-impl members belong in type documentation, not the navigation tree",
        );

        let manifest = build_manifest(
            &graph,
            "demo",
            PopulatedShards {
                nodes: Vec::new(),
                node_details: Vec::new(),
                tree_children: Vec::new(),
            },
        );
        assert_eq!(manifest.node_count, 5);
        assert!(manifest.roots.iter().all(|root| !root.node.is_external));
        assert!(
            manifest
                .roots
                .iter()
                .any(|root| root.node.id == "demo::Adopted"),
            "local nodes with only external parents should become roots"
        );
        let demo_children = manifest
            .root_children
            .get("demo")
            .expect("demo root children");
        assert!(
            demo_children
                .iter()
                .any(|child| child.node.id == "demo::Wrapper" && !child.has_children),
            "external-only children should not make hasChildren true"
        );
        assert!(!manifest.kind_counts.contains_key("Trait"));

        let (_search_manifest, search_shards) = build_search_shards(&graph, "demo");
        let search_ids: Vec<&str> = search_shards
            .values()
            .flat_map(|shard| shard.entries.iter().map(|entry| entry.id.as_str()))
            .collect();
        assert!(!search_ids.contains(&"core::clone::Clone"));
        assert!(!search_ids.contains(&"demo::impl-1"));
        assert!(!search_ids.contains(&"demo::impl-1::clone"));
        assert!(search_ids.contains(&"demo::Thing"));
    }
}
