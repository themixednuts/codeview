import type { RequestHandler } from './$types';

/**
 * Subscription endpoint — preserved for future Vercel provider.
 * Both local and Cloudflare modes now use WebSocket (/api/events/ws).
 */
export const POST: RequestHandler = async () => {
	return new Response('Subscribe endpoint not active. Use /api/events/ws for WebSocket.', {
		status: 501,
	});
};
