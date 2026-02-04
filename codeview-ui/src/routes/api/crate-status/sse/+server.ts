import type { RequestHandler } from './$types';
import { initProvider } from '$lib/server/provider';
import { getLogger } from '$lib/log';

const log = getLogger('api:status-sse');

export const GET: RequestHandler = async (event) => {
	const key = new URL(event.request.url).searchParams.get('key') ?? '';
	const [, name, version] = key.split(':');
	if (!name || !version) {
		return new Response('Missing key', { status: 400 });
	}
	log.info`open key=${key} name=${name} version=${version}`;
	const provider = await initProvider(event);
	const res = await provider.streamCrateStatus(name, version, event.request.signal);
	log.info`stream key=${key} status=${res.status}`;
	return res;
};
