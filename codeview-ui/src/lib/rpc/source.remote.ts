import { getRequestEvent, query } from '$app/server';
import { initProvider } from '$lib/server/provider';
import type { SourceResult } from '$lib/schema';
import { assertCrateName, assertCrateRef } from './remote-utils';
import { GetSourceInputSchema } from './schemas';

export const getSource = query.batch(
	GetSourceInputSchema,
	async (
		inputs,
	): Promise<
		(
			input: {
				file: string;
				crateName?: string;
				crateVersion?: string;
				sourceProvider?: 'auto' | 'crates-io' | 'github';
			},
			index: number,
		) => SourceResult
	> => {
		const provider = await initProvider(getRequestEvent());
		const results = await Promise.all(
			inputs.map((input) => {
				if (input.crateName && input.crateVersion) {
					assertCrateRef(input.crateName, input.crateVersion);
				} else if (input.crateName) {
					assertCrateName(input.crateName);
				}
				return provider.loadSourceFile(
					input.file,
					input.crateName,
					input.crateVersion,
					input.sourceProvider,
				);
			}),
		);
		return (_input, index) => results[index] ?? { error: 'Failed to fetch source', content: null, absolutePath: null, repoUrl: null };
	},
);
