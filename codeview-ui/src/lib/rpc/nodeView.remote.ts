import { query } from '$app/server';
import { getLogger } from '$lib/log';
import { perf } from '$lib/perf';
import type { NodeView } from '$lib/schema';
import { resolve } from './helpers';
import { assertCrateRef } from './remote-utils';
import { NodeViewInputSchema } from './schemas';

const log = getLogger('rpc.nodeView');

/**
 * Combined per-node endpoint: detail + ancestors + expand children.
 * Eliminates the 3-roundtrip waterfall (detail → ancestors → childrenxN).
 */
export const getNodeView = query(
	NodeViewInputSchema,
	async ({ name, version, nodeId }): Promise<NodeView | null> => {
		assertCrateRef(name, version ?? 'latest');
		return perf.timeAsync(
			'server',
			`getNodeView(${nodeId})`,
			async () => {
				log.info`getNodeView start name=${name} version=${version ?? 'latest'} nodeId=${nodeId}`;
				const result = await resolve.nodeView({ name, version, nodeId });
				if (result) {
					log.info`getNodeView done nodeId=${nodeId} ancestors=${result.ancestors.length}`;
				} else {
					log.info`getNodeView returned null for nodeId=${nodeId}`;
				}
				return result;
			},
			{
				detail: (r) =>
					r
						? `${r.ancestors.length}a ${r.detail.edges.length}e`
						: 'null',
			},
		);
	},
);
