import type { RequestHandler } from './$types';

/**
 * SSE endpoint — preserved for future Vercel provider.
 * Both local and Cloudflare modes now use WebSocket (/api/events/ws).
 */
export const GET: RequestHandler = async () => {
	return new Response('SSE endpoint not active. Use /api/events/ws for WebSocket.', {
		status: 501,
	});
};
