import type { Handle } from '@sveltejs/kit';
import { checkRateLimitPolicy } from '$lib/server/rate-limit';

export const handle: Handle = async ({ event, resolve }) => {
	const allowed = await checkRateLimitPolicy(event, 'api');
	if (!allowed) {
		return new Response('Rate limit exceeded', { status: 429 });
	}

	return resolve(event);
};
