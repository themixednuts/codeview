import { getRequestEvent, query, command } from '$app/server';
import { error } from '@sveltejs/kit';
import { initProvider } from '$lib/server/provider';
import { isValidCrateName, isValidVersion, sanitizeSearchQuery } from './server/validation';
import { perf } from './perf';
import type { Node, Workspace } from '$lib/graph';
import {
	NodeIdSchema,
	NodeIdsSchema,
	CrateRefSchema,
	NodeDetailInputSchema,
	ProcessingInputSchema,
	SearchNodesInputSchema,
	type NodeSummary,
	type CrateSummary,
	type CrateIndex,
	type CrateTree,
	type NodeDetail,
	type CrateStatus,
	type CrateSearchResult
} from '$lib/schema';

async function loadWorkspace(): Promise<Workspace | null> {
	const provider = await initProvider(getRequestEvent());
	return provider.loadWorkspace();
}

async function loadCrateGraphByRef(
	name: string,
	version?: string
): Promise<import('$lib/graph').CrateGraph | null> {
	const provider = await initProvider(getRequestEvent());
	return provider.loadCrateGraph(name, version ?? 'latest');
}

type Provider = Awaited<ReturnType<typeof initProvider>>;
type NodeDetailInput = {
	nodeId: string;
	version?: string;
	refresh?: number;
};

// Cached lookup structures (built once from the cached workspace)
let _allNodesCache: Map<string, Node> | null = null;
let _edgesBySrcCache: Map<string, Workspace['cross_crate_edges']> | null = null;
let _edgesByDstCache: Map<string, Workspace['cross_crate_edges']> | null = null;
let _cachedWorkspaceRef: Workspace | null = null;

function getAllNodes(ws: Workspace): Map<string, Node> {
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

function getCrossEdgesByNode(ws: Workspace): { bySrc: Map<string, typeof ws.cross_crate_edges>; byDst: Map<string, typeof ws.cross_crate_edges> } {
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

function summarizeNode(n: Node): NodeSummary {
	return {
		id: n.id, name: n.name, kind: n.kind, visibility: n.visibility, is_external: n.is_external,
		...(n.kind === 'Impl' ? { impl_trait: n.impl_trait, generics: n.generics, where_clause: n.where_clause, bound_links: n.bound_links } : {})
	};
}

async function resolveNodeDetail(
	input: NodeDetailInput,
	provider: Provider,
	workspace: Workspace | null
): Promise<NodeDetail | null> {
	const { nodeId, version } = input;
	return perf.timeAsync('server', `getNodeDetail(${nodeId})`, async () => {
		const cratePrefix = nodeId.split('::')[0];

		if (workspace) {
			const crate = workspace.crates.find((c) => c.id === cratePrefix);
			if (crate) {
				const allNodes = getAllNodes(workspace);
				const node = allNodes.get(nodeId);
				if (!node) return null;

				// Collect edges: from the crate's internal edges + cross-crate indexed edges
				const { bySrc, byDst } = getCrossEdgesByNode(workspace);
				const edges = [
					...(crate.edges.filter((e) => e.from === nodeId || e.to === nodeId)),
					...(bySrc.get(nodeId) ?? []),
					...(byDst.get(nodeId) ?? [])
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

		// Universal path: load crate graph by ref (works for local SQLite + hosted R2)
		const graph = await provider.loadCrateGraph(cratePrefix, version ?? 'latest');
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
	}, {
		detail: (r) => r ? `${r.edges.length}e ${r.relatedNodes.length}r` : 'null'
	});
}

/** Get list of workspace crates (for index page + switcher) */
export const getCrates = query(async (): Promise<CrateSummary[]> => {
	const ws = await loadWorkspace();
	if (!ws) return [];
	return ws.crates.map((c) => ({
		id: c.id,
		name: c.name,
		version: c.version
	}));
});

/** Get a hosted-friendly list of top crates (registry-backed). */
export const getTopCrates = query(async (): Promise<CrateSearchResult[]> => {
	const provider = await initProvider(getRequestEvent());
	return provider.getTopCrates(10);
});

/** Get currently processing crates (cloud mode). */
export const getProcessingCrates = query(ProcessingInputSchema, async (): Promise<CrateSearchResult[]> => {
	const provider = await initProvider(getRequestEvent());
	return provider.getProcessingCrates(20);
});

/** Get crate tree structure (nodes + Contains/Defines edges for one crate) */
export const getCrateTree = query(CrateRefSchema, async ({ name, version }): Promise<CrateTree | null> => {
	return perf.timeAsync('server', `getCrateTree(${name})`, async () => {
		const ws = await loadWorkspace();
		let crate = ws?.crates.find((c) => c.id === name) ?? null;
		if (!crate) {
			const graph = await loadCrateGraphByRef(name, version);
			if (!graph) return null;
			crate = graph;
		}

		// Exclude external crate nodes — they only exist for cross-edge references
		const internalNodes = crate.nodes.filter((n) => !n.is_external);
		const internalIds = new Set(internalNodes.map((n) => n.id));

		// Only return tree-relevant edges between internal nodes
		const treeEdges = crate.edges.filter(
			(e) => (e.kind === 'Contains' || e.kind === 'Defines') && internalIds.has(e.from) && internalIds.has(e.to)
		);

		return {
			nodes: internalNodes.map(summarizeNode),
			edges: treeEdges
		};
	}, {
		detail: (r) => r ? `${r.nodes.length}n ${r.edges.length}e` : 'null'
	});
});

/** Get full node detail + all edges (for the detail panel) */
export const getNodeDetail = query.batch(
	NodeDetailInputSchema,
	async (inputs): Promise<((input: NodeDetailInput, index: number) => NodeDetail | null)> => {
		const provider = await initProvider(getRequestEvent());
		const workspace = await provider.loadWorkspace();
		const results = await Promise.all(
			inputs.map((input) => resolveNodeDetail(input, provider, workspace))
		);
		return (_input, index) => results[index] ?? null;
	}
);

/** Get available versions for a crate */
export const getCrateVersions = query(NodeIdSchema, async (crateName: string): Promise<string[]> => {
	const provider = await initProvider(getRequestEvent());
	return await provider.getCrateVersions(crateName, 20);
});

/** Get a lightweight crate index for hosted mode (external crate list + versions). */
export const getCrateIndex = query(CrateRefSchema, async ({ name, version }): Promise<CrateIndex | null> => {
	const provider = await initProvider(getRequestEvent());
	return await provider.loadCrateIndex(name, version ?? 'latest');
});

/** Search nodes by name/id, optionally scoped to a crate */
export const searchNodes = query(
	SearchNodesInputSchema,
	async ({ crate: crateId, version, q }: { crate?: string; version?: string; q: string }): Promise<NodeSummary[]> => {
		const ws = await loadWorkspace();
		const lower = q.toLowerCase();

		if (ws) {
			// If scoped to a specific crate that isn't in the workspace, fall through
			const isWorkspaceCrate = !crateId || ws.crates.some((c) => c.id === crateId);
			if (isWorkspaceCrate) {
				const results: NodeSummary[] = [];
				for (const c of ws.crates) {
					if (crateId && c.id !== crateId) continue;
					for (const n of c.nodes) {
						if (
							!n.is_external &&
							(n.name.toLowerCase().includes(lower) || n.id.toLowerCase().includes(lower))
						) {
							results.push(summarizeNode(n));
						}
					}
				}
				return results;
			}
			// Not a workspace crate — fall through to universal path
		}

		if (!crateId) return [];
		const graph = await loadCrateGraphByRef(crateId, version);
		if (!graph) return [];
		return graph.nodes
			.filter(
				(n) =>
					!n.is_external &&
					(n.name.toLowerCase().includes(lower) || n.id.toLowerCase().includes(lower))
			)
			.map(summarizeNode);
	}
);

/** Check whether node IDs exist in the workspace (for link validation) */
export const checkNodeExists = query(
	NodeIdsSchema,
	async (nodeIds: string[]): Promise<Record<string, boolean>> => {
		const ws = await loadWorkspace();
		if (!ws) return {};
		const allNodes = getAllNodes(ws);
		const result: Record<string, boolean> = {};
		for (const id of nodeIds) {
			result[id] = allNodes.has(id);
		}
		return result;
	}
);

// --- Cloud multi-crate queries ---

const CrateKeySchema = NodeIdSchema; // reuse string schema for name param

/** Get the parse status of a crate (cloud mode). */
export const getCrateStatus = query(
	CrateKeySchema,
	async (nameVersion: string): Promise<CrateStatus> => {
		const [rawName, rawVersion] = nameVersion.split('@');
		const name = rawName ?? '';
		const version = rawVersion ?? 'latest';
		if (!isValidCrateName(name) || !isValidVersion(version)) {
			throw error(400, 'Invalid crate name or version');
		}
		const provider = await initProvider(getRequestEvent());
		return provider.getCrateStatus(name, version);
	}
);

/** Trigger parsing of a crate (cloud mode). Append `!force` to re-parse. */
export const triggerCrateParse = command(
	CrateKeySchema,
	async (nameVersion: string): Promise<void> => {
		const force = nameVersion.endsWith('!force');
		const key = force ? nameVersion.slice(0, -'!force'.length) : nameVersion;
		const [rawName, rawVersion] = key.split('@');
		const name = rawName ?? '';
		const version = rawVersion ?? 'latest';
		if (!isValidCrateName(name) || !isValidVersion(version)) {
			throw error(400, 'Invalid crate name or version');
		}
		const provider = await initProvider(getRequestEvent());
		const result = await provider.triggerParse(name, version, force);
		if (result.isErr()) {
			const err = result.error;
			const status = err._tag === 'RateLimitError' ? 429 : 422;
			throw error(status, err.message);
		}
	}
);

/** Trigger std crate install + parse (local mode, requires user consent). */
export const triggerStdInstall = command(
	CrateKeySchema,
	async (nameVersion: string): Promise<void> => {
		const [rawName, rawVersion] = nameVersion.split('@');
		const name = rawName ?? '';
		const version = rawVersion ?? 'stable';
		const provider = await initProvider(getRequestEvent());
		const result = await provider.triggerStdInstall(name, version);
		if (result.isErr()) {
			const err = result.error;
			throw error(422, err.message);
		}
	}
);

/** Search the registry for crates (cloud mode). */
export const searchRegistry = query(
	NodeIdSchema,
	async (q: string): Promise<CrateSearchResult[]> => {
		const queryText = sanitizeSearchQuery(q);
		if (!queryText) return [];
		const provider = await initProvider(getRequestEvent());
		return provider.searchRegistry(queryText);
	}
);

/** Load a single crate graph from R2 (cloud mode). */
export const loadCrateGraph = query(
	CrateKeySchema,
	async (nameVersion: string): Promise<CrateTree | null> => {
		const [rawName, rawVersion] = nameVersion.split('@');
		const name = rawName ?? '';
		const version = rawVersion ?? 'latest';
		if (!isValidCrateName(name) || !isValidVersion(version)) {
			throw error(400, 'Invalid crate name or version');
		}
		const provider = await initProvider(getRequestEvent());
		const graph = await provider.loadCrateGraph(name, version);
		if (!graph) return null;

		// Filter to tree-relevant edges only
		const treeEdges = graph.edges.filter((e: { kind: string }) => e.kind === 'Contains' || e.kind === 'Defines');

		return {
			nodes: graph.nodes.map(summarizeNode),
			edges: treeEdges
		};
	}
);
