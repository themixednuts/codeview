//! Static artifact builders.
//!
//! Given a parsed `CrateGraph`, produce the full set of R2 artifacts the
//! SvelteKit worker reads at runtime:
//!
//! - `manifest.json` — top-level (kind counts, roots, populated shards)
//! - `nodes/{bucket}.json` — sharded full Node payloads (FNV-1a × 128)
//! - `node-details/{bucket}.json` — incoming/outgoing edges + ancestors
//! - `tree-children/{bucket}.json` — parent → children for lazy tree
//! - `search-manifest.json` + `search/{prefix}.json` — two-letter prefix
//! - `aliases.json` — public-path → canonical-id map
//! - `{version}.json` + `latest.json` + `stable.json` — version pointers
//!
//! Faithfully ports the algorithms from the deleted
//! `codeview-ui/scripts/static-artifacts.ts`.  Wire-format identical so
//! existing artifacts read cleanly under the new code.

use std::collections::{BTreeMap, HashMap};

use codeview_core::{CrateGraph, Edge, Node, NodeKind, Visibility};
use serde::{Deserialize, Serialize};

pub const STATIC_SCHEMA_VERSION: u32 = 1;
pub const NODE_VIEW_BUCKETS: u32 = 128;
pub const TREE_CHILDREN_BUCKETS: u32 = 128;

// ─── Bucket hash ──────────────────────────────────────────────────────

/// FNV-1a 32-bit. Identical to the TS `fnv1a32` so existing artifacts
/// hash to the same buckets after migration.
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
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' })
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
    #[serde(rename = "populatedShards", skip_serializing_if = "Option::is_none")]
    pub populated_shards: Option<PopulatedShards>,
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
fn build_tree_relations(
    graph: &CrateGraph,
) -> (HashMap<String, Vec<String>>, HashMap<String, String>) {
    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    let mut parents: HashMap<String, String> = HashMap::new();
    for edge in &graph.edges {
        if matches!(
            edge.kind,
            codeview_core::EdgeKind::Contains | codeview_core::EdgeKind::Defines
        ) {
            children
                .entry(edge.from.clone())
                .or_default()
                .push(edge.to.clone());
            parents.entry(edge.to.clone()).or_insert(edge.from.clone());
        }
    }
    (children, parents)
}

fn summarise_node(n: &Node) -> NodeSummary {
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

fn kind_counts(nodes: &[Node]) -> BTreeMap<String, u32> {
    let mut counts: BTreeMap<String, u32> = BTreeMap::new();
    for n in nodes {
        *counts
            .entry(format!("{:?}", n.kind))
            .or_insert(0) += 1;
    }
    counts
}

fn compute_roots(
    nodes: &[Node],
    parents: &HashMap<String, String>,
) -> Vec<String> {
    nodes
        .iter()
        .filter(|n| !parents.contains_key(&n.id))
        .map(|n| n.id.clone())
        .collect()
}

// ─── Per-artifact builders ────────────────────────────────────────────

pub fn build_node_shards(graph: &CrateGraph, storage_name: &str) -> BTreeMap<String, StaticNodeShard> {
    let mut shards: BTreeMap<String, StaticNodeShard> = BTreeMap::new();
    for node in &graph.nodes {
        let bucket = node_view_bucket(&node.id, NODE_VIEW_BUCKETS);
        let shard = shards.entry(bucket.clone()).or_insert_with(|| StaticNodeShard {
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
        let children: Vec<TreeNodeDto> = child_ids
            .iter()
            .filter_map(|cid| nodes_by_id.get(cid.as_str()).map(|n| TreeNodeDto {
                node: summarise_node(n),
                has_children: children_map.get(cid).is_some_and(|c| !c.is_empty()),
            }))
            .collect();
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
    // Group edges by both endpoints for quick lookup.
    let mut incoming: HashMap<&str, Vec<&Edge>> = HashMap::new();
    let mut outgoing: HashMap<&str, Vec<&Edge>> = HashMap::new();
    for e in &graph.edges {
        incoming.entry(&e.to).or_default().push(e);
        outgoing.entry(&e.from).or_default().push(e);
    }

    let mut shards: BTreeMap<String, StaticNodeDetailShard> = BTreeMap::new();
    for node in &graph.nodes {
        let bucket = node_view_bucket(&node.id, NODE_VIEW_BUCKETS);

        // Combine incoming + outgoing edges, preserving order for stable output.
        let mut edges: Vec<Edge> = Vec::new();
        if let Some(out) = outgoing.get(node.id.as_str()) {
            edges.extend(out.iter().map(|&e| e.clone()));
        }
        if let Some(inc) = incoming.get(node.id.as_str()) {
            edges.extend(inc.iter().map(|&e| e.clone()));
        }

        // Related IDs = every distinct node touched by edges, excluding self.
        let mut seen: HashMap<&str, ()> = HashMap::new();
        let mut related_ids: Vec<String> = Vec::new();
        for e in &edges {
            for endpoint in [&e.from, &e.to] {
                if endpoint == &node.id {
                    continue;
                }
                if seen.insert(endpoint.as_str(), ()).is_none() {
                    related_ids.push(endpoint.clone());
                }
            }
        }

        // Ancestor chain via parents map.
        let mut ancestors: Vec<NodeSummary> = Vec::new();
        let mut cursor: Option<&String> = parents.get(&node.id);
        while let Some(parent_id) = cursor {
            if let Some(parent_node) = nodes_by_id.get(parent_id.as_str()) {
                ancestors.push(summarise_node(parent_node));
            }
            cursor = parents.get(parent_id);
            if ancestors.len() > 64 {
                break; // pathological loop guard
            }
        }
        ancestors.reverse();

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
    for node in &graph.nodes {
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
    let (children_map, parents) = build_tree_relations(graph);
    let nodes_by_id: HashMap<&str, &Node> = graph.nodes.iter().map(|n| (n.id.as_str(), n)).collect();

    let root_ids = compute_roots(&graph.nodes, &parents);
    let roots: Vec<TreeNodeDto> = root_ids
        .iter()
        .filter_map(|id| nodes_by_id.get(id.as_str()).map(|n| TreeNodeDto {
            node: summarise_node(n),
            has_children: children_map.get(id).is_some_and(|c| !c.is_empty()),
        }))
        .collect();

    let mut root_children: BTreeMap<String, Vec<TreeNodeDto>> = BTreeMap::new();
    for r in &root_ids {
        if let Some(child_ids) = children_map.get(r) {
            let entries: Vec<TreeNodeDto> = child_ids
                .iter()
                .filter_map(|cid| nodes_by_id.get(cid.as_str()).map(|n| TreeNodeDto {
                    node: summarise_node(n),
                    has_children: children_map.get(cid).is_some_and(|c| !c.is_empty()),
                }))
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
        node_count: graph.nodes.len(),
        edge_count: graph.edges.len(),
        kind_counts: kind_counts(&graph.nodes),
        roots,
        root_children,
        populated_shards: Some(populated),
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
/// nodes — matches the old TS guardrail.
pub fn build_all(
    graph: &CrateGraph,
    storage_name: &str,
    aliases: &[&str],
) -> Result<Vec<Artifact>, anyhow::Error> {
    validate(graph)?;

    let prefix = format!("rust/{storage_name}/{}", graph.version);
    let nodes_by_id: HashMap<&str, &Node> = graph.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let (children_map, parents) = build_tree_relations(graph);

    // Build shards first so the manifest can record populated lists.
    let node_shards = build_node_shards(graph, storage_name);
    let detail_shards =
        build_node_detail_shards(graph, storage_name, &parents, &nodes_by_id);
    let tree_shards =
        build_tree_children_shards(graph, storage_name, &children_map, &nodes_by_id);

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
        Bool(b) => h.update(if *b { b"true" as &[_] } else { b"false" as &[_] }),
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
    use super::*;

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
        assert!(max < 320, "bucket distribution too concentrated: {buckets:?}");
    }
}
