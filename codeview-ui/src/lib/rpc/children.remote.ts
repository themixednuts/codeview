import { query } from '$app/server';
import { getLogger } from '$lib/log';
import { perf } from '$lib/perf';
import type { TreeNodeDTO } from '$lib/schema';
import { resolve } from './helpers';
import { assertCrateRef } from './remote-utils';
import { TreeNodeInputSchema } from './schemas';

const log = getLogger('rpc.children');

/**
 * Children of a tree node — called on expand click.
 * Returns sorted TreeNodeDTO[] for the given parent.
 *
 * Uses query.batch so concurrent calls within the same macrotask are grouped
 * into a single HTTP request (e.g. pre-fetching children for all ancestors).
 */
export const getTreeChildren = query.batch(
	TreeNodeInputSchema,
	async (inputs) => {
		return perf.timeAsync(
			'server',
			`getTreeChildren.batch(${inputs.length})`,
			async () => {
				// Resolve children once per unique (crate, version, nodeId)
			const resultsByKey = new Map<string, TreeNodeDTO[]>();
			for (const { name, version, nodeId } of inputs) {
				assertCrateRef(name, version ?? 'latest');
				const key = `${name}@${version ?? 'latest'}:${nodeId}`;
					if (!resultsByKey.has(key)) {
						const children = await resolve.treeChildren(name, version ?? 'latest', nodeId);
						resultsByKey.set(key, children);
					}
				}

				log.info`getTreeChildren.batch resolving ${inputs.length} parents`;

				return ({ name, version, nodeId }: { name: string; version?: string; nodeId: string }) => {
					const key = `${name}@${version ?? 'latest'}:${nodeId}`;
					const children = resultsByKey.get(key) ?? [];
					log.info`getTreeChildren done ${name}@${version ?? 'latest'} parent=${nodeId} children=${children.length}`;
					return children;
				};
			},
			{ detail: () => `${inputs.length} parents` },
		);
	},
);
