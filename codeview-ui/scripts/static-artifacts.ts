import { execFileSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Database } from 'bun:sqlite';
import { Effect } from 'effect';
import {
	buildCrateMapData,
	type CrateMapData,
	type CrateMapOptions,
} from '../src/lib/graph/crate-map';
import { compareNodeLike } from '../src/lib/node-order';

/**
 * Tagged-union Visibility (schema v3+). The `Restricted` variant carries
 * the actual restriction path (e.g. `crate::foo::bar`), so consumers can
 * render `pub(in crate::foo::bar)` instead of a generic "Restricted".
 */
export type Visibility =
	| { kind: 'Public' }
	| { kind: 'Crate' }
	| { kind: 'Restricted'; path: string }
	| { kind: 'Inherited' }
	| { kind: 'Unknown' };
export type NodeKind =
	| 'Crate'
	| 'Module'
	| 'Struct'
	| 'StructField'
	| 'Union'
	| 'Enum'
	| 'Variant'
	| 'Trait'
	| 'TraitAlias'
	| 'Impl'
	| 'Function'
	| 'TypeAlias'
	| 'AssocType'
	| 'Constant'
	| 'AssocConst'
	| 'Static'
	| 'Macro'
	| 'Primitive'
	| 'ExternCrate'
	| 'Import'
	| 'ProcMacro';

export type EdgeKind =
	| 'Contains'
	| 'Defines'
	| 'Implements'
	| 'UsesType'
	| 'CallsStatic'
	| 'CallsRuntime'
	| 'Derives'
	| 'ReExports';

export type Edge = {
	from: string;
	to: string;
	kind: EdgeKind;
	confidence: 'Static' | 'Runtime' | 'Inferred';
	is_glob?: boolean;
};

export type Node = {
	id: string;
	name: string;
	kind: NodeKind;
	visibility: Visibility;
	is_external?: boolean;
	is_deprecated?: boolean;
	impl_trait?: string | null;
	impl_category?: string | null;
	generics?: string[] | null;
	where_clause?: string[] | null;
	bound_links?: Record<string, string>;
	[key: string]: unknown;
};

export type CrateGraph = {
	id: string;
	name: string;
	version: string;
	nodes: Node[];
	edges: Edge[];
};

export type NodeSummary = {
	id: string;
	name: string;
	kind: NodeKind;
	visibility: Visibility;
	is_external?: boolean;
	is_deprecated?: boolean;
	impl_trait?: string | null;
	impl_category?: string | null;
	generics?: string[] | null;
	where_clause?: string[] | null;
	bound_links?: Record<string, string>;
};

export type CrateTree = {
	nodes: NodeSummary[];
	edges: Edge[];
};

export type TreeNodeDTO = {
	node: NodeSummary;
	hasChildren: boolean;
};

export type StaticTreeIndex = {
	schema_version: 1;
	name: string;
	version: string;
	nodes: NodeSummary[];
	children: Record<string, string[]>;
	parents: Record<string, string>;
	roots: string[];
	kindCounts: Record<string, number>;
};

export type StaticTreeMeta = {
	schema_version: 1;
	name: string;
	version: string;
	nodeCount: number;
	edgeCount: number;
	kindCounts: Record<string, number>;
	roots: TreeNodeDTO[];
	rootChildren: Record<string, TreeNodeDTO[]>;
};

export type StaticModuleTreeIndex = {
	schema_version: 1;
	name: string;
	version: string;
	nodes: NodeSummary[];
	children: Record<string, string[]>;
	parents: Record<string, string>;
	roots: string[];
};

export type StaticTreeChildrenShard = {
	schema_version: 1;
	name: string;
	version: string;
	bucket: string;
	parents: Record<string, { parent: NodeSummary; children: TreeNodeDTO[] }>;
};

export type NodeDetail = {
	node: Node;
	edges: Edge[];
	relatedNodes: Node[];
};

export type NodeView = {
	detail: NodeDetail;
	ancestors: NodeSummary[];
};

export type CrateIndex = {
	name: string;
	version: string;
	crates: Array<{ id: string; name: string; version: string; is_external?: boolean }>;
};

export type StaticCrateManifest = {
	schema_version: 1;
	name: string;
	version: string;
	index: CrateIndex;
	nodeCount: number;
	edgeCount: number;
	kindCounts: Record<string, number>;
	roots: TreeNodeDTO[];
	rootChildren: Record<string, TreeNodeDTO[]>;
	/**
	 * Lists of bucket-ids (hex strings like `"00f"`) that actually contain
	 * data. The shard space is fixed at 128 buckets via FNV-1a hash routing,
	 * but small crates only populate 20-40% of them; without this hint the
	 * worker has to issue a GET per shard and discover empties via 404.
	 *
	 * Optional for backwards-compat: artifacts emitted before this field
	 * existed will be missing it; readers should fall back to "any bucket
	 * could exist" probing.
	 */
	populatedShards?: {
		nodes: string[];
		nodeDetails: string[];
		treeChildren: string[];
	};
};

export type StaticNodeShard = {
	schema_version: 1;
	name: string;
	version: string;
	bucket: string;
	nodes: Record<string, Node>;
};

export type StaticNodeDetailEntry = {
	nodeId: string;
	edges: Edge[];
	relatedIds: string[];
	ancestors: NodeSummary[];
};

export type StaticNodeDetailShard = {
	schema_version: 1;
	name: string;
	version: string;
	bucket: string;
	details: Record<string, StaticNodeDetailEntry>;
};

export type StaticSearchManifest = {
	schema_version: 1;
	name: string;
	version: string;
	prefixes: string[];
};

export type StaticSearchShard = {
	schema_version: 1;
	name: string;
	version: string;
	prefix: string;
	entries: NodeSummary[];
};

export type DetailIndex = {
	nodesById: Map<string, Node>;
	edgesByNode: Map<string, Edge[]>;
};

export type Artifact = {
	key: string;
	path: string;
	log?: boolean;
};

export type StaticArtifactOptions = {
	crateName: string;
	storageName: string;
	version: string;
	graph: CrateGraph;
	outDir: string;
	includeCrateMap?: boolean;
	crateMapOptions?: CrateMapOptions;
	nodeDetailConcurrency?: number;
	nodeViewBuckets?: number;
	aliases?: string[];
};

export type WranglerUploadOptions = {
	bucket: string;
	target: 'local' | 'remote';
	persistTo?: string;
	config?: string;
};

export type LocalR2SeedOptions = {
	bucket: string;
	persistTo?: string;
	deletePrefixes?: string[];
};

export type RustParserOptions = {
	jsonPath: string;
	crateName: string;
	version: string;
	outPath: string;
	manifestPath?: string;
	rootFile?: string;
	rustdocName?: string;
	callMode?: 'strict' | 'ambiguous';
};

export type DocsRsDownloadOptions = {
	crateName: string;
	version: string;
	outPath: string;
	target?: string;
	userAgent?: string;
};

const STATIC_SCHEMA_VERSION = 1;
const DEFAULT_NODE_VIEW_BUCKETS = 128;
const DEFAULT_TREE_CHILDREN_BUCKETS = 128;

export function normalizeCrateName(name: string): string {
	return name.replaceAll('-', '_');
}

export function hyphenateCrateName(name: string): string {
	return name.replaceAll('_', '-');
}

export function summarizeNode(node: Node): NodeSummary {
	return {
		id: node.id,
		name: node.name,
		kind: node.kind,
		visibility: node.visibility,
		is_external: node.is_external,
		is_deprecated: node.is_deprecated,
		...(node.kind === 'Impl'
			? {
					impl_trait: node.impl_trait,
					impl_category: node.impl_category,
					generics: node.generics,
					where_clause: node.where_clause,
					bound_links: node.bound_links,
				}
			: {}),
	};
}

export function buildTree(graph: CrateGraph): CrateTree {
	const internalNodes = graph.nodes.filter((node) => !node.is_external);
	const internalIds = new Set(internalNodes.map((node) => node.id));
	const edges = graph.edges.filter(
		(edge) =>
			(edge.kind === 'Contains' || edge.kind === 'Defines') &&
			internalIds.has(edge.from) &&
			internalIds.has(edge.to),
	);
	const crateRoot =
		(internalIds.has(graph.id) ? graph.id : null) ??
		internalNodes.find((node) => node.kind === 'Crate')?.id ??
		null;
	if (!crateRoot) return { nodes: internalNodes.map(summarizeNode), edges };

	const children = new Map<string, string[]>();
	for (const edge of edges) {
		(children.get(edge.from) ?? children.set(edge.from, []).get(edge.from)!).push(edge.to);
	}

	const reachable = new Set<string>();
	const queue = [crateRoot];
	for (let i = 0; i < queue.length; i++) {
		const id = queue[i];
		if (reachable.has(id)) continue;
		reachable.add(id);
		for (const child of children.get(id) ?? []) queue.push(child);
	}

	return {
		nodes: internalNodes.filter((node) => reachable.has(node.id)).map(summarizeNode),
		edges: edges.filter((edge) => reachable.has(edge.from) && reachable.has(edge.to)),
	};
}

export function buildTreeIndex(
	tree: CrateTree,
	options: { storageName: string; version: string },
): StaticTreeIndex {
	const nodesById = new Map(tree.nodes.map((node) => [node.id, node]));
	const children: Record<string, string[]> = {};
	const parents: Record<string, string> = {};
	const kindCounts: Record<string, number> = {};
	const seenChildren = new Set<string>();

	for (const node of tree.nodes) {
		kindCounts[node.kind] = (kindCounts[node.kind] ?? 0) + 1;
	}

	for (const edge of tree.edges) {
		if (edge.kind !== 'Contains' && edge.kind !== 'Defines') continue;
		if (!nodesById.has(edge.from) || !nodesById.has(edge.to)) continue;
		parents[edge.to] ??= edge.from;
		const childKey = `${edge.from}\0${edge.to}`;
		if (seenChildren.has(childKey)) continue;
		seenChildren.add(childKey);
		(children[edge.from] ??= []).push(edge.to);
	}

	const compareIds = (a: string, b: string) => {
		const an = nodesById.get(a);
		const bn = nodesById.get(b);
		if (an && bn) return compareNodeLike(an, bn);
		if (an) return -1;
		if (bn) return 1;
		return a < b ? -1 : a > b ? 1 : 0;
	};
	for (const childIds of Object.values(children)) childIds.sort(compareIds);

	const roots = tree.nodes
		.filter((node) => !parents[node.id])
		.map((node) => node.id)
		.sort(compareIds);
	return {
		schema_version: STATIC_SCHEMA_VERSION,
		name: options.storageName,
		version: options.version,
		nodes: tree.nodes,
		children,
		parents,
		roots,
		kindCounts,
	};
}

export function buildTreeMeta(index: StaticTreeIndex, edgeCount: number): StaticTreeMeta {
	const nodesById = new Map(index.nodes.map((node) => [node.id, node]));
	const nodeDTO = (id: string): TreeNodeDTO | null => {
		const node = nodesById.get(id);
		return node ? { node, hasChildren: (index.children[id]?.length ?? 0) > 0 } : null;
	};
	const roots = index.roots.map(nodeDTO).filter((entry): entry is TreeNodeDTO => entry !== null);
	const rootChildren = Object.fromEntries(
		index.roots.map((id) => [
			id,
			(index.children[id] ?? [])
				.map(nodeDTO)
				.filter((entry): entry is TreeNodeDTO => entry !== null),
		]),
	);
	return {
		schema_version: STATIC_SCHEMA_VERSION,
		name: index.name,
		version: index.version,
		nodeCount: index.nodes.length,
		edgeCount,
		kindCounts: index.kindCounts,
		roots,
		rootChildren,
	};
}

export function buildModuleTreeIndex(index: StaticTreeIndex): StaticModuleTreeIndex {
	const moduleNodes = index.nodes.filter((node) => node.kind === 'Crate' || node.kind === 'Module');
	const moduleIds = new Set(moduleNodes.map((node) => node.id));
	const children: Record<string, string[]> = {};
	const parents: Record<string, string> = {};
	for (const node of moduleNodes) {
		const moduleChildren = (index.children[node.id] ?? []).filter((id) => moduleIds.has(id));
		if (moduleChildren.length > 0) children[node.id] = moduleChildren;
		for (const child of moduleChildren) parents[child] ??= node.id;
	}
	const roots = moduleNodes.filter((node) => !parents[node.id]).map((node) => node.id);
	return {
		schema_version: STATIC_SCHEMA_VERSION,
		name: index.name,
		version: index.version,
		nodes: moduleNodes,
		children,
		parents,
		roots,
	};
}

export function buildTreeChildrenShard(
	index: StaticTreeIndex,
	parentId: string,
): { parent: NodeSummary; children: TreeNodeDTO[] } | null {
	const nodesById = new Map(index.nodes.map((node) => [node.id, node]));
	return buildTreeChildrenShardWithLookup(index, parentId, nodesById);
}

function buildTreeChildrenShardWithLookup(
	index: StaticTreeIndex,
	parentId: string,
	nodesById: Map<string, NodeSummary>,
): { parent: NodeSummary; children: TreeNodeDTO[] } | null {
	const parent = nodesById.get(parentId);
	if (!parent) return null;
	const children = (index.children[parentId] ?? [])
		.map((id) => {
			const node = nodesById.get(id);
			return node ? { node, hasChildren: (index.children[id]?.length ?? 0) > 0 } : null;
		})
		.filter((entry): entry is TreeNodeDTO => entry !== null);
	return {
		parent,
		children,
	};
}

export function buildTreeChildrenShards(
	index: StaticTreeIndex,
	options: { bucketCount?: number } = {},
): Map<string, StaticTreeChildrenShard> {
	const bucketCount = options.bucketCount ?? DEFAULT_TREE_CHILDREN_BUCKETS;
	const nodesById = new Map(index.nodes.map((node) => [node.id, node]));
	const shards = new Map<string, StaticTreeChildrenShard>();
	for (const parentId of Object.keys(index.children)) {
		const entry = buildTreeChildrenShardWithLookup(index, parentId, nodesById);
		if (!entry || entry.children.length === 0) continue;
		const bucket = treeChildrenBucket(parentId, bucketCount);
		let shard = shards.get(bucket);
		if (!shard) {
			shard = {
				schema_version: STATIC_SCHEMA_VERSION,
				name: index.name,
				version: index.version,
				bucket,
				parents: {},
			};
			shards.set(bucket, shard);
		}
		shard.parents[parentId] = entry;
	}
	return shards;
}

export function buildCrateManifest(
	index: StaticTreeIndex,
	edgeCount: number,
	crateIndex: CrateIndex,
	populatedShards?: StaticCrateManifest['populatedShards'],
): StaticCrateManifest {
	const meta = buildTreeMeta(index, edgeCount);
	return {
		schema_version: STATIC_SCHEMA_VERSION,
		name: index.name,
		version: index.version,
		index: crateIndex,
		nodeCount: index.nodes.length,
		edgeCount,
		kindCounts: index.kindCounts,
		roots: meta.roots,
		rootChildren: meta.rootChildren,
		...(populatedShards ? { populatedShards } : {}),
	};
}

export function buildAncestors(index: StaticTreeIndex, nodeId: string): NodeSummary[] {
	const nodesById = new Map(index.nodes.map((node) => [node.id, node]));
	return buildAncestorsWithLookup(index, nodeId, nodesById, new Map());
}

function buildAncestorsWithLookup(
	index: StaticTreeIndex,
	nodeId: string,
	nodesById: Map<string, NodeSummary>,
	memo: Map<string, NodeSummary[]>,
): NodeSummary[] {
	const cached = memo.get(nodeId);
	if (cached !== undefined) return cached;

	const ancestors: NodeSummary[] = [];
	const seen = new Set<string>();
	let cursor = index.parents[nodeId];
	while (cursor && !seen.has(cursor)) {
		const cachedParent = memo.get(cursor);
		if (cachedParent !== undefined) {
			const node = nodesById.get(cursor);
			ancestors.unshift(...cachedParent, ...(node ? [node] : []));
			break;
		}
		seen.add(cursor);
		const node = nodesById.get(cursor);
		if (node) ancestors.unshift(node);
		cursor = index.parents[cursor];
	}
	memo.set(nodeId, ancestors);
	return ancestors;
}

function fnv1a32(value: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i += 1) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash >>> 0;
}

export function nodeViewBucket(nodeId: string, bucketCount = DEFAULT_NODE_VIEW_BUCKETS): string {
	const bucket = fnv1a32(nodeId) % bucketCount;
	const width = Math.max(3, (bucketCount - 1).toString(16).length);
	return bucket.toString(16).padStart(width, '0');
}

export function treeChildrenBucket(
	parentId: string,
	bucketCount = DEFAULT_TREE_CHILDREN_BUCKETS,
): string {
	const bucket = fnv1a32(parentId) % bucketCount;
	const width = Math.max(3, (bucketCount - 1).toString(16).length);
	return bucket.toString(16).padStart(width, '0');
}

/**
 * Two-character shard prefix. Spreads the cardinality of search shards
 * across 26² + minor chars (vs. 27 single-char buckets), so highly-skewed
 * crates like `windows-sys` (single letter `i` was 5.4 MB) split into
 * `ip` / `is` / `im` / etc. of ~200 KB each.
 *
 * For names shorter than 2 chars, pad with `_` so every shard key is
 * exactly 2 chars. Query-side reads use `startsWith(queryPrefix)` so
 * 1-character queries fan out into multiple shards.
 */
function searchPrefix(value: string): string {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_]/g, '_');
	const ch0 = normalized[0] ?? '_';
	const ch1 = normalized[1] ?? '_';
	return ch0 + ch1;
}

export function buildNodeShards(options: {
	graph: CrateGraph;
	name: string;
	version: string;
	bucketCount?: number;
}): Map<string, StaticNodeShard> {
	const bucketCount = options.bucketCount ?? DEFAULT_NODE_VIEW_BUCKETS;
	const shards = new Map<string, StaticNodeShard>();
	for (const node of options.graph.nodes) {
		const bucket = nodeViewBucket(node.id, bucketCount);
		let shard = shards.get(bucket);
		if (!shard) {
			shard = {
				schema_version: STATIC_SCHEMA_VERSION,
				name: options.name,
				version: options.version,
				bucket,
				nodes: {},
			};
			shards.set(bucket, shard);
		}
		shard.nodes[node.id] = node;
	}
	return shards;
}

export function buildNodeDetailShards(options: {
	graph: CrateGraph;
	treeIndex: StaticTreeIndex;
	bucketCount?: number;
}): Map<string, StaticNodeDetailShard> {
	const bucketCount = options.bucketCount ?? DEFAULT_NODE_VIEW_BUCKETS;
	const detailIndex = buildDetailIndex(options.graph);
	const routeableIds = new Set(options.treeIndex.nodes.map((node) => node.id));
	const treeNodesById = new Map(options.treeIndex.nodes.map((node) => [node.id, node]));
	const ancestorMemo = new Map<string, NodeSummary[]>();
	const shards = new Map<string, StaticNodeDetailShard>();
	for (const node of options.graph.nodes) {
		if (!routeableIds.has(node.id)) continue;
		const detail = buildNodeDetail(detailIndex, node.id);
		if (!detail) continue;
		const bucket = nodeViewBucket(node.id, bucketCount);
		let shard = shards.get(bucket);
		if (!shard) {
			shard = {
				schema_version: STATIC_SCHEMA_VERSION,
				name: options.treeIndex.name,
				version: options.treeIndex.version,
				bucket,
				details: {},
			};
			shards.set(bucket, shard);
		}
		shard.details[node.id] = {
			nodeId: node.id,
			edges: detail.edges,
			relatedIds: detail.relatedNodes.map((related) => related.id),
			ancestors: buildAncestorsWithLookup(options.treeIndex, node.id, treeNodesById, ancestorMemo),
		};
	}
	return shards;
}

export function buildSearchShards(index: StaticTreeIndex): {
	manifest: StaticSearchManifest;
	shards: Map<string, StaticSearchShard>;
} {
	const shards = new Map<string, StaticSearchShard>();
	for (const entry of index.nodes) {
		const prefix = searchPrefix(entry.name);
		let shard = shards.get(prefix);
		if (!shard) {
			shard = {
				schema_version: STATIC_SCHEMA_VERSION,
				name: index.name,
				version: index.version,
				prefix,
				entries: [],
			};
			shards.set(prefix, shard);
		}
		shard.entries.push(entry);
	}
	return {
		manifest: {
			schema_version: STATIC_SCHEMA_VERSION,
			name: index.name,
			version: index.version,
			prefixes: Array.from(shards.keys()).sort(),
		},
		shards,
	};
}

export function validateStaticArtifacts(graph: CrateGraph, tree: CrateTree): void {
	const internalCount = graph.nodes.filter((node) => !node.is_external).length;
	const externalCount = graph.nodes.length - internalCount;
	if (graph.nodes.length > 1 && internalCount <= 1 && externalCount > 0) {
		throw new Error(
			`Refusing to publish ${graph.name}@${graph.version}: graph has ${graph.nodes.length} nodes but only ${internalCount} internal node. Use docs.rs rustdoc JSON or enable crate features before publishing.`,
		);
	}
	if (tree.nodes.length > 1 && tree.edges.length === 0) {
		throw new Error(
			`Refusing to publish ${graph.name}@${graph.version}: tree has ${tree.nodes.length} nodes but no structural edges.`,
		);
	}
}

export function buildDetailIndex(graph: CrateGraph): DetailIndex {
	const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
	const edgesByNode = new Map<string, Edge[]>();
	for (const edge of graph.edges) {
		for (const id of [edge.from, edge.to]) {
			const list = edgesByNode.get(id) ?? [];
			list.push(edge);
			edgesByNode.set(id, list);
		}
	}
	return { nodesById, edgesByNode };
}

export function buildNodeDetail(index: DetailIndex, nodeId: string): NodeDetail | null {
	const node = index.nodesById.get(nodeId);
	if (!node) return null;

	const nodeEdges = index.edgesByNode.get(nodeId) ?? [];
	const allEdges: Edge[] = [];
	const edgeSet = new Set<string>();
	const typeKinds = new Set<NodeKind>([
		'Struct',
		'Enum',
		'Union',
		'Trait',
		'TraitAlias',
		'TypeAlias',
	]);
	const containerKinds = new Set<NodeKind>(['Crate', 'Module']);

	const addEdge = (edge: Edge) => {
		const key = `${edge.from}|${edge.to}|${edge.kind}`;
		if (edgeSet.has(key)) return;
		allEdges.push(edge);
		edgeSet.add(key);
	};

	for (const edge of nodeEdges) {
		if (
			containerKinds.has(node.kind) &&
			(edge.kind === 'Contains' || edge.kind === 'Defines') &&
			edge.from === nodeId
		) {
			continue;
		}
		addEdge(edge);
	}

	if (typeKinds.has(node.kind)) {
		for (const edge of nodeEdges) {
			if (edge.kind !== 'Defines' || edge.from !== nodeId) continue;
			for (const implEdge of index.edgesByNode.get(edge.to) ?? []) {
				addEdge(implEdge);
			}
		}
	}

	const relatedIds = new Set<string>();
	for (const edge of allEdges) {
		if (edge.from !== nodeId) relatedIds.add(edge.from);
		if (edge.to !== nodeId) relatedIds.add(edge.to);
	}

	const relatedNodes: Node[] = [];
	for (const id of relatedIds) {
		const related = index.nodesById.get(id);
		if (related) relatedNodes.push(related);
	}

	return { node, edges: allEdges, relatedNodes };
}

export async function mapWithConcurrency<T>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
	await Effect.runPromise(
		Effect.forEach(
			items,
			(item, index) =>
				Effect.tryPromise({
					try: () => fn(item, index),
					catch: (cause) => cause,
				}),
			{ concurrency: Math.max(1, Math.min(limit, items.length)), discard: true },
		),
	);
}

export function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, gzipSync(JSON.stringify(value), { level: 9 }));
}

export function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

export function artifactFile(outDir: string, relative: string): string {
	return join(outDir, ...relative.split('/'));
}

export async function buildStaticArtifacts(options: StaticArtifactOptions): Promise<Artifact[]> {
	const {
		crateName,
		storageName,
		version,
		graph,
		outDir,
		includeCrateMap = true,
		crateMapOptions = { maxHierarchyModules: 180, maxMatrixModules: 24 },
		nodeViewBuckets = DEFAULT_NODE_VIEW_BUCKETS,
		aliases = ['latest'],
	} = options;
	const prefix = `rust/${storageName}/${version}`;
	const tree = buildTree(graph);
	validateStaticArtifacts(graph, tree);
	const treeIndex = buildTreeIndex(tree, { storageName, version });
	const crateMap = includeCrateMap ? buildCrateMapData(graph, crateName, crateMapOptions) : null;
	const index: CrateIndex = {
		name: storageName,
		version,
		crates: [{ id: graph.id, name: storageName, version, is_external: false }],
	};
	const artifacts: Artifact[] = [];

	// Build all shards first so we can capture the actual populated-bucket
	// lists into the manifest. The worker uses these lists to skip empty
	// shards (small crates leave 60-80% of the 128-bucket space empty).
	const treeChildrenShards = buildTreeChildrenShards(treeIndex);
	const nodeShards = buildNodeShards({
		graph,
		name: storageName,
		version,
		bucketCount: nodeViewBuckets,
	});
	const nodeDetailShards = buildNodeDetailShards({
		graph,
		treeIndex,
		bucketCount: nodeViewBuckets,
	});

	const populatedShards: NonNullable<StaticCrateManifest['populatedShards']> = {
		nodes: Array.from(nodeShards.keys()).sort(),
		nodeDetails: Array.from(nodeDetailShards.keys()).sort(),
		treeChildren: Array.from(treeChildrenShards.keys()).sort(),
	};

	const manifest = buildCrateManifest(treeIndex, tree.edges.length, index, populatedShards);
	writeJson(artifactFile(outDir, 'manifest.json'), manifest);
	artifacts.push({ key: `${prefix}/manifest.json`, path: artifactFile(outDir, 'manifest.json') });

	// Path aliases — used by URL routing to resolve public re-export paths
	// (e.g. `core::async_iter::AsyncIterator`) to their canonical node IDs
	// (`core::async_iter::async_iter::AsyncIterator`). Tiny so it stays inline
	// rather than sharded.
	const aliasesMap = (graph as { aliases?: Record<string, string> }).aliases ?? {};
	if (Object.keys(aliasesMap).length > 0) {
		const aliasesPath = artifactFile(outDir, 'aliases.json');
		writeJson(aliasesPath, aliasesMap);
		artifacts.push({ key: `${prefix}/aliases.json`, path: aliasesPath });
	}

	for (const [bucket, shard] of treeChildrenShards) {
		const relativePath = `tree-children/${bucket}.json`;
		const path = artifactFile(outDir, relativePath);
		writeJson(path, shard);
		artifacts.push({ key: `${prefix}/${relativePath}`, path, log: false });
	}
	for (const [bucket, shard] of nodeShards) {
		const relativePath = `nodes/${bucket}.json`;
		const path = artifactFile(outDir, relativePath);
		writeJson(path, shard);
		artifacts.push({ key: `${prefix}/${relativePath}`, path, log: false });
	}
	for (const [bucket, shard] of nodeDetailShards) {
		const relativePath = `node-details/${bucket}.json`;
		const path = artifactFile(outDir, relativePath);
		writeJson(path, shard);
		artifacts.push({ key: `${prefix}/${relativePath}`, path, log: false });
	}

	const search = buildSearchShards(treeIndex);
	writeJson(artifactFile(outDir, 'search-manifest.json'), search.manifest);
	artifacts.push({
		key: `${prefix}/search-manifest.json`,
		path: artifactFile(outDir, 'search-manifest.json'),
	});
	for (const [searchShardPrefix, shard] of search.shards) {
		const relativePath = `search/${searchShardPrefix}.json`;
		const path = artifactFile(outDir, relativePath);
		writeJson(path, shard);
		artifacts.push({ key: `${prefix}/${relativePath}`, path, log: false });
	}

	if (crateMap) {
		writeJson(artifactFile(outDir, 'crate-map.json'), crateMap satisfies CrateMapData);
		artifacts.push({
			key: `${prefix}/crate-map.json`,
			path: artifactFile(outDir, 'crate-map.json'),
		});
	}

	for (const alias of aliases) {
		const path = artifactFile(outDir, `${alias}.json`);
		writeJson(path, { version });
		artifacts.push({ key: `rust/${storageName}/${alias}.json`, path });
	}

	console.log(
		`built ${crateName}@${version}: ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${nodeShards.size} node shards, ${nodeDetailShards.size} detail shards`,
	);
	return artifacts;
}

export async function downloadDocsRsRustdocJson(
	options: DocsRsDownloadOptions,
): Promise<{ path: string; url: string; compressedBytes: number; jsonBytes: number }> {
	mkdirSync(dirname(options.outPath), { recursive: true });
	const target = options.target ? `/${options.target}` : '';
	const url = `https://docs.rs/crate/${options.crateName}/${options.version}${target}/json.gz`;
	if (existsSync(options.outPath)) {
		return {
			path: options.outPath,
			url,
			compressedBytes: 0,
			jsonBytes: readFileSync(options.outPath).length,
		};
	}
	const response = await fetch(url, {
		headers: {
			'User-Agent': options.userAgent ?? 'codeview-static-publisher (local QA)',
		},
	});
	if (!response.ok) {
		throw new Error(`docs.rs rustdoc JSON fetch failed: ${response.status} ${response.statusText}`);
	}
	const compressed = Buffer.from(await response.arrayBuffer());
	const json =
		compressed[0] === 0x1f && compressed[1] === 0x8b ? gunzipSync(compressed) : compressed;
	writeFileSync(options.outPath, json);
	return { path: options.outPath, url, compressedBytes: compressed.length, jsonBytes: json.length };
}

export function uploadArtifactWithWrangler(
	artifact: Artifact,
	options: WranglerUploadOptions,
): void {
	const args = [
		'run',
		'wrangler',
		'r2',
		'object',
		'put',
		`${options.bucket}/${artifact.key}`,
		'--file',
		artifact.path,
		'--content-type',
		'application/json; charset=utf-8',
		'--config',
		options.config ?? './wrangler.toml',
	];
	if (options.target === 'local') {
		args.push('--local', '--persist-to', options.persistTo ?? '.wrangler/state/v3');
	} else {
		args.push('--remote');
	}
	execFileSync('bun', args, { stdio: artifact.log === false ? 'ignore' : 'inherit' });
}

const MINIFLARE_R2_OBJECT_CLASS = 'R2BucketObject';
const MINIFLARE_R2_OBJECT_UNIQUE_KEY = `miniflare-${MINIFLARE_R2_OBJECT_CLASS}`;
const MINIFLARE_R2_SQL = `
CREATE TABLE IF NOT EXISTS _mf_objects (
    key TEXT PRIMARY KEY,
    blob_id TEXT,
    version TEXT NOT NULL,
    size INTEGER NOT NULL,
    etag TEXT NOT NULL,
    uploaded INTEGER NOT NULL,
    checksums TEXT NOT NULL,
    http_metadata TEXT NOT NULL,
    custom_metadata TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS _mf_multipart_uploads (
    upload_id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    http_metadata TEXT NOT NULL,
    custom_metadata TEXT NOT NULL,
    state TINYINT DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS _mf_multipart_parts (
    upload_id TEXT NOT NULL REFERENCES _mf_multipart_uploads(upload_id),
    part_number INTEGER NOT NULL,
    blob_id TEXT NOT NULL,
    size INTEGER NOT NULL,
    etag TEXT NOT NULL,
    checksum_md5 TEXT NOT NULL,
    object_key TEXT REFERENCES _mf_objects(key) DEFERRABLE INITIALLY DEFERRED,
    PRIMARY KEY (upload_id, part_number)
);
`;

function durableObjectNamespaceIdFromName(uniqueKey: string, name: string): string {
	const key = createHash('sha256').update(uniqueKey).digest();
	const nameHmac = createHmac('sha256', key).update(name).digest().subarray(0, 16);
	const hmac = createHmac('sha256', key).update(nameHmac).digest().subarray(0, 16);
	return Buffer.concat([nameHmac, hmac]).toString('hex');
}

function generateLocalR2BlobId(): string {
	const random = randomBytes(32);
	const timestamp = Buffer.alloc(8);
	timestamp.writeBigInt64BE(BigInt(Date.now()));
	return Buffer.concat([random, timestamp]).toString('hex');
}

function generateLocalR2Version(): string {
	return randomBytes(16).toString('hex');
}

function localR2Paths(options: LocalR2SeedOptions): { blobDir: string; sqlitePath: string } {
	const persistTo = options.persistTo ?? '.wrangler/state/v3';
	const r2Root = join(persistTo, 'v3', 'r2');
	const objectDir = join(r2Root, MINIFLARE_R2_OBJECT_UNIQUE_KEY);
	const bucketObjectId = durableObjectNamespaceIdFromName(
		MINIFLARE_R2_OBJECT_UNIQUE_KEY,
		options.bucket,
	);
	return {
		blobDir: join(r2Root, options.bucket, 'blobs'),
		sqlitePath: join(objectDir, `${bucketObjectId}.sqlite`),
	};
}

export function seedLocalR2Artifacts(artifacts: Artifact[], options: LocalR2SeedOptions): void {
	const { blobDir, sqlitePath } = localR2Paths(options);
	mkdirSync(blobDir, { recursive: true });
	mkdirSync(dirname(sqlitePath), { recursive: true });

	const db = new Database(sqlitePath);
	db.exec(MINIFLARE_R2_SQL);

	const selectPrefix = db.query<{ blob_id: string | null }, [string]>(
		'SELECT blob_id FROM _mf_objects WHERE substr(key, 1, length(?1)) = ?1',
	);
	const deletePrefix = db.query<unknown, [string]>(
		'DELETE FROM _mf_objects WHERE substr(key, 1, length(?1)) = ?1',
	);
	const upsert = db.query<
		unknown,
		[string, string, string, number, string, number, string, string, string]
	>(`
		INSERT OR REPLACE INTO _mf_objects (
			key,
			blob_id,
			version,
			size,
			etag,
			uploaded,
			checksums,
			http_metadata,
			custom_metadata
		)
		VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
	`);

	const removeBlob = (blobId: string | null): void => {
		if (!blobId) return;
		const path = join(blobDir, blobId);
		if (existsSync(path)) unlinkSync(path);
	};

	const deletedPrefixes = new Set(options.deletePrefixes ?? []);
	db.transaction(() => {
		for (const prefix of deletedPrefixes) {
			for (const row of selectPrefix.all(prefix)) removeBlob(row.blob_id);
			deletePrefix.run(prefix);
		}

		for (const artifact of artifacts) {
			const bytes = readFileSync(artifact.path);
			const blobId = generateLocalR2BlobId();
			const existing = db
				.query<
					{ blob_id: string | null },
					[string]
				>('SELECT blob_id FROM _mf_objects WHERE key = ?1')
				.get(artifact.key);
			removeBlob(existing?.blob_id ?? null);
			writeFileSync(join(blobDir, blobId), bytes);
			upsert.run(
				artifact.key,
				blobId,
				generateLocalR2Version(),
				bytes.length,
				createHash('md5').update(bytes).digest('hex'),
				Date.now(),
				'{}',
				JSON.stringify({ contentType: 'application/json; charset=utf-8' }),
				'{}',
			);
		}
	})();

	db.close();
}

export function runRustParser(options: RustParserOptions): CrateGraph {
	mkdirSync(dirname(options.outPath), { recursive: true });
	const args = [
		'run',
		'--manifest-path',
		'../Cargo.toml',
		'-p',
		'codeview-cli',
		'--',
		'parse-json',
		'--json',
		options.jsonPath,
		'--crate-name',
		options.crateName,
		'--version',
		options.version,
		'--out',
		options.outPath,
		'--call-mode',
		options.callMode ?? 'strict',
	];
	if (options.manifestPath && options.rootFile) {
		args.push('--manifest-path', options.manifestPath, '--root-file', options.rootFile);
	}
	if (options.rustdocName) {
		args.push('--rustdoc-name', options.rustdocName);
	}
	execFileSync('cargo', args, {
		env: { ...process.env, CODEVIEW_SKIP_SIDECAR: '1' },
		stdio: 'inherit',
	});
	return readJson<CrateGraph>(options.outPath);
}
