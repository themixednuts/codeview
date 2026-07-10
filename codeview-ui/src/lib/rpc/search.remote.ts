import { query } from '$app/server';
import { type NodeKind, type NodeSummary } from '$lib/schema';
import { normalizeCrateName } from '$lib/crate-names';
import { sanitizeSearchQuery } from '$lib/server/validation';
import { summarizeNode } from '$lib/node-summary';
import { loader, getAllNodes } from './helpers';
import { assertCrateRef } from './remote-utils';
import { NodeIdsSchema, SearchNodesInputSchema, type SearchNodesInput } from './schemas';

const DEFAULT_SEARCH_LIMIT = 500;

function matchesNodeSearch(node: NodeSummary, queryText: string, kinds: Set<NodeKind>): boolean {
	if (node.is_external || node.kind === 'Impl') return false;
	if (kinds.size > 0 && !kinds.has(node.kind)) return false;
	if (!queryText) return true;
	const lower = queryText.toLowerCase();
	return node.name.toLowerCase().includes(lower) || node.id.toLowerCase().includes(lower);
}

/** Search nodes by name/id, optionally scoped to a crate */
export const searchNodes = query(
	SearchNodesInputSchema,
	async ({ crate: crateId, version, q, kinds = [] }: SearchNodesInput): Promise<NodeSummary[]> => {
		const queryText = sanitizeSearchQuery(q ?? '');
		const kindSet = new Set<NodeKind>(kinds);
		if (!queryText && kindSet.size === 0) return [];
		if (crateId && version) assertCrateRef(crateId, version);

		const provider = await loader.provider();
		const ws = await loader.localWorkspace(provider);

		if (ws) {
			// If scoped to a specific crate that isn't in the local workspace, fall through
			const normalizedCrateId = crateId ? normalizeCrateName(crateId) : null;
			const isWorkspaceCrate =
				!normalizedCrateId ||
				ws.crates.some(
					(c) =>
						normalizeCrateName(c.id) === normalizedCrateId ||
						normalizeCrateName(c.name) === normalizedCrateId,
				);
			if (isWorkspaceCrate) {
				const results: NodeSummary[] = [];
				for (const c of ws.crates) {
					if (
						normalizedCrateId &&
						normalizeCrateName(c.id) !== normalizedCrateId &&
						normalizeCrateName(c.name) !== normalizedCrateId
					) {
						continue;
					}
					for (const n of c.nodes) {
						const summary = summarizeNode(n);
						if (matchesNodeSearch(summary, queryText, kindSet)) {
							results.push(summary);
						}
					}
				}
				return results.slice(0, DEFAULT_SEARCH_LIMIT);
			}
			// Not a local workspace crate — fall through to universal path
		}

		if (!crateId) return [];
		if (provider.searchNodesDirect) {
			const direct = await provider.searchNodesDirect(
				crateId,
				version ?? 'latest',
				queryText,
				DEFAULT_SEARCH_LIMIT,
				kinds,
			);
			if (direct) return direct;
		}
		const graph = await loader.crateGraph(crateId, version, provider);
		if (!graph) return [];
		return graph.nodes
			.map(summarizeNode)
			.filter((node) => matchesNodeSearch(node, queryText, kindSet))
			.slice(0, DEFAULT_SEARCH_LIMIT);
	},
);

/** Check whether node IDs exist in the local workspace (for link validation) */
export const checkNodeExists = query(
	NodeIdsSchema,
	async (nodeIds: string[]): Promise<Record<string, boolean>> => {
		const ws = await loader.localWorkspace();
		if (!ws) return {};
		const allNodes = getAllNodes(ws);
		const result: Record<string, boolean> = {};
		for (const id of nodeIds) {
			result[id] = allNodes.has(id);
		}
		return result;
	},
);
