import { query } from '$app/server';
import { getLogger } from '$lib/log';
import { perf } from '$lib/perf';
import { buildCrateMapData, type CrateMapData } from '$lib/graph/crate-map';
import { loader } from './helpers';
import { assertCrateRef } from './remote-utils';
import { CrateRefSchema } from './schemas';

const log = getLogger('rpc.crate-map');

/**
 * Aggregated crate-wide module map for high-level visualization.
 * Returns a compact hierarchy + module coupling matrix payload.
 */
export const getCrateMap = query(
	CrateRefSchema,
	async ({ name, version }): Promise<CrateMapData | null> => {
		const resolvedVersion = version ?? 'latest';
		assertCrateRef(name, resolvedVersion);

		return perf.timeAsync(
			'server',
			`getCrateMap(${name}@${resolvedVersion})`,
			async () => {
				const provider = await loader.provider();
				const graph = await loader.crateGraph(name, resolvedVersion, provider);
				if (!graph) return null;

				const map = buildCrateMapData({ nodes: graph.nodes, edges: graph.edges }, name, {
					maxHierarchyModules: 180,
					maxMatrixModules: 24,
				});

				log.info`getCrateMap done name=${name} version=${resolvedVersion} modules=${map.moduleNodes.length} matrix=${map.matrixModuleIds.length} edges=${map.moduleEdges.length}`;
				return map;
			},
			{
				detail: (result) =>
					result
						? `${result.moduleNodes.length}m ${result.matrixModuleIds.length}mx ${result.moduleEdges.length}e`
						: 'null',
			},
		);
	},
);
