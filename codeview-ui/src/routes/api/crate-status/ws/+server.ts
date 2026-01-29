import type { RequestHandler } from './$types';
import { checkRateLimitPolicy } from '$lib/server/rate-limit';

/**
 * WebSocket proxy to the CrateRegistry Durable Object.
 *
 * The client connects here with `?key=rust:serde:1.0.219` and receives
 * real-time status push notifications via WebSocket.
 */
export const GET: RequestHandler = async (event) => {
	const { request, platform } = event;
	const env = platform?.env;
	if (!env?.CRATE_REGISTRY) {
		return new Response('WebSocket not available (no CRATE_REGISTRY binding)', { status: 503 });
	}

	const allowed = await checkRateLimitPolicy(event, 'ws', {
		keySuffix: 'crate-status'
	});
	if (!allowed) {
		return new Response('Rate limit exceeded', { status: 429 });
	}

	const upgradeHeader = request.headers.get('Upgrade');
	if (upgradeHeader !== 'websocket') {
		return new Response('Expected WebSocket upgrade', { status: 426 });
	}

	// Forward the upgrade request to the CrateRegistry DO
	const id = env.CRATE_REGISTRY.idFromName('global');
	const stub = env.CRATE_REGISTRY.get(id);

	// Pass the full request (including ?key= query param) to the DO's fetch handler
	return stub.fetch(request);
};
