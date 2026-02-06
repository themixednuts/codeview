import type { RequestHandler } from './$types';
import type { CrateRegistry } from '$lib/server/cloudflare/registry';
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

	// For Cloudflare, use RPC to call registry DO methods
	if (!provider.streamSharedEvents) {
		const platform = event.platform as { env?: { CRATE_REGISTRY?: DurableObjectNamespace<CrateRegistry> } } | undefined;
		const registry = platform?.env?.CRATE_REGISTRY;
		
		if (!registry) {
			return new Response('Registry not available', { status: 501 });
		}
		
		const registryStub = registry.get(registry.idFromName('global'));
		
		try {
			switch (action) {
				case 'subscribe':
					if (!tags.length) {
						return new Response('Missing tags for subscribe', { status: 400 });
					}
					log.debug`RPC subscribe clientId=${clientId} tags=[${tags.join(', ')}]`;
					await registryStub.subscribeClient(clientId, tags);
					
					// Fetch and return initial state for each tag
					const initialData: Record<string, unknown> = {};
					for (const tag of tags) {
						if (tag.startsWith('progress:')) {
							// progress:ecosystem:name:version
							const parts = tag.split(':');
							if (parts.length === 4) {
								const [, ecosystem, name, version] = parts;
								initialData[tag] = await registryStub.getProgressSnapshot(ecosystem, name, version);
							}
						} else if (!tag.startsWith('edge:') && !tag.startsWith('processing:')) {
							// Crate status: ecosystem:name:version
							const parts = tag.split(':');
							if (parts.length === 3) {
								const [ecosystem, name, version] = parts;
								// Use provider.getCrateStatus for rust - it has auto-trigger logic
								// that starts parsing when status is 'unknown'
								if (ecosystem === 'rust') {
									const cfProvider = await initProvider(event);
									initialData[tag] = await cfProvider.getCrateStatus(name, version);
								} else {
									initialData[tag] = await registryStub.getStatus(ecosystem, name, version);
								}
							}
						}
					}
					return new Response(JSON.stringify({ success: true, initialData }), {
						headers: { 'Content-Type': 'application/json' }
					});

				case 'unsubscribe':
					if (!tags.length) {
						return new Response('Missing tags for unsubscribe', { status: 400 });
					}
					log.debug`RPC unsubscribe clientId=${clientId} tags=[${tags.join(', ')}]`;
					await registryStub.unsubscribeClient(clientId, tags);
					break;

				case 'ping':
					await registryStub.pingClient(clientId);
					break;

				default:
					return new Response(`Unknown action: ${action}`, { status: 400 });
			}
		} catch (err) {
			log.error`RPC error: ${String(err)}`;
			return new Response(`RPC error: ${err instanceof Error ? err.message : String(err)}`, { status: 500 });
		}
		
		return new Response(JSON.stringify({ success: true }), {
			headers: { 'Content-Type': 'application/json' }
		});
	}

	// Local mode: use provider's shared event stream
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
		} else if (tag.startsWith('processing:')) {
			// Send current processing count
			const parts = tag.split(':');
			if (parts.length === 2) {
				const ecosystem = parts[1];
				// For local mode, get processing count from cache
				const lc = provider.getCache?.();
				if (lc) {
					const cnt = lc.getProcessingCount(ecosystem);
					await provider.streamSharedEvents.sendToClient(clientId, { 
						tag, 
						data: { type: 'processing', count: cnt } 
					});
				}
			}
		} else if (!tag.startsWith('edge:')) {
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
