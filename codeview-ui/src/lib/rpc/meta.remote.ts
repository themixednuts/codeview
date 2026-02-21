import { query } from '$app/server';
import { getLogger } from '$lib/log';
import { perf } from '$lib/perf';
import type { CrateMeta } from '$lib/schema';
import { resolve } from './helpers';
import { assertCrateRef } from './remote-utils';
import { CrateRefSchema } from './schemas';

const log = getLogger('rpc.meta');

/**
 * Lightweight crate metadata: index + versions + kind counts.
 * No tree nodes or edges are sent — kind counts are computed server-side.
 */
export const getCrateMeta = query(
	CrateRefSchema,
	async ({ name, version }): Promise<CrateMeta | null> => {
		assertCrateRef(name, version ?? 'latest');
		return perf.timeAsync(
			'server',
			`getCrateMeta(${name})`,
			async () => {
				log.info`getCrateMeta start name=${name} version=${version ?? 'latest'}`;
				const result = await resolve.crateMeta(name, version ?? 'latest');
				log.info`getCrateMeta done name=${name} versions=${result?.versions.length ?? 0} kinds=${result ? Object.keys(result.kindCounts).length : 0}`;
				return result;
			},
			{
				detail: (r) => (r ? `${r.versions.length}v ${Object.keys(r.kindCounts).length}k` : 'null'),
			},
		);
	},
);
