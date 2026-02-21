import { query } from '$app/server';
import { getLogger } from '$lib/log';
import { perf } from '$lib/perf';
import type { TreeNodeDTO } from '$lib/schema';
import { resolve } from './helpers';
import { assertCrateRef } from './remote-utils';
import { CrateRefSchema } from './schemas';

const log = getLogger('rpc.roots');

/**
 * Root tree nodes for the sidebar. Returns TreeNodeDTO[] with hasChildren flags.
 */
export const getTreeRoots = query(
	CrateRefSchema,
	async ({ name, version }): Promise<TreeNodeDTO[]> => {
		assertCrateRef(name, version ?? 'latest');
		return perf.timeAsync(
			'server',
			`getTreeRoots(${name})`,
			async () => {
				const resolvedVersion = version ?? 'latest';
				const roots = await resolve.treeRoots(name, resolvedVersion);
				log.info`getTreeRoots done name=${name} roots=${roots.length}`;
				return roots;
			},
			{ detail: (r) => `${r.length} roots` },
		);
	},
);
