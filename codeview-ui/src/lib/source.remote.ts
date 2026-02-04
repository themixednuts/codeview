import { getRequestEvent, query } from '$app/server';
import { initProvider } from '$lib/server/provider';
import { GetSourceInputSchema, type SourceResult } from '$lib/schema';

export const getSource = query.batch(
	GetSourceInputSchema,
	async (inputs): Promise<((input: { file: string; crateName?: string; crateVersion?: string; sourceProvider?: 'auto' | 'crates-io' | 'github' }, index: number) => SourceResult)> => {
		const provider = await initProvider(getRequestEvent());
		const results = await Promise.all(
			inputs.map((input) => provider.loadSourceFile(input.file, input.crateName, input.crateVersion, input.sourceProvider))
		);
		return (_input, index) => results[index] ?? { error: 'Failed to fetch source', content: null };
	}
);
