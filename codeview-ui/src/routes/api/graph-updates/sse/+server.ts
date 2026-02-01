import type { RequestHandler } from './$types';
import { initProvider } from '$lib/server/provider';

export const GET: RequestHandler = async (event) => {
	const key = new URL(event.request.url).searchParams.get('key') ?? '';
	const nodeId = key.startsWith('edge:') ? key.slice(5) : '';
	const provider = await initProvider(event);
	return provider.streamEdgeUpdates(nodeId, event.request.signal);
};
