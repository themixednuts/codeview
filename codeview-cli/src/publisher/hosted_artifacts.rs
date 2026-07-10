//! Hosted static artifacts.
//!
//! These artifacts preserve the same public schema version marker as the
//! base static artifacts, but pack the data that the Cloudflare worker needs
//! for page rendering into a small number of predictable reads.

use std::collections::{BTreeMap, HashMap};

use anyhow::Context;
use codeview_core::{CrateGraph, Edge, Node, NodeKind};
use serde::{Deserialize, Serialize};

use super::shards::{
    Artifact, CrateIndex, CrateIndexEntry, EdgeLookup, NodeSummary, StaticSearchManifest,
    StaticSearchShard, TreeNodeDto, ancestor_summaries, collect_related, has_local_tree_children,
    is_local_page_node, is_searchable_node, node_view_bucket, search_prefix, summarise_node,
    tree_children_bucket,
};

const JSON: &str = "application/json; charset=utf-8";
const SITE_DIR: &str = "site";
const SCHEMA_VERSION: u32 = super::shards::STATIC_SCHEMA_VERSION;
const DEFAULT_TARGET_RAW_SHARD_BYTES: usize = 256 * 1024;
const MIN_NODE_VIEW_BUCKETS: u32 = 128;
const MAX_NODE_VIEW_BUCKETS: u32 = 4096;
const TREE_CHILDREN_BUCKETS: u32 = 128;
const ALIAS_BUCKETS: u32 = 128;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostedArtifactConfig {
    #[serde(rename = "targetRawShardBytes")]
    pub target_raw_shard_bytes: usize,
    #[serde(rename = "minNodeViewBuckets")]
    pub min_node_view_buckets: u32,
    #[serde(rename = "maxNodeViewBuckets")]
    pub max_node_view_buckets: u32,
    #[serde(rename = "treeChildrenBuckets")]
    pub tree_children_buckets: u32,
    #[serde(rename = "aliasBuckets")]
    pub alias_buckets: u32,
}

impl Default for HostedArtifactConfig {
    fn default() -> Self {
        Self {
            target_raw_shard_bytes: DEFAULT_TARGET_RAW_SHARD_BYTES,
            min_node_view_buckets: MIN_NODE_VIEW_BUCKETS,
            max_node_view_buckets: MAX_NODE_VIEW_BUCKETS,
            tree_children_buckets: TREE_CHILDREN_BUCKETS,
            alias_buckets: ALIAS_BUCKETS,
        }
    }
}

pub struct HostedArtifactSet {
    pub artifacts: Vec<Artifact>,
    pub report: HostedBuildReport,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostedBuildReport {
    #[serde(rename = "nodeViewEntries")]
    pub node_view_entries: usize,
    #[serde(rename = "nodeViewTotalRawBytes")]
    pub node_view_total_raw_bytes: usize,
    #[serde(rename = "nodeViewLargestEntryRawBytes")]
    pub node_view_largest_entry_raw_bytes: usize,
    #[serde(rename = "nodeViewLargestEntryId")]
    pub node_view_largest_entry_id: Option<String>,
    #[serde(rename = "nodeViewBucketCount")]
    pub node_view_bucket_count: u32,
    #[serde(rename = "nodeViewLargestBucketRawBytes")]
    pub node_view_largest_bucket_raw_bytes: usize,
    #[serde(rename = "treeBucketCount")]
    pub tree_bucket_count: u32,
    #[serde(rename = "aliasCount")]
    pub alias_count: usize,
    #[serde(rename = "aliasBucketCount")]
    pub alias_bucket_count: u32,
    #[serde(rename = "searchPrefixCount")]
    pub search_prefix_count: usize,
    #[serde(rename = "kindIndexKindCount")]
    pub kind_index_kind_count: usize,
    #[serde(rename = "kindIndexEntryCount")]
    pub kind_index_entry_count: usize,
    #[serde(rename = "artifactTotalRawBytes")]
    pub artifact_total_raw_bytes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostedMetaArtifact {
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
    #[serde(rename = "artifacts")]
    pub hosted_artifacts: HostedArtifactInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostedArtifactInfo {
    #[serde(rename = "nodeViewBucketCount")]
    pub node_view_bucket_count: u32,
    #[serde(rename = "treeChildrenBucketCount")]
    pub tree_children_bucket_count: u32,
    #[serde(rename = "aliasBucketCount")]
    pub alias_bucket_count: u32,
    #[serde(rename = "targetRawShardBytes")]
    pub target_raw_shard_bytes: usize,
    #[serde(rename = "searchPrefixLength")]
    pub search_prefix_length: u32,
    #[serde(rename = "kindIndex")]
    pub kind_index: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostedNodeDetail {
    pub node: Node,
    pub edges: Vec<Edge>,
    #[serde(rename = "relatedNodes")]
    pub related_nodes: Vec<Node>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostedNodeViewEntry {
    pub detail: HostedNodeDetail,
    pub ancestors: Vec<NodeSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostedNodeViewShard {
    pub schema_version: u32,
    pub name: String,
    pub version: String,
    pub bucket: String,
    #[serde(rename = "bucketCount")]
    pub bucket_count: u32,
    pub entries: BTreeMap<String, HostedNodeViewEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostedTreeChildrenParentEntry {
    pub parent: NodeSummary,
    pub children: Vec<TreeNodeDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostedTreeChildrenShard {
    pub schema_version: u32,
    pub name: String,
    pub version: String,
    pub bucket: String,
    #[serde(rename = "bucketCount")]
    pub bucket_count: u32,
    pub parents: BTreeMap<String, HostedTreeChildrenParentEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostedKindShard {
    pub schema_version: u32,
    pub name: String,
    pub version: String,
    pub kind: NodeKind,
    pub entries: Vec<NodeSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostedAliasEntry {
    #[serde(rename = "canonicalId")]
    pub canonical_id: String,
    #[serde(rename = "canonicalPath")]
    pub canonical_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostedAliasShard {
    pub schema_version: u32,
    pub name: String,
    pub version: String,
    pub bucket: String,
    #[serde(rename = "bucketCount")]
    pub bucket_count: u32,
    pub aliases: BTreeMap<String, HostedAliasEntry>,
}

pub fn build_all(graph: &CrateGraph, storage_name: &str) -> anyhow::Result<HostedArtifactSet> {
    build_with_config(graph, storage_name, HostedArtifactConfig::default())
}

pub fn meta_key(storage_name: &str, version: &str) -> String {
    format!("rust/{storage_name}/{version}/{SITE_DIR}/meta.json")
}

pub fn build_with_config(
    graph: &CrateGraph,
    storage_name: &str,
    config: HostedArtifactConfig,
) -> anyhow::Result<HostedArtifactSet> {
    let prefix = format!("rust/{storage_name}/{}/{SITE_DIR}", graph.version);
    let nodes_by_id: HashMap<&str, &Node> = graph
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect();
    let (children_map, parents) = super::shards::build_tree_relations(graph);

    let node_entries = build_node_view_entries(graph, &nodes_by_id, &parents)?;
    let node_view_total_raw_bytes: usize = node_entries.iter().map(|entry| entry.raw_bytes).sum();
    let node_view_entry_count = node_entries.len();
    let largest_entry = node_entries
        .iter()
        .max_by_key(|entry| entry.raw_bytes)
        .map(|entry| (entry.node_id.clone(), entry.raw_bytes));
    let node_view_bucket_count = if node_entries.is_empty() {
        0
    } else {
        adaptive_bucket_count(
            node_view_total_raw_bytes,
            config.target_raw_shard_bytes,
            config.min_node_view_buckets,
            config.max_node_view_buckets,
        )
    };
    let (node_view_shards, largest_bucket_raw_bytes) = if node_view_bucket_count == 0 {
        (BTreeMap::new(), 0)
    } else {
        build_node_view_shards(
            graph,
            storage_name,
            node_view_bucket_count,
            node_entries
                .into_iter()
                .map(|entry| (entry.node_id, entry.value)),
        )?
    };
    let tree_shards = build_tree_shards(
        graph,
        storage_name,
        config.tree_children_buckets,
        &children_map,
        &nodes_by_id,
    );
    let meta = build_meta(
        graph,
        storage_name,
        &config,
        node_view_bucket_count,
        &children_map,
        &parents,
        &nodes_by_id,
    );
    let (search_manifest, search_shards) = build_search_shards(graph, storage_name);
    let kind_shards = build_kind_shards(graph, storage_name);
    let alias_shards = build_alias_shards(graph, storage_name, config.alias_buckets);

    let mut artifacts = Vec::new();
    push_json(&mut artifacts, format!("{prefix}/meta.json"), &meta)?;

    for (bucket, shard) in node_view_shards {
        push_json(
            &mut artifacts,
            format!("{prefix}/node-views/{bucket}.json"),
            &shard,
        )?;
    }
    for (bucket, shard) in tree_shards {
        push_json(
            &mut artifacts,
            format!("{prefix}/tree-children/{bucket}.json"),
            &shard,
        )?;
    }
    push_json(
        &mut artifacts,
        format!("{prefix}/search-manifest.json"),
        &search_manifest,
    )?;
    for (prefix_key, shard) in search_shards {
        push_json(
            &mut artifacts,
            format!("{prefix}/search/{prefix_key}.json"),
            &shard,
        )?;
    }
    let kind_index_entry_count: usize = kind_shards.values().map(|shard| shard.entries.len()).sum();
    let kind_index_kind_count = kind_shards.len();
    for (kind_key, shard) in kind_shards {
        push_json(
            &mut artifacts,
            format!("{prefix}/kinds/{kind_key}.json"),
            &shard,
        )?;
    }
    for (bucket, shard) in alias_shards {
        push_json(
            &mut artifacts,
            format!("{prefix}/aliases/{bucket}.json"),
            &shard,
        )?;
    }

    let report_key = format!("{prefix}/report.json");
    let base_artifact_total_raw_bytes: usize =
        artifacts.iter().map(|artifact| artifact.body.len()).sum();
    let mut report = HostedBuildReport {
        node_view_entries: node_view_entry_count,
        node_view_total_raw_bytes,
        node_view_largest_entry_raw_bytes: largest_entry.as_ref().map_or(0, |(_, bytes)| *bytes),
        node_view_largest_entry_id: largest_entry.map(|(id, _)| id),
        node_view_bucket_count,
        node_view_largest_bucket_raw_bytes: largest_bucket_raw_bytes,
        tree_bucket_count: config.tree_children_buckets,
        alias_count: graph.aliases.len(),
        alias_bucket_count: config.alias_buckets,
        search_prefix_count: search_manifest.prefixes.len(),
        kind_index_kind_count,
        kind_index_entry_count,
        artifact_total_raw_bytes: base_artifact_total_raw_bytes,
    };
    let report_body = loop {
        let body =
            serde_json::to_vec(&report).with_context(|| format!("serialize {report_key}"))?;
        let total = base_artifact_total_raw_bytes + body.len();
        if report.artifact_total_raw_bytes == total {
            break body;
        }
        report.artifact_total_raw_bytes = total;
    };
    artifacts.push(Artifact {
        key: report_key,
        body: report_body,
        content_type: JSON,
    });

    Ok(HostedArtifactSet { artifacts, report })
}

struct MeasuredNodeEntry {
    node_id: String,
    value: HostedNodeViewEntry,
    raw_bytes: usize,
}

fn build_node_view_entries(
    graph: &CrateGraph,
    nodes_by_id: &HashMap<&str, &Node>,
    parents: &HashMap<String, String>,
) -> anyhow::Result<Vec<MeasuredNodeEntry>> {
    let edge_lookup = EdgeLookup::new(&graph.edges);

    let local_node_count = graph.nodes.iter().filter(|node| !node.is_external).count();
    let mut entries = Vec::with_capacity(local_node_count);
    for node in graph
        .nodes
        .iter()
        .filter(|node| !node.is_external && node.kind != NodeKind::Impl)
    {
        // Second-hop edges from impl blocks → methods/assoc items so the type
        // page can list trait-impl members (signatures + docs) like docs.rs.
        let edges = edge_lookup.page_edges_with_impl_members(node.id.as_str());
        let related_nodes = collect_related(node.id.as_str(), &edges, |endpoint| {
            nodes_by_id.get(endpoint).map(|node| (*node).clone())
        });
        let ancestors = ancestor_summaries(node.id.as_str(), parents, nodes_by_id);
        let value = HostedNodeViewEntry {
            detail: HostedNodeDetail {
                node: node.clone(),
                edges,
                related_nodes,
            },
            ancestors,
        };
        let raw_bytes = serde_json::to_vec(&value)
            .with_context(|| format!("measure hosted node view {}", node.id))?
            .len();
        entries.push(MeasuredNodeEntry {
            node_id: node.id.clone(),
            value,
            raw_bytes,
        });
    }
    Ok(entries)
}

fn build_node_view_shards(
    graph: &CrateGraph,
    storage_name: &str,
    bucket_count: u32,
    entries: impl Iterator<Item = (String, HostedNodeViewEntry)>,
) -> anyhow::Result<(BTreeMap<String, HostedNodeViewShard>, usize)> {
    let mut shards: BTreeMap<String, HostedNodeViewShard> = BTreeMap::new();
    for (node_id, entry) in entries {
        let bucket = node_view_bucket(&node_id, bucket_count);
        let shard = shards
            .entry(bucket.clone())
            .or_insert_with(|| HostedNodeViewShard {
                schema_version: SCHEMA_VERSION,
                name: storage_name.to_string(),
                version: graph.version.clone(),
                bucket: bucket.clone(),
                bucket_count,
                entries: BTreeMap::new(),
            });
        shard.entries.insert(node_id, entry);
    }

    let mut largest_bucket_raw_bytes = 0usize;
    for shard in shards.values() {
        largest_bucket_raw_bytes = largest_bucket_raw_bytes.max(serde_json::to_vec(shard)?.len());
    }
    Ok((shards, largest_bucket_raw_bytes))
}

fn build_tree_shards(
    graph: &CrateGraph,
    storage_name: &str,
    bucket_count: u32,
    children_map: &HashMap<String, Vec<String>>,
    nodes_by_id: &HashMap<&str, &Node>,
) -> BTreeMap<String, HostedTreeChildrenShard> {
    let mut shards: BTreeMap<String, HostedTreeChildrenShard> = BTreeMap::new();
    for (parent_id, child_ids) in children_map {
        let Some(parent_node) = nodes_by_id.get(parent_id.as_str()) else {
            continue;
        };
        if !is_local_page_node(parent_node) {
            continue;
        }
        let children: Vec<TreeNodeDto> = child_ids
            .iter()
            .filter_map(|child_id| {
                nodes_by_id.get(child_id.as_str()).and_then(|node| {
                    if !is_local_page_node(node) {
                        return None;
                    }
                    Some(TreeNodeDto {
                        node: summarise_node(node),
                        has_children: has_local_tree_children(child_id, children_map, nodes_by_id),
                    })
                })
            })
            .collect();
        if children.is_empty() {
            continue;
        }

        let bucket = tree_children_bucket(parent_id, bucket_count);
        let shard = shards
            .entry(bucket.clone())
            .or_insert_with(|| HostedTreeChildrenShard {
                schema_version: SCHEMA_VERSION,
                name: storage_name.to_string(),
                version: graph.version.clone(),
                bucket: bucket.clone(),
                bucket_count,
                parents: BTreeMap::new(),
            });
        shard.parents.insert(
            parent_id.clone(),
            HostedTreeChildrenParentEntry {
                parent: summarise_node(parent_node),
                children,
            },
        );
    }
    shards
}

fn build_kind_shards(graph: &CrateGraph, storage_name: &str) -> BTreeMap<String, HostedKindShard> {
    let mut shards: BTreeMap<String, HostedKindShard> = BTreeMap::new();
    for node in graph.nodes.iter().filter(|node| is_local_page_node(node)) {
        let kind_key = format!("{:?}", node.kind);
        let shard = shards
            .entry(kind_key.clone())
            .or_insert_with(|| HostedKindShard {
                schema_version: SCHEMA_VERSION,
                name: storage_name.to_string(),
                version: graph.version.clone(),
                kind: node.kind,
                entries: Vec::new(),
            });
        shard.entries.push(summarise_node(node));
    }

    for shard in shards.values_mut() {
        shard.entries.sort_by(|a, b| a.id.cmp(&b.id));
    }
    shards
}

fn build_meta(
    graph: &CrateGraph,
    storage_name: &str,
    config: &HostedArtifactConfig,
    node_view_bucket_count: u32,
    children_map: &HashMap<String, Vec<String>>,
    parents: &HashMap<String, String>,
    nodes_by_id: &HashMap<&str, &Node>,
) -> HostedMetaArtifact {
    let root_ids: Vec<String> = super::shards::compute_roots(&graph.nodes, parents)
        .into_iter()
        .filter(|id| {
            nodes_by_id
                .get(id.as_str())
                .is_some_and(|node| is_local_page_node(node))
        })
        .collect();
    let roots = root_ids
        .iter()
        .filter_map(|id| {
            nodes_by_id.get(id.as_str()).map(|node| TreeNodeDto {
                node: summarise_node(node),
                has_children: has_local_tree_children(id, children_map, nodes_by_id),
            })
        })
        .collect();

    let mut root_children = BTreeMap::new();
    for root_id in root_ids {
        let Some(child_ids) = children_map.get(&root_id) else {
            continue;
        };
        let children = child_ids
            .iter()
            .filter_map(|child_id| {
                nodes_by_id.get(child_id.as_str()).and_then(|node| {
                    if !is_local_page_node(node) {
                        return None;
                    }
                    Some(TreeNodeDto {
                        node: summarise_node(node),
                        has_children: has_local_tree_children(child_id, children_map, nodes_by_id),
                    })
                })
            })
            .collect();
        root_children.insert(root_id, children);
    }
    let local_node_count = graph.nodes.iter().filter(|node| !node.is_external).count();
    let mut local_kind_counts = BTreeMap::new();
    for node in graph.nodes.iter().filter(|node| !node.is_external) {
        *local_kind_counts
            .entry(format!("{:?}", node.kind))
            .or_insert(0) += 1;
    }

    HostedMetaArtifact {
        schema_version: SCHEMA_VERSION,
        name: storage_name.to_string(),
        version: graph.version.clone(),
        index: CrateIndex {
            name: storage_name.to_string(),
            version: graph.version.clone(),
            crates: vec![CrateIndexEntry {
                id: graph.id.clone(),
                name: storage_name.to_string(),
                version: graph.version.clone(),
                is_external: false,
            }],
        },
        node_count: local_node_count,
        edge_count: graph.edges.len(),
        kind_counts: local_kind_counts,
        roots,
        root_children,
        hosted_artifacts: HostedArtifactInfo {
            node_view_bucket_count,
            tree_children_bucket_count: config.tree_children_buckets,
            alias_bucket_count: config.alias_buckets,
            target_raw_shard_bytes: config.target_raw_shard_bytes,
            search_prefix_length: 2,
            kind_index: true,
        },
    }
}

fn build_search_shards(
    graph: &CrateGraph,
    storage_name: &str,
) -> (StaticSearchManifest, BTreeMap<String, StaticSearchShard>) {
    let mut shards: BTreeMap<String, StaticSearchShard> = BTreeMap::new();
    for node in graph.nodes.iter().filter(|node| is_searchable_node(node)) {
        let prefix = search_prefix(&node.name);
        let shard = shards
            .entry(prefix.clone())
            .or_insert_with(|| StaticSearchShard {
                schema_version: SCHEMA_VERSION,
                name: storage_name.to_string(),
                version: graph.version.clone(),
                prefix: prefix.clone(),
                entries: Vec::new(),
            });
        shard.entries.push(summarise_node(node));
    }
    (
        StaticSearchManifest {
            schema_version: SCHEMA_VERSION,
            name: storage_name.to_string(),
            version: graph.version.clone(),
            prefixes: shards.keys().cloned().collect(),
        },
        shards,
    )
}

fn build_alias_shards(
    graph: &CrateGraph,
    storage_name: &str,
    bucket_count: u32,
) -> BTreeMap<String, HostedAliasShard> {
    let mut shards: BTreeMap<String, HostedAliasShard> = BTreeMap::new();
    for (public_path, canonical_id) in &graph.aliases {
        let bucket = node_view_bucket(public_path, bucket_count);
        let shard = shards
            .entry(bucket.clone())
            .or_insert_with(|| HostedAliasShard {
                schema_version: SCHEMA_VERSION,
                name: storage_name.to_string(),
                version: graph.version.clone(),
                bucket: bucket.clone(),
                bucket_count,
                aliases: BTreeMap::new(),
            });
        shard.aliases.insert(
            public_path.clone(),
            HostedAliasEntry {
                canonical_id: canonical_id.clone(),
                canonical_path: canonical_id.replace("::", "/"),
            },
        );
    }
    shards
}

fn adaptive_bucket_count(
    total_raw_bytes: usize,
    target_raw_bytes: usize,
    min: u32,
    max: u32,
) -> u32 {
    let target = target_raw_bytes.max(1);
    let needed = total_raw_bytes.div_ceil(target).max(min as usize);
    let count = needed.next_power_of_two().min(max as usize);
    u32::try_from(count).unwrap_or(max)
}

fn push_json<T: Serialize>(
    artifacts: &mut Vec<Artifact>,
    key: String,
    value: &T,
) -> anyhow::Result<()> {
    artifacts.push(Artifact {
        body: serde_json::to_vec(value).with_context(|| format!("serialize {key}"))?,
        key,
        content_type: JSON,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use codeview_core::{Confidence, EdgeKind, NodeKind, Visibility};

    use super::*;

    fn node(id: &str, name: &str, kind: NodeKind) -> Node {
        Node::new(id, name, kind, Visibility::Public)
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

    fn external_node(id: &str, name: &str, kind: NodeKind) -> Node {
        let mut node = node(id, name, kind);
        node.is_external = true;
        node
    }

    fn graph() -> CrateGraph {
        CrateGraph {
            id: "demo".to_string(),
            name: "demo".to_string(),
            version: "1.0.0".to_string(),
            nodes: vec![
                node("demo", "demo", NodeKind::Crate),
                node("demo::Thing", "Thing", NodeKind::Struct),
                node("demo::make", "make", NodeKind::Function),
            ],
            edges: vec![
                edge("demo", "demo::Thing", EdgeKind::Defines),
                edge("demo::make", "demo::Thing", EdgeKind::UsesType),
            ],
            aliases: HashMap::from([("demo::Alias".to_string(), "demo::Thing".to_string())]),
        }
    }

    #[test]
    fn hosted_node_view_inlines_related_nodes() {
        let set = build_all(&graph(), "demo").expect("build hosted artifacts");
        let node_bucket = node_view_bucket("demo::Thing", set.report.node_view_bucket_count);
        let key = format!("rust/demo/1.0.0/site/node-views/{node_bucket}.json");
        let artifact = set
            .artifacts
            .iter()
            .find(|artifact| artifact.key == key)
            .expect("node view shard");
        let shard: HostedNodeViewShard =
            serde_json::from_slice(&artifact.body).expect("deserialize node view shard");
        let entry = shard.entries.get("demo::Thing").expect("node view entry");
        assert_eq!(entry.detail.edges.len(), 2);
        assert_eq!(entry.detail.related_nodes.len(), 2);
        assert!(
            entry
                .detail
                .related_nodes
                .iter()
                .any(|node| node.id == "demo")
        );
        assert!(
            entry
                .detail
                .related_nodes
                .iter()
                .any(|node| node.id == "demo::make")
        );
    }

    #[test]
    fn hosted_tree_shard_contains_parent_summary() {
        let set = build_all(&graph(), "demo").expect("build hosted artifacts");
        let bucket = tree_children_bucket("demo", TREE_CHILDREN_BUCKETS);
        let key = format!("rust/demo/1.0.0/site/tree-children/{bucket}.json");
        let artifact = set
            .artifacts
            .iter()
            .find(|artifact| artifact.key == key)
            .expect("tree shard");
        let shard: HostedTreeChildrenShard =
            serde_json::from_slice(&artifact.body).expect("deserialize tree shard");
        let parent = shard.parents.get("demo").expect("parent entry");
        assert_eq!(parent.parent.id, "demo");
        assert_eq!(parent.children[0].node.id, "demo::Thing");
    }

    #[test]
    fn hosted_alias_shard_maps_public_path_to_canonical_id() {
        let set = build_all(&graph(), "demo").expect("build hosted artifacts");
        let bucket = node_view_bucket("demo::Alias", ALIAS_BUCKETS);
        let key = format!("rust/demo/1.0.0/site/aliases/{bucket}.json");
        let artifact = set
            .artifacts
            .iter()
            .find(|artifact| artifact.key == key)
            .expect("alias shard");
        let shard: HostedAliasShard =
            serde_json::from_slice(&artifact.body).expect("deserialize alias shard");
        assert_eq!(
            shard.aliases["demo::Alias"].canonical_id,
            "demo::Thing".to_string()
        );
    }

    #[test]
    fn hosted_search_skips_external_and_impl_nodes() {
        let mut graph = graph();
        graph
            .nodes
            .push(node("demo::impl-1", "impl Clone for Thing", NodeKind::Impl));
        graph.nodes.push(external_node(
            "core::clone::Clone",
            "Clone",
            NodeKind::Trait,
        ));

        let set = build_all(&graph, "demo").expect("build hosted artifacts");
        let search_ids: Vec<String> = set
            .artifacts
            .iter()
            .filter(|artifact| artifact.key.starts_with("rust/demo/1.0.0/site/search/"))
            .flat_map(|artifact| {
                let shard: StaticSearchShard =
                    serde_json::from_slice(&artifact.body).expect("deserialize search shard");
                shard.entries.into_iter().map(|entry| entry.id)
            })
            .collect();

        assert!(search_ids.contains(&"demo::Thing".to_string()));
        assert!(!search_ids.contains(&"demo::impl-1".to_string()));
        assert!(!search_ids.contains(&"core::clone::Clone".to_string()));
    }

    #[test]
    fn hosted_kind_index_groups_local_nodes_by_kind() {
        let mut graph = graph();
        graph
            .nodes
            .push(node("demo::impl-1", "impl Clone for Thing", NodeKind::Impl));
        graph.nodes.push(external_node(
            "core::clone::Clone",
            "Clone",
            NodeKind::Trait,
        ));

        let set = build_all(&graph, "demo").expect("build hosted artifacts");
        let struct_artifact = set
            .artifacts
            .iter()
            .find(|artifact| artifact.key == "rust/demo/1.0.0/site/kinds/Struct.json")
            .expect("struct kind shard");
        let struct_shard: HostedKindShard =
            serde_json::from_slice(&struct_artifact.body).expect("deserialize kind shard");
        assert_eq!(struct_shard.kind, NodeKind::Struct);
        assert_eq!(struct_shard.entries[0].id, "demo::Thing");

        let impl_artifact = set
            .artifacts
            .iter()
            .find(|artifact| artifact.key == "rust/demo/1.0.0/site/kinds/Impl.json")
            .expect("impl kind shard");
        let impl_shard: HostedKindShard =
            serde_json::from_slice(&impl_artifact.body).expect("deserialize impl shard");
        assert_eq!(impl_shard.entries[0].id, "demo::impl-1");

        assert!(
            set.artifacts
                .iter()
                .all(|artifact| artifact.key != "rust/demo/1.0.0/site/kinds/Trait.json")
        );
        assert_eq!(set.report.kind_index_entry_count, 4);
    }

    #[test]
    fn hosted_node_views_exclude_external_pages_but_keep_full_related_nodes() {
        let mut graph = graph();
        graph.nodes.push(external_node(
            "core::convert::TryFrom",
            "TryFrom",
            NodeKind::Trait,
        ));
        graph.edges.push(edge(
            "demo::Thing",
            "core::convert::TryFrom",
            EdgeKind::UsesType,
        ));

        let set = build_all(&graph, "demo").expect("build hosted artifacts");
        let external_bucket =
            node_view_bucket("core::convert::TryFrom", set.report.node_view_bucket_count);
        let external_key = format!("rust/demo/1.0.0/site/node-views/{external_bucket}.json");
        if let Some(artifact) = set
            .artifacts
            .iter()
            .find(|artifact| artifact.key == external_key)
        {
            let shard: HostedNodeViewShard =
                serde_json::from_slice(&artifact.body).expect("deserialize external bucket");
            assert!(!shard.entries.contains_key("core::convert::TryFrom"));
        }

        let local_bucket = node_view_bucket("demo::Thing", set.report.node_view_bucket_count);
        let local_key = format!("rust/demo/1.0.0/site/node-views/{local_bucket}.json");
        let artifact = set
            .artifacts
            .iter()
            .find(|artifact| artifact.key == local_key)
            .expect("local node view shard");
        let shard: HostedNodeViewShard =
            serde_json::from_slice(&artifact.body).expect("deserialize local bucket");
        let entry = shard.entries.get("demo::Thing").expect("local node entry");
        assert!(
            entry
                .detail
                .related_nodes
                .iter()
                .any(|node| { node.id == "core::convert::TryFrom" && node.is_external })
        );
    }

    #[test]
    fn hosted_node_view_keeps_full_high_fanout_edges() {
        let mut graph = graph();
        let extra_callers = 144;
        for index in 0..extra_callers {
            let id = format!("demo::caller_{index:03}");
            graph.nodes.push(node(&id, "caller", NodeKind::Function));
            graph
                .edges
                .push(edge(&id, "demo::Thing", EdgeKind::UsesType));
        }

        let set = build_all(&graph, "demo").expect("build hosted artifacts");
        let local_bucket = node_view_bucket("demo::Thing", set.report.node_view_bucket_count);
        let local_key = format!("rust/demo/1.0.0/site/node-views/{local_bucket}.json");
        let artifact = set
            .artifacts
            .iter()
            .find(|artifact| artifact.key == local_key)
            .expect("local node view shard");
        let shard: HostedNodeViewShard =
            serde_json::from_slice(&artifact.body).expect("deserialize local bucket");
        let entry = shard.entries.get("demo::Thing").expect("local node entry");

        assert_eq!(entry.detail.edges.len(), 2 + extra_callers);
        assert_eq!(entry.detail.related_nodes.len(), 2 + extra_callers);
        assert!(
            entry
                .detail
                .related_nodes
                .iter()
                .any(|node| node.id == "demo::caller_143"),
            "hosted node views should not drop high-fanout references"
        );
    }

    #[test]
    fn hosted_node_views_are_always_materialized() {
        let config = HostedArtifactConfig {
            target_raw_shard_bytes: 1,
            ..HostedArtifactConfig::default()
        };

        let set = build_with_config(&graph(), "demo", config).expect("build hosted artifacts");
        assert_eq!(set.report.node_view_entries, 3);
        assert!(set.report.node_view_bucket_count > 0);
        assert!(
            set.artifacts
                .iter()
                .any(|artifact| { artifact.key.starts_with("rust/demo/1.0.0/site/node-views/") })
        );

        let meta_artifact = set
            .artifacts
            .iter()
            .find(|artifact| artifact.key == "rust/demo/1.0.0/site/meta.json")
            .expect("hosted meta");
        let meta: HostedMetaArtifact =
            serde_json::from_slice(&meta_artifact.body).expect("deserialize hosted meta");
        assert!(meta.hosted_artifacts.node_view_bucket_count > 0);
    }
}
