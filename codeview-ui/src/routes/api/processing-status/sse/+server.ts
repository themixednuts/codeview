import type { RequestHandler } from './$types';
import { initProvider } from '$lib/server/provider';

export const GET: RequestHandler = async (event) => {
	const key = new URL(event.request.url).searchParams.get('key') ?? '';
	const [, ecosystem] = key.split(':');
	const provider = await initProvider(event);
	return provider.streamProcessingStatus(ecosystem ?? 'rust', event.request.signal);
};
