import { query } from '$app/server';
import type { NodeDetail } from '$lib/schema';
import { loader, resolve, type NodeDetailInput } from './helpers';
import { NodeDetailInputSchema } from './schemas';

/** Get full node detail + all edges (for the detail panel) */
export const getNodeDetail = query.batch(
	NodeDetailInputSchema,
	async (inputs): Promise<(input: NodeDetailInput, index: number) => NodeDetail | null> => {
		const provider = await loader.provider();
		const workspace = await provider.loadWorkspace();
		const results = await Promise.all(
			inputs.map((input) => resolve.nodeDetail(input, provider, workspace)),
		);
		return (_input, index) => results[index] ?? null;
	},
);
