import { prerender, query } from '$app/server';
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
async function loadNodeView({
	name,
	version,
	nodeId,
}: {
	name: string;
	version?: string;
	nodeId: string;
}) {
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
			return result satisfies NodeView | null;
		},
		{
			detail: (r) => (r ? `${r.ancestors.length}a ${r.detail.edges.length}e` : 'null'),
		},
	);
}

export const getNodeView = query(NodeViewInputSchema, loadNodeView);

export const getStaticNodeView = prerender(NodeViewInputSchema, loadNodeView, {
	dynamic: true,
});
