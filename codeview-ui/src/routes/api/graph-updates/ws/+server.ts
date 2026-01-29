import type { RequestHandler } from './$types';
import { checkRateLimitPolicy } from '$lib/server/rate-limit';

/**
 * WebSocket proxy to the CrateRegistry Durable Object for graph updates.
 *
 * The client connects here with `?key=edge:<nodeId>` and receives
 * real-time update notifications when cross-crate edges change.
 */
export const GET: RequestHandler = async (event) => {
	const { request, platform } = event;
	const env = platform?.env;
	if (!env?.CRATE_REGISTRY) {
		return new Response('WebSocket not available (no CRATE_REGISTRY binding)', { status: 503 });
	}

	const allowed = await checkRateLimitPolicy(event, 'ws', {
		keySuffix: 'graph-updates'
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

	return stub.fetch(request);
};
