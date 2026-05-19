import { prerender, query } from '$app/server';
import { getLogger } from '$lib/log';
import { perf } from '$lib/perf';
import type { CrateMapData } from '$lib/graph/crate-map';
import { loader } from './helpers';
import { assertCrateRef } from './remote-utils';
import { CrateRefSchema } from './schemas';

const log = getLogger('rpc.crate-map');

/**
 * Aggregated crate-wide module map for high-level visualization.
 * Returns a compact hierarchy + module coupling matrix payload.
 *
 * Computation happens inside the data provider (DO in hosted mode,
 * in-process in local mode) to avoid transferring full graphs.
 */
async function loadCrateMap({ name, version }: { name: string; version?: string }) {
	const resolvedVersion = version ?? 'latest';
	assertCrateRef(name, resolvedVersion);

	return perf.timeAsync(
		'server',
		`getCrateMap(${name}@${resolvedVersion})`,
		async () => {
			const provider = await loader.provider();
			const map = await provider.loadCrateMap(name, resolvedVersion, {
				maxHierarchyModules: 180,
				maxMatrixModules: 24,
			});

			if (map) {
				log.info`getCrateMap done name=${name} version=${resolvedVersion} modules=${map.moduleNodes.length} matrix=${map.matrixModuleIds.length} edges=${map.moduleEdges.length}`;
			}
			return map satisfies CrateMapData | null;
		},
		{
			detail: (result) =>
				result
					? `${result.moduleNodes.length}m ${result.matrixModuleIds.length}mx ${result.moduleEdges.length}e`
					: 'null',
		},
	);
}

export const getCrateMap = query(CrateRefSchema, loadCrateMap);

export const getStaticCrateMap = prerender(CrateRefSchema, loadCrateMap, {
	dynamic: true,
});
