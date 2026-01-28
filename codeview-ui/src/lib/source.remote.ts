import * as v from 'valibot';
import { getRequestEvent, query } from '$app/server';
import { initProvider } from '$lib/server/provider';

export const getSource = query(
	v.object({
		file: v.string()
	}),
	async ({ file }) => {
		const provider = await initProvider(getRequestEvent());
		return provider.loadSourceFile(file);
	}
);
