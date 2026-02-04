import type { RequestHandler } from './$types';
import { initProvider } from '$lib/server/provider';
import { Result } from 'better-result';
import { getLogger } from '$lib/log';

const log = getLogger('api:progress-sse');

export const GET: RequestHandler = async (event) => {
	const key = new URL(event.request.url).searchParams.get('key') ?? '';
	// Key format: progress:ecosystem:name:version
	const [, , name, version] = key.split(':');
	if (!name || !version) {
		return new Response('Missing key', { status: 400 });
	}
	log.info`open key=${key} name=${name} version=${version}`;
	const provider = await initProvider(event);
	if (!provider.streamParseProgress) {
		return new Response('Not available', { status: 501 });
	}
	const url = new URL(event.request.url);
	const sinceParam = url.searchParams.get('since');
	const contentId = url.searchParams.get('contentId');
	let since: number | undefined;
	if (sinceParam) {
		const sinceResult = Result.try(() => Number.parseInt(sinceParam, 10));
		if (sinceResult.isOk() && Number.isFinite(sinceResult.value)) {
			since = sinceResult.value;
		}
	}
	const res = await provider.streamParseProgress(name, version, event.request.signal, {
		since,
		contentId: contentId || null
	});
	log.info`stream key=${key} status=${res.status} since=${since ?? -1} contentId=${contentId ?? '-'}`;
	return res;
};
