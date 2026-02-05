import type { RequestHandler } from './$types';
import { initProvider } from '$lib/server/provider';
import { getLogger } from '$lib/log';

const log = getLogger('api:events-sse');

/**
 * Shared SSE endpoint - single connection per client with multiplexed subscriptions
 * 
 * Client connects once: GET /api/events/sse
 * Then manages subscriptions via POST /api/events/subscribe
 * 
 * Events are broadcast in format: { tag: string, data: unknown }
 */
export const GET: RequestHandler = async (event) => {
	const provider = await initProvider(event);
	
	// For Cloudflare, proxy to registry DO
	if (!provider.streamSharedEvents) {
		// Get the platform env to access the registry DO
		const platform = event.platform as { env?: { CRATE_REGISTRY?: DurableObjectNamespace } } | undefined;
		const registry = platform?.env?.CRATE_REGISTRY;
		
		if (!registry) {
			return new Response('Registry not available', { status: 501 });
		}
		
		const registryStub = registry.get(registry.idFromName('global'));
		return registryStub.fetch(
			new Request('https://do/shared-sse', { signal: event.request.signal })
		);
	}

	// Local mode: use provider's shared event stream
	// Generate unique client ID
	const clientId = crypto.randomUUID();
	log.info`new shared SSE connection clientId=${clientId}`;

	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();

	// Register client with shared event stream
	provider.streamSharedEvents.addClient(clientId, writer);

	// Send initial connection acknowledgment
	const encoder = new TextEncoder();
	const ackMessage = encoder.encode(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);
	writer.write(ackMessage).catch(() => {});

	// Clean up when connection closes
	let cleaned = false;
	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		log.debug`cleanup clientId=${clientId}`;
		provider.streamSharedEvents?.removeClient(clientId);
		writer.close().catch(() => {});
	};

	writer.closed.then(cleanup, cleanup);
	if (event.request.signal) {
		event.request.signal.addEventListener('abort', cleanup, { once: true });
	}

	return new Response(readable, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Content-Encoding': 'identity',
			Connection: 'keep-alive'
		}
	});
};
