import { query } from '$app/server';
import {
	type NodeSummary,
} from '$lib/schema';
import { sanitizeSearchQuery } from '$lib/server/validation';
import { loader, getAllNodes, summarizeNode } from './helpers';
import { assertCrateRef } from './remote-utils';
import { NodeIdsSchema, SearchNodesInputSchema, type SearchNodesInput } from './schemas';

/** Search nodes by name/id, optionally scoped to a crate */
export const searchNodes = query(
	SearchNodesInputSchema,
	async ({ crate: crateId, version, q }: SearchNodesInput): Promise<NodeSummary[]> => {
		const queryText = sanitizeSearchQuery(q);
		if (!queryText) return [];
		if (crateId && version) assertCrateRef(crateId, version);

		const provider = await loader.provider();
		const ws = await loader.workspace(provider);
		const lower = queryText.toLowerCase();

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
		if (provider.searchNodesDirect) {
			const direct = await provider.searchNodesDirect(crateId, version ?? 'latest', queryText, 200);
			if (direct) return direct;
		}
		const graph = await loader.crateGraph(crateId, version, provider);
		if (!graph) return [];
		return graph.nodes
			.filter(
				(n) =>
					!n.is_external &&
					(n.name.toLowerCase().includes(lower) || n.id.toLowerCase().includes(lower)),
			)
			.map(summarizeNode);
	},
);

/** Check whether node IDs exist in the workspace (for link validation) */
export const checkNodeExists = query(
	NodeIdsSchema,
	async (nodeIds: string[]): Promise<Record<string, boolean>> => {
		const ws = await loader.workspace();
		if (!ws) return {};
		const allNodes = getAllNodes(ws);
		const result: Record<string, boolean> = {};
		for (const id of nodeIds) {
			result[id] = allNodes.has(id);
		}
		return result;
	},
);
