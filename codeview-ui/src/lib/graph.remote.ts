import * as v from 'valibot';
import { getRequestEvent, query } from '$app/server';
import { initProvider } from '$lib/server/provider';
import type { Graph, Node, Edge } from '$lib/graph';

async function loadGraph(): Promise<Graph | null> {
	const provider = await initProvider(getRequestEvent());
	return provider.loadGraph();
}

/** Lightweight node summary for tree/list display */
type NodeSummary = Pick<Node, 'id' | 'name' | 'kind' | 'visibility' | 'is_external'>;

function summarizeNode(n: Node): NodeSummary {
	return { id: n.id, name: n.name, kind: n.kind, visibility: n.visibility, is_external: n.is_external };
}

/** Get list of crates (for index page) */
export const getCrates = query(async () => {
	const graph = await loadGraph();
	if (!graph) return [];
	return graph.nodes
		.filter((n) => n.kind === 'Crate' && !n.is_external)
		.map((n) => ({
			id: n.id,
			name: n.name,
			version: graph.crate_versions?.[n.id] ?? 'latest'
		}));
});

/** Get all crate trees merged into one graph (for the global sidebar) */
export const getAllCrateTrees = query(async () => {
	const graph = await loadGraph();
	if (!graph) return null;

	// Find all local crate root IDs
	const crateIds = graph.nodes
		.filter((n) => n.kind === 'Crate' && !n.is_external)
		.map((n) => n.id);

	// Build child map once
	const childMap = new Map<string, string[]>();
	for (const edge of graph.edges) {
		if (edge.kind === 'Contains' || edge.kind === 'Defines') {
			if (!childMap.has(edge.from)) childMap.set(edge.from, []);
			childMap.get(edge.from)!.push(edge.to);
		}
	}

	// Walk all crates to collect all tree node IDs
	const treeNodeIds = new Set<string>();
	for (const crateId of crateIds) {
		treeNodeIds.add(crateId);
		const queue = [crateId];
		while (queue.length > 0) {
			const id = queue.pop()!;
			const children = childMap.get(id);
			if (children) {
				for (const child of children) {
					if (!treeNodeIds.has(child)) {
						treeNodeIds.add(child);
						queue.push(child);
					}
				}
			}
		}
	}

	const nodes = graph.nodes
		.filter((n) => treeNodeIds.has(n.id))
		.map(summarizeNode);
	const edges = graph.edges.filter(
		(e) =>
			(e.kind === 'Contains' || e.kind === 'Defines') &&
			treeNodeIds.has(e.from) &&
			treeNodeIds.has(e.to)
	);

	// Include crate version mapping
	const crateVersions: Record<string, string> = {};
	for (const crateId of crateIds) {
		crateVersions[crateId] = graph.crate_versions?.[crateId] ?? 'latest';
	}

	return { nodes, edges, crateVersions };
});

/** Get crate tree structure (nodes + Contains/Defines edges for one crate) */
export const getCrateTree = query(v.string(), async (crateId: string) => {
	const graph = await loadGraph();
	if (!graph) return null;

	// Collect all node IDs that belong to this crate
	const treeNodeIds = new Set<string>();
	treeNodeIds.add(crateId);

	// Walk Contains/Defines edges to find all descendants
	const childMap = new Map<string, string[]>();
	for (const edge of graph.edges) {
		if (edge.kind === 'Contains' || edge.kind === 'Defines') {
			if (!childMap.has(edge.from)) childMap.set(edge.from, []);
			childMap.get(edge.from)!.push(edge.to);
		}
	}

	const queue = [crateId];
	while (queue.length > 0) {
		const id = queue.pop()!;
		const children = childMap.get(id);
		if (children) {
			for (const child of children) {
				if (!treeNodeIds.has(child)) {
					treeNodeIds.add(child);
					queue.push(child);
				}
			}
		}
	}

	const nodes = graph.nodes
		.filter((n) => treeNodeIds.has(n.id))
		.map(summarizeNode);
	const edges = graph.edges.filter(
		(e) =>
			(e.kind === 'Contains' || e.kind === 'Defines') &&
			treeNodeIds.has(e.from) &&
			treeNodeIds.has(e.to)
	);

	return { nodes, edges };
});

/** Get full node detail + all edges (for the detail panel) */
export const getNodeDetail = query(v.string(), async (nodeId: string) => {
	const graph = await loadGraph();
	if (!graph) return null;

	const node = graph.nodes.find((n) => n.id === nodeId);
	if (!node) return null;

	// All edges where this node is from or to
	const edges = graph.edges.filter((e) => e.from === nodeId || e.to === nodeId);

	// Related nodes referenced by those edges
	const relatedIds = new Set<string>();
	for (const e of edges) {
		relatedIds.add(e.from);
		relatedIds.add(e.to);
	}
	relatedIds.delete(nodeId);

	const relatedNodes = graph.nodes
		.filter((n) => relatedIds.has(n.id))
		.map(summarizeNode);

	return { node, edges, relatedNodes };
});

/** Get available versions for a crate */
export const getCrateVersions = query(v.string(), async (crateName: string) => {
	const graph = await loadGraph();
	if (!graph) return [];
	const version = graph.crate_versions?.[crateName];
	return version ? [version] : ['latest'];
});

/** Search nodes by name/id, optionally scoped to a crate */
export const searchNodes = query(
	v.object({ crate: v.optional(v.string()), q: v.string() }),
	async ({ crate, q }: { crate?: string; q: string }) => {
		const graph = await loadGraph();
		if (!graph) return [];
		const lower = q.toLowerCase();
		return graph.nodes
			.filter(
				(n) =>
					!n.is_external &&
					(!crate || n.id === crate || n.id.startsWith(crate + '::')) &&
					(n.name.toLowerCase().includes(lower) || n.id.toLowerCase().includes(lower))
			)
			.map(summarizeNode);
	}
);

/** Check whether node IDs exist in the graph (for link validation) */
export const checkNodeExists = query(
	v.array(v.string()),
	async (nodeIds: string[]) => {
		const graph = await loadGraph();
		if (!graph) return {};
		const nodeSet = new Set(graph.nodes.map((n) => n.id));
		const result: Record<string, boolean> = {};
		for (const id of nodeIds) {
			result[id] = nodeSet.has(id);
		}
		return result;
	}
);
