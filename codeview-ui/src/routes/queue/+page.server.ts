import type { PageServerLoad } from './$types';
import { initProvider, type ParseQueueSnapshot } from '$lib/server/provider';

const emptySnapshot: ParseQueueSnapshot = {
	active: [],
	recent: [],
	planned: null,
};

export const load: PageServerLoad = async (event) => {
	const provider = await initProvider(event);
	const snapshot = provider.getParseQueue
		? await provider.getParseQueue(100).catch(() => emptySnapshot)
		: emptySnapshot;

	return {
		snapshot,
	};
};
