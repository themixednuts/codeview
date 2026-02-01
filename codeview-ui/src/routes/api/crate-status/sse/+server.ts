import type { RequestHandler } from './$types';
import { initProvider } from '$lib/server/provider';

export const GET: RequestHandler = async (event) => {
	const key = new URL(event.request.url).searchParams.get('key') ?? '';
	const [, name, version] = key.split(':');
	if (!name || !version) {
		return new Response('Missing key', { status: 400 });
	}
	const provider = await initProvider(event);
	return provider.streamCrateStatus(name, version, event.request.signal);
};
