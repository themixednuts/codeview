import type { RequestHandler } from './$types';
import { initProvider } from '$lib/server/provider';
import { getLogger } from '$lib/log';

const log = getLogger('api:events-subscribe');

interface SubscribeRequest {
	clientId: string;
	action: 'subscribe' | 'unsubscribe' | 'ping';
	tags?: string[];
}

/**
 * Manage subscriptions for shared SSE connections
 * 
 * POST /api/events/subscribe
 * Body: { clientId: string, action: 'subscribe' | 'unsubscribe' | 'ping', tags?: string[] }
 */
export const POST: RequestHandler = async (event) => {
	const provider = await initProvider(event);
	
	if (!provider.streamSharedEvents) {
		return new Response('Shared events not available', { status: 501 });
	}

	let body: SubscribeRequest;
	try {
		body = await event.request.json();
	} catch {
		return new Response('Invalid JSON', { status: 400 });
	}

	const { clientId, action, tags = [] } = body;

	if (!clientId) {
		return new Response('Missing clientId', { status: 400 });
	}

	switch (action) {
		case 'subscribe':
			if (!tags.length) {
				return new Response('Missing tags for subscribe', { status: 400 });
			}
			log.debug`subscribe clientId=${clientId} tags=[${tags.join(', ')}]`;
			provider.streamSharedEvents.subscribe(clientId, tags);
			
			// Send initial state for subscribed tags
			await sendInitialState(provider, clientId, tags);
			break;

		case 'unsubscribe':
			if (!tags.length) {
				return new Response('Missing tags for unsubscribe', { status: 400 });
			}
			log.debug`unsubscribe clientId=${clientId} tags=[${tags.join(', ')}]`;
			provider.streamSharedEvents.unsubscribe(clientId, tags);
			break;

		case 'ping':
			provider.streamSharedEvents.ping(clientId);
			break;

		default:
			return new Response(`Unknown action: ${action}`, { status: 400 });
	}

	return new Response(JSON.stringify({ success: true }), {
		headers: { 'Content-Type': 'application/json' }
	});
};

/**
 * Send initial state for newly subscribed tags
 */
async function sendInitialState(provider: any, clientId: string, tags: string[]): Promise<void> {
	for (const tag of tags) {
		// Parse tag to determine what data to send
		// Format: progress:rust:name:version or rust:name:version (status)
		
		if (tag.startsWith('progress:')) {
			// Send latest progress snapshot if available
			const parts = tag.split(':');
			if (parts.length === 4) {
				const [, ecosystem, name, version] = parts;
				const data = await provider.getLatestProgress?.(ecosystem, name, version);
				if (data) {
					await provider.streamSharedEvents.sendToClient(clientId, { tag, data });
				}
			}
		} else if (!tag.startsWith('processing:') && !tag.startsWith('edge:')) {
			// Crate status
			const parts = tag.split(':');
			if (parts.length === 3) {
				const [ecosystem, name, version] = parts;
				const status = await provider.getCrateStatus?.(ecosystem, name, version);
				if (status) {
					await provider.streamSharedEvents.sendToClient(clientId, { tag, data: status });
				}
			}
		}
	}
}
