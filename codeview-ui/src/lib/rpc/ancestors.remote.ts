import { query } from '$app/server';
import { getLogger } from '$lib/log';
import { perf } from '$lib/perf';
import type { NodeSummary } from '$lib/schema';
import { loader, resolve, summarizeNode } from './helpers';
import { assertCrateRef } from './remote-utils';
import { TreeNodeInputSchema } from './schemas';

const log = getLogger('rpc.ancestors');

/**
 * Ancestor chain for a node — used for breadcrumbs.
 * Returns NodeSummary[] from root → ... → parent (excludes the node itself).
 */
export const getTreeAncestors = query(
	TreeNodeInputSchema,
	async ({ name, version, nodeId }): Promise<NodeSummary[]> => {
		assertCrateRef(name, version ?? 'latest');
		return perf.timeAsync(
			'server',
			`getTreeAncestors(${nodeId})`,
			async () => {
				const resolvedVersion = version ?? 'latest';
				const provider = await loader.provider();
				const idx = await resolve.treeIndex(name, resolvedVersion, provider);
				if (!idx) {
					if (provider.loadTreeAncestorsDirect) {
						return (await provider.loadTreeAncestorsDirect(name, resolvedVersion, nodeId)) ?? [];
					}
					log.info`getTreeAncestors no index for ${name}@${resolvedVersion}`;
					return [];
				}

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
			},
			{ detail: (r) => `${r.length} ancestors` },
		);
	},
);
