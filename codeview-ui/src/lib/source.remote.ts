import { getRequestEvent, query } from '$app/server';
import { initProvider } from '$lib/server/provider';
import { GetSourceInputSchema, type SourceResult } from '$lib/schema';

export const getSource = query.batch(
	GetSourceInputSchema,
	async (inputs): Promise<((input: { file: string }, index: number) => SourceResult)> => {
		const provider = await initProvider(getRequestEvent());
		const results = await Promise.all(
			inputs.map((input) => provider.loadSourceFile(input.file))
		);
		return (_input, index) => results[index] ?? { error: 'Failed to fetch source', content: null };
	}
);
