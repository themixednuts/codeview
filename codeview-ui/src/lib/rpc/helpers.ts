import { getRequestEvent } from '$app/server';
import { initProvider } from '$lib/server/provider';
import { perf } from '$lib/perf';
import { isHosted } from '$lib/platform';
import { normalizeCrateName, hyphenateCrateName } from '$lib/crate-names';
import { TreeIndex } from '$lib/graph/tree-index';
import type { Node, Edge, Workspace } from '$lib/graph';
import type { NodeSummary, CrateTree, NodeDetail, CrateMeta, TreeNodeDTO, NodeView } from '$lib/schema';
import { getLogger } from '$lib/log';
import type { NodeViewInput } from './schemas';

const log = getLogger('rpc.helpers');


export type Provider = Awaited<ReturnType<typeof initProvider>>;
export type NodeDetailInput = {
	nodeId: string;
	version?: string;
	refresh?: number;
};

export type TreeMode = 'structural' | 'complete';

// ── Tree utilities ─────────────────────────────────────────────────────

interface TreeOps {
	canonicalize(
		name: string,
		crateTree: CrateTree,
		options?: { mode?: TreeMode; includeExternal?: boolean },
	): CrateTree;
	kindCounts(idx: TreeIndex): Record<string, number>;
}

export const tree = {
	canonicalize(
		name: string,
		crateTree: CrateTree,
		options?: { mode?: TreeMode; includeExternal?: boolean },
	): CrateTree {
		const mode = options?.mode ?? 'structural';
		const includeExternal = options?.includeExternal ?? false;
		const normalizedName = normalizeCrateName(name);
		const structuralOnly = mode === 'structural';
		const allowedNodeIds = new Set<string>();
		const nodeById = new Map(crateTree.nodes.map((n) => [n.id, n]));
		const outEdges: CrateTree['edges'] = [];
		const parentByChild = structuralOnly ? new Map<string, string>() : null;

		for (const edge of crateTree.edges) {
			if (structuralOnly && edge.kind !== 'Contains' && edge.kind !== 'Defines') continue;
			const from = nodeById.get(edge.from);
			const to = nodeById.get(edge.to);
			if (!from || !to) continue;
			if (!includeExternal && (from.is_external || to.is_external)) continue;
			if (parentByChild && !parentByChild.has(edge.to)) parentByChild.set(edge.to, edge.from);
			allowedNodeIds.add(edge.from);
			allowedNodeIds.add(edge.to);
			outEdges.push(edge);
		}

		if (structuralOnly && parentByChild) {
			const preferredRoot = nodeById.has(normalizedName)
				? normalizedName
				: nodeById.has(name)
					? name
					: null;
			const crateRoot =
				preferredRoot ??
				crateTree.nodes.find((node) => node.kind === 'Crate' && (!node.is_external || includeExternal))?.id ??
				null;

			if (crateRoot) {
				const reachMemo = new Map<string, boolean>();
				reachMemo.set(crateRoot, true);

				const isReachableFromRoot = (startId: string): boolean => {
					const cached = reachMemo.get(startId);
					if (cached !== undefined) return cached;

					const path: string[] = [];
					const seen = new Set<string>();
					let current = startId;

					while (true) {
						const memoized = reachMemo.get(current);
						if (memoized !== undefined) {
							for (const id of path) reachMemo.set(id, memoized);
							return memoized;
						}
						if (current === crateRoot) {
							for (const id of path) reachMemo.set(id, true);
							reachMemo.set(current, true);
							return true;
						}
						if (seen.has(current)) {
							for (const id of path) reachMemo.set(id, false);
							return false;
						}
						seen.add(current);
						path.push(current);

						const parent = parentByChild.get(current);
						if (!parent) {
							for (const id of path) reachMemo.set(id, false);
							return false;
						}
						current = parent;
					}
				};

				const prunedEdges = outEdges.filter(
					(edge) => isReachableFromRoot(edge.from) && isReachableFromRoot(edge.to),
				);

				allowedNodeIds.clear();
				for (const edge of prunedEdges) {
					allowedNodeIds.add(edge.from);
					allowedNodeIds.add(edge.to);
				}
				allowedNodeIds.add(crateRoot);

				outEdges.length = 0;
				for (const edge of prunedEdges) outEdges.push(edge);
			}
		}

		if (structuralOnly) {
			if (nodeById.has(name)) allowedNodeIds.add(name);
			if (nodeById.has(normalizedName)) allowedNodeIds.add(normalizedName);
		}

		const outNodes: CrateTree['nodes'] = [];
		for (const node of crateTree.nodes) {
			if (!includeExternal && node.is_external) continue;
			if (structuralOnly && !allowedNodeIds.has(node.id)) continue;
			outNodes.push(node);
		}

		return { nodes: outNodes, edges: outEdges };
	},

	kindCounts(idx: TreeIndex): Record<string, number> {
		const counts: Record<string, number> = {};
		for (const node of idx.nodes.values()) {
			counts[node.kind] = (counts[node.kind] ?? 0) + 1;
		}
		return counts;
	},
} satisfies TreeOps;

// ── Loader class ──────────────────────────────────────────────────────

export class Loader {
	async provider(p?: Provider): Promise<Provider> {
		return p ?? initProvider(getRequestEvent());
	}

	async workspace(p?: Provider): Promise<Workspace | null> {
		const resolved = await this.provider(p);
		return resolved.loadWorkspace();
	}

	async crateGraph(
		name: string,
		version?: string,
		p?: Provider,
	): Promise<import('$lib/graph').CrateGraph | null> {
		const resolved = await this.provider(p);
		return resolved.loadCrateGraph(name, version ?? 'latest');
	}
}

export const loader = new Loader();

// ── Standalone node helpers ────────────────────────────────────────────

// Cached lookup structures (built once from the cached workspace)
let _allNodesCache: Map<string, Node> | null = null;
let _edgesBySrcCache: Map<string, Workspace['cross_crate_edges']> | null = null;
let _edgesByDstCache: Map<string, Workspace['cross_crate_edges']> | null = null;
let _cachedWorkspaceRef: Workspace | null = null;

export function getAllNodes(ws: Workspace): Map<string, Node> {
	if (_allNodesCache && _cachedWorkspaceRef === ws) return _allNodesCache;
	const map = new Map<string, Node>();
	for (const c of ws.crates) {
		for (const n of c.nodes) map.set(n.id, n);
	}
	for (const ext of ws.external_crates) {
		for (const n of ext.nodes) map.set(n.id, n);
	}
	_allNodesCache = map;
	_cachedWorkspaceRef = ws;
	return map;
}

export function getCrossEdgesByNode(ws: Workspace): {
	bySrc: Map<string, typeof ws.cross_crate_edges>;
	byDst: Map<string, typeof ws.cross_crate_edges>;
} {
	if (_edgesBySrcCache && _edgesByDstCache && _cachedWorkspaceRef === ws) {
		return { bySrc: _edgesBySrcCache, byDst: _edgesByDstCache };
	}
	const bySrc = new Map<string, typeof ws.cross_crate_edges>();
	const byDst = new Map<string, typeof ws.cross_crate_edges>();
	for (const e of ws.cross_crate_edges) {
		if (!bySrc.has(e.from)) bySrc.set(e.from, []);
		bySrc.get(e.from)!.push(e);
		if (!byDst.has(e.to)) byDst.set(e.to, []);
		byDst.get(e.to)!.push(e);
	}
	_edgesBySrcCache = bySrc;
	_edgesByDstCache = byDst;
	return { bySrc, byDst };
}

// ── Crate edge index (O(1) per-node edge lookup) ──────────────────────

let _crateEdgeIndex: Map<string, Edge[]> | null = null;
let _crateEdgeCrateRef: object | null = null;

function getCrateEdgeIndex(crate: { edges: Edge[] }): Map<string, Edge[]> {
	if (_crateEdgeIndex && _crateEdgeCrateRef === crate) return _crateEdgeIndex;
	const index = new Map<string, Edge[]>();
	for (const e of crate.edges) {
		for (const id of [e.from, e.to]) {
			let list = index.get(id);
			if (!list) { list = []; index.set(id, list); }
			list.push(e);
		}
	}
	_crateEdgeIndex = index;
	_crateEdgeCrateRef = crate;
	return index;
}

export function summarizeNode(n: Node): NodeSummary {
	return {
		id: n.id,
		name: n.name,
		kind: n.kind,
		visibility: n.visibility,
		is_external: n.is_external,
		...(n.kind === 'Impl'
			? {
					impl_trait: n.impl_trait,
					generics: n.generics,
					where_clause: n.where_clause,
					bound_links: n.bound_links,
				}
			: {}),
	};
}

// ── Resolver class ────────────────────────────────────────────────────

/**
 * Encapsulates server-side resolution helpers with an internal TreeIndex cache.
 * Remote functions delegate to these — keeps logic DRY and testable.
 */
export class Resolver {
	readonly #cache = new Map<string, { idx: TreeIndex; ready: boolean }>();
	readonly #loader: Loader;

	constructor(loader: Loader) {
		this.#loader = loader;
	}

	async nodeDetail(
		input: NodeDetailInput,
		provider: Provider,
		workspace: Workspace | null,
	): Promise<NodeDetail | null> {
		const { nodeId, version } = input;
		return perf.timeAsync(
			'server',
			`getNodeDetail(${nodeId})`,
			async () => {
				const cratePrefix = nodeId.split('::')[0];
				// Provider lookups (DO/R2) are keyed by hyphenated name (URL convention),
				// but node IDs use underscores (Rust convention).
				const crateNameForProvider = hyphenateCrateName(cratePrefix);

				if (workspace) {
					const crate = workspace.crates.find((c) => c.id === cratePrefix);
					if (crate) {
						const allNodes = getAllNodes(workspace);
						const node = allNodes.get(nodeId);
						if (!node) return null;

						// Collect edges: from the crate's internal edges + cross-crate indexed edges
						const { bySrc, byDst } = getCrossEdgesByNode(workspace);
						const edges = [
							...(getCrateEdgeIndex(crate).get(nodeId) ?? []),
							...(bySrc.get(nodeId) ?? []),
							...(byDst.get(nodeId) ?? []),
						];

						// Related nodes referenced by those edges
						const relatedIds = new Set<string>();
						for (const e of edges) {
							relatedIds.add(e.from);
							relatedIds.add(e.to);
						}
						relatedIds.delete(nodeId);

						const relatedNodes: NodeSummary[] = [];
						for (const id of relatedIds) {
							const n = allNodes.get(id);
							if (n) relatedNodes.push(summarizeNode(n));
						}

						return { node, edges, relatedNodes };
					}
					// Not a workspace crate — fall through to universal path
				}

				// Universal path: prefer provider-level node detail to avoid loading full graphs.
				if (provider.loadNodeDetail) {
					const detail = await provider.loadNodeDetail(
						crateNameForProvider,
						version ?? 'latest',
						nodeId,
					);
					if (detail) return detail;
				}

				// Fallback: load crate graph by ref (skip in hosted to avoid RPC limits)
				if (isHosted) return null;
				const graph = await provider.loadCrateGraph(crateNameForProvider, version ?? 'latest');
				if (!graph) return null;

				const nodesById = new Map<string, Node>();
				for (const n of graph.nodes) nodesById.set(n.id, n);
				const node = nodesById.get(nodeId);
				if (!node) return null;

				const edges = graph.edges.filter((e) => e.from === nodeId || e.to === nodeId);
				const crossData = await provider.getCrossEdgeData(nodeId);
				const edgeKey = (e: { from: string; to: string; kind: string; confidence: string }) =>
					`${e.from}|${e.to}|${e.kind}|${e.confidence}`;
				const edgeKeys = new Set(edges.map((e) => edgeKey(e)));
				for (const e of crossData.edges) {
					if (!edgeKeys.has(edgeKey(e))) {
						edges.push(e);
						edgeKeys.add(edgeKey(e));
					}
				}
				const relatedIds = new Set<string>();
				for (const e of edges) {
					relatedIds.add(e.from);
					relatedIds.add(e.to);
				}
				relatedIds.delete(nodeId);

				const relatedNodesMap = new Map<string, NodeSummary>();
				for (const id of relatedIds) {
					const n = nodesById.get(id);
					if (n) relatedNodesMap.set(id, summarizeNode(n));
				}
				for (const n of crossData.nodes) {
					if (!relatedNodesMap.has(n.id)) relatedNodesMap.set(n.id, n);
				}
				const relatedNodes = Array.from(relatedNodesMap.values());

				return { node, edges, relatedNodes };
			},
			{
				detail: (r) => (r ? `${r.edges.length}e ${r.relatedNodes.length}r` : 'null'),
			},
		);
	}

	async treeIndex(
		name: string,
		version: string,
		provider?: Provider,
	): Promise<TreeIndex | null> {
		const key = `${name}@${version}`;
		const cached = this.#cache.get(key);
		const resolved = await this.#loader.provider(provider);
		let status: { status: string } | null = null;
		if (cached) {
			if (cached.ready) return cached.idx;
			status = await resolved.getCrateStatus(name, version);
			if (status.status !== 'ready') return cached.idx;
		}

		return perf.timeAsync('server', `resolveTreeIndex(${key})`, async () => {
			const ws = await this.#loader.workspace(resolved);
			let crateTree: CrateTree | null = null;

			// Workspace path
			const wsCrate = ws?.crates.find((c) => c.id === name) ?? null;
			if (wsCrate) {
				const internalNodes = wsCrate.nodes.filter((n) => !n.is_external);
				const internalIds = new Set(internalNodes.map((n) => n.id));
				const treeEdges = wsCrate.edges.filter(
					(e) =>
						(e.kind === 'Contains' || e.kind === 'Defines') &&
						internalIds.has(e.from) &&
						internalIds.has(e.to),
				);
				crateTree = tree.canonicalize(name, { nodes: internalNodes.map(summarizeNode), edges: treeEdges });
			}

			// Provider tree
			if (!crateTree) {
				crateTree = await resolved.loadCrateTree(name, version);
				if (crateTree) crateTree = tree.canonicalize(name, crateTree);
			}

			if (!crateTree) {
				status ??= await resolved.getCrateStatus(name, version);
			}

			// Fallback: full graph (local only)
			if (!crateTree && !isHosted) {
				const graph = await this.#loader.crateGraph(name, version === 'latest' ? undefined : version, resolved);
				if (graph) {
					const internalNodes = graph.nodes.filter((n) => !n.is_external);
					const internalIds = new Set(internalNodes.map((n) => n.id));
					const treeEdges = graph.edges.filter(
						(e) =>
							(e.kind === 'Contains' || e.kind === 'Defines') &&
							internalIds.has(e.from) &&
							internalIds.has(e.to),
					);
					crateTree = tree.canonicalize(name, {
						nodes: internalNodes.map(summarizeNode),
						edges: treeEdges,
					});
				}
			}

			if (!crateTree) return null;

			const idx = new TreeIndex();
			// NodeSummary is a subset of Node — TreeIndex only uses id/kind/name
			idx.ensure({ nodes: crateTree.nodes as Node[], edges: crateTree.edges });
			status ??= await resolved.getCrateStatus(name, version);
			this.#cache.set(key, { idx, ready: status.status === 'ready' });
			log.info`resolveTreeIndex cached ${key} nodes=${crateTree.nodes.length} edges=${crateTree.edges.length} roots=${idx.rootCount}`;
			return idx;
		});
	}

	async crateMeta(name: string, version: string): Promise<CrateMeta | null> {
		const provider = await this.#loader.provider();
		const [index, versions, treeIdx] = await Promise.all([
			provider.loadCrateIndex(name, version),
			provider.getCrateVersions(name, 20),
			this.treeIndex(name, version, provider),
		]);
		const kindCounts = treeIdx ? tree.kindCounts(treeIdx) : {};
		return { index, versions, kindCounts };
	}

	async treeRoots(name: string, version: string): Promise<TreeNodeDTO[]> {
		const idx = await this.treeIndex(name, version);
		if (idx) {
			const rootIds = idx.getRootIds();
			const roots: TreeNodeDTO[] = [];
			for (const id of rootIds) {
				const node = idx.getNode(id);
				if (!node) continue;
				roots.push({ node: summarizeNode(node), hasChildren: idx.hasChildren(id) });
			}
			return roots;
		}
		// Fallback: query DB directly (works mid-parse before treeJson is written)
		const provider = await this.#loader.provider();
		if (provider.loadTreeRootsDirect) {
			return (await provider.loadTreeRootsDirect(name, version)) ?? [];
		}
		return [];
	}

	async nodeView({ name, version, nodeId }: NodeViewInput): Promise<NodeView | null> {
		const provider = await this.#loader.provider();
		const resolvedVersion = version ?? 'latest';
		const ws = await this.#loader.workspace(provider);
		const [detail, idx] = await Promise.all([
			this.nodeDetail({ nodeId, version: resolvedVersion }, provider, ws),
			this.treeIndex(name, resolvedVersion, provider),
		]);

		let resolvedDetail = detail;
		let resolvedNodeId = nodeId;

		// If direct lookup failed, try resolving as a re-exported item.
		// e.g. URL "syn::Item" → canonical "syn::item::Item"
		if (!detail && idx) {
			const canonical = this.#findCanonicalNodeId(idx, nodeId);
			if (canonical) {
				resolvedNodeId = canonical;
				log.info`resolved re-export ${nodeId} → ${canonical}`;
				resolvedDetail = await this.nodeDetail(
					{ nodeId: canonical, version: resolvedVersion },
					provider,
					ws,
				);
			}
		}

		if (!resolvedDetail) return null;

		// If tree index available, walk ancestors normally
		// If not (mid-parse), try direct DB query or return empty ancestors
		let ancestors: NodeSummary[] = [];
		if (idx) {
			ancestors = this.#walkAncestors(idx, resolvedNodeId);
		} else if (provider.loadTreeAncestorsDirect) {
			ancestors = (await provider.loadTreeAncestorsDirect(name, resolvedVersion, resolvedNodeId)) ?? [];
		}

		return { detail: resolvedDetail, ancestors };
	}

	/**
	 * Resolve a canonical node ID for a potentially re-exported item.
	 * Returns the canonical ID if the tree contains a node whose
	 * ID is `null` if no match is found.
	 */
	async resolveCanonicalNodeId(
		name: string,
		version: string,
		nodeId: string,
	): Promise<string | null> {
		const idx = await this.treeIndex(name, version);
		if (!idx) return null;
		if (idx.getNode(nodeId)) return nodeId;
		return this.#findCanonicalNodeId(idx, nodeId);
	}

	/**
	 * Search the tree for a node matching a re-exported path.
	 * Given "syn::Item", finds "syn::item::Item" by suffix match.
	 * Skips impl-scoped nodes (associated types/methods) since those
	 * can't be re-exported to the crate root.
	 * Prefers the shallowest match (fewest :: segments).
	 */
	#findCanonicalNodeId(idx: TreeIndex, nodeId: string): string | null {
		const parts = nodeId.split('::');
		if (parts.length < 2) return null;
		const cratePrefix = parts[0];
		const targetSuffix = `::${parts.slice(1).join('::')}`;

		let best: string | null = null;
		let bestSegments = Infinity;

		for (const id of idx.nodes.keys()) {
			if (!id.startsWith(`${cratePrefix}::`) || id === nodeId) continue;
			// Skip impl-scoped nodes (e.g. "syn::impl-10584::Item") — associated
			// types and methods live under impl blocks and can't be re-exported.
			if (id.includes('::impl-')) continue;
			if (id.endsWith(targetSuffix)) {
				const segments = id.split('::').length;
				if (segments < bestSegments) {
					bestSegments = segments;
					best = id;
				}
			}
		}

		return best;
	}

	#walkAncestors(idx: TreeIndex, nodeId: string): NodeSummary[] {
		const ancestors: NodeSummary[] = [];
		let currentId: string | undefined = idx.parents.get(nodeId);
		const visited = new Set<string>();
		while (currentId && !visited.has(currentId)) {
			visited.add(currentId);
			const node = idx.getNode(currentId);
			if (node) ancestors.unshift(summarizeNode(node));
			currentId = idx.parents.get(currentId);
		}
		return ancestors;
	}

	async treeChildren(name: string, version: string, parentId: string): Promise<TreeNodeDTO[]> {
		const idx = await this.treeIndex(name, version);
		if (idx) {
			return this.#childDTOs(idx, parentId);
		}
		// Fallback: direct DB query (works mid-parse)
		const provider = await this.#loader.provider();
		if (provider.loadTreeChildrenDirect) {
			return (await provider.loadTreeChildrenDirect(name, version, parentId)) ?? [];
		}
		return [];
	}

	#childDTOs(idx: TreeIndex, parentId: string): TreeNodeDTO[] {
		const ids = idx.getChildIds(parentId);
		const result: TreeNodeDTO[] = [];
		for (const id of ids) {
			const node = idx.getNode(id);
			if (!node) continue;
			result.push({ node: summarizeNode(node), hasChildren: idx.hasChildren(id) });
		}
		return result;
	}
}

export const resolve = new Resolver(loader);
