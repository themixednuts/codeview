import { getRequestEvent, query } from '$app/server';
import { initProvider } from '$lib/server/provider';
import { GetSourceInputSchema, type SourceResult } from '$lib/schema';

export const getSource = query(
	GetSourceInputSchema,
	async ({ file }): Promise<SourceResult> => {
		const provider = await initProvider(getRequestEvent());
		return provider.loadSourceFile(file);
	}
);
