import { prerender, query } from '$app/server';
import { Data, Effect } from 'effect';
import { getLogger } from '$lib/log';
import { perf } from '$lib/perf';
import type { TreeNodeDTO } from '$lib/schema';
import { resolve } from './helpers';
import { assertCrateRef } from './remote-utils';
import { TreeNodeInputSchema } from './schemas';

const log = getLogger('rpc.children');

class TreeChildrenLoadError extends Data.TaggedError('TreeChildrenLoadError')<{
	readonly key: string;
	readonly cause: unknown;
	readonly message: string;
}> {}

function unknownMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

async function loadTreeChildren({
	name,
	version,
	nodeId,
}: {
	name: string;
	version?: string;
	nodeId: string;
}): Promise<TreeNodeDTO[]> {
	assertCrateRef(name, version ?? 'latest');
	const children = await resolve.treeChildren(name, version ?? 'latest', nodeId);
	log.info`getTreeChildren done ${name}@${version ?? 'latest'} parent=${nodeId} children=${children.length}`;
	return children;
}

/**
 * Children of a tree node — called on expand click.
 * Returns sorted TreeNodeDTO[] for the given parent.
 *
 * Uses query.batch so concurrent calls within the same macrotask are grouped
 * into a single HTTP request (e.g. pre-fetching children for all ancestors).
 */
export const getTreeChildren = query.batch(TreeNodeInputSchema, async (inputs) => {
	return perf.timeAsync(
		'server',
		`getTreeChildren.batch(${inputs.length})`,
		async () => {
			// Resolve children once per unique (crate, version, nodeId)
			const uniqueInputs = new Map<string, (typeof inputs)[number]>();
			for (const input of inputs) {
				const { name, version, nodeId } = input;
				const key = `${name}@${version ?? 'latest'}:${nodeId}`;
				if (!uniqueInputs.has(key)) uniqueInputs.set(key, input);
			}

			log.info`getTreeChildren.batch resolving ${inputs.length} parents`;

			const loaded = await Effect.runPromise(
				Effect.forEach(
					Array.from(uniqueInputs.entries()),
					([key, input]) =>
						Effect.tryPromise({
							try: async () => [key, await loadTreeChildren(input)] as const,
							catch: (cause) =>
								new TreeChildrenLoadError({
									key,
									cause,
									message: `Failed to load tree children for ${key}: ${unknownMessage(cause)}`,
								}),
						}),
					{ concurrency: 8 },
				),
			);

			const resultsByKey = new Map<string, TreeNodeDTO[]>(loaded);

			return ({ name, version, nodeId }: { name: string; version?: string; nodeId: string }) => {
				const key = `${name}@${version ?? 'latest'}:${nodeId}`;
				const children = resultsByKey.get(key) ?? [];
				log.info`getTreeChildren done ${name}@${version ?? 'latest'} parent=${nodeId} children=${children.length}`;
				return children;
			};
		},
		{ detail: () => `${inputs.length} parents` },
	);
});

export const getStaticTreeChildren = prerender(TreeNodeInputSchema, loadTreeChildren, {
	dynamic: true,
});
