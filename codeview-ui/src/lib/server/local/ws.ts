/**
 * Local-mode WebSocket connection manager.
 *
 * Replaces SharedEventStream for real-time event delivery over Bun WebSockets.
 * Each browser tab opens one WebSocket to `/api/events/ws`; the server multiplexes
 * subscriptions by tag, same as the old SSE approach but without needing a Web Worker
 * or POST /subscribe endpoint.
 */
import type { ServerWebSocket } from 'bun';
import type { CrateStatus } from '$lib/schema';
import { getLogger } from '$lib/log';

const log = getLogger('local-ws');

// ── Connection state ──

export interface WsConnection {
	ws: { send(data: string): void };
	tags: Set<string>;
}

interface WsData {
	connectionId: string;
	open?(ws: ServerWebSocket<WsData>): void;
	message?(ws: ServerWebSocket<WsData>, msg: string | Buffer): void;
	close?(ws: ServerWebSocket<WsData>, code: number, reason: string): void;
	drain?(ws: ServerWebSocket<WsData>): void;
}

/** Exported for the Vite dev plugin — dev-mode WS upgrades bypass SvelteKit routes. */
export const connections = new Map<string, WsConnection>();

// ── Broadcasting ──

/**
 * Broadcast a tagged message to all WebSocket clients subscribed to `tag`.
 */
function broadcastToTag<T = unknown>(tag: string, data: T): void {
	const payload = JSON.stringify({ tag, data });
	const dead: string[] = [];

	for (const [id, conn] of connections) {
		if (!conn.tags.has(tag)) continue;
		try {
			conn.ws.send(payload);
		} catch {
			dead.push(id);
		}
	}

	for (const id of dead) {
		log.debug`removing dead connection ${id}`;
		connections.delete(id);
	}
}

// ── Typed emit helpers (matches cloudflare registry.emit) ──

export const emit = {
	status(name: string, version: string, data: CrateStatus) {
		broadcastToTag(`rust:${name}:${version}`, data);
	},
	progress(name: string, version: string, data: unknown) {
		broadcastToTag(`progress:rust:${name}:${version}`, data);
	},
	processing(ecosystem: string, data: { type: 'processing'; count: number }) {
		broadcastToTag(`processing:${ecosystem}`, data);
	},
	edges(nodeId: string, data: { type: 'cross-edges'; nodeId: string }) {
		broadcastToTag(`edge:${nodeId}`, data);
	},
};

// ── Progress broadcasting (counts-only, no snapshot accumulation) ──

/**
 * Broadcast a progress update. No snapshot accumulation — the sidebar
 * uses lazy RPC instead of streaming tree data.
 */
export function broadcastProgress(
	ecosystem: string,
	name: string,
	version: string,
	data: {
		type: string;
		nodeCount?: number;
		edgeCount?: number;
		totalItems?: number;
	},
): void {
	log.debug`broadcastProgress ${ecosystem}:${name}:${version} type=${data.type} nodes=${data.nodeCount ?? 0}`;
	emit.progress(name, version, data);
}

// ── Provider internals interface ──

/**
 * Subset of local provider state needed by the WS handler for initial-state dispatch.
 */
export interface LocalProviderInternals {
	getCache(): {
		getStatus(ecosystem: string, name: string, version: string): CrateStatus;
		getProcessingCount(ecosystem: string): number;
	};
	getCrateStatus(name: string, version: string): Promise<CrateStatus>;
}

// ── WebSocket lifecycle handlers ──

/**
 * Create Bun WebSocket handler callbacks that delegate to per-connection logic.
 * Pass the returned object as `ws.data` when calling `server.upgrade()`.
 */
export function createHandlers(internals: LocalProviderInternals) {
	return {
		open(ws: ServerWebSocket<WsData>) {
			const connectionId = crypto.randomUUID();
			ws.data.connectionId = connectionId;
			connections.set(connectionId, { ws, tags: new Set() });

			log.info`ws open connectionId=${connectionId}`;

			ws.send(JSON.stringify({ type: 'connected', connectionId }));
		},

		message(ws: ServerWebSocket<WsData>, msg: string | Buffer) {
			const raw = typeof msg === 'string' ? msg : msg.toString();
			let parsed: { action?: string; tags?: string[] };
			try {
				parsed = JSON.parse(raw);
			} catch {
				log.warn`invalid JSON from client`;
				return;
			}

			const connectionId = ws.data.connectionId;
			const conn = connections.get(connectionId);
			if (!conn) return;

			const { action, tags = [] } = parsed;

			if (action === 'ping') {
				ws.send(JSON.stringify({ type: 'pong' }));
				return;
			}

			if (action === 'subscribe' && tags.length > 0) {
				log.debug`subscribe connectionId=${connectionId} tags=[${tags.join(', ')}]`;
				for (const tag of tags) {
					conn.tags.add(tag);
				}
				sendInitialState(ws, tags, internals);
			} else if (action === 'unsubscribe' && tags.length > 0) {
				log.debug`unsubscribe connectionId=${connectionId} tags=[${tags.join(', ')}]`;
				for (const tag of tags) {
					conn.tags.delete(tag);
				}
			}
		},

		close(ws: ServerWebSocket<WsData>) {
			const connectionId = ws.data.connectionId;
			log.debug`ws close connectionId=${connectionId}`;
			connections.delete(connectionId);
		},
	};
}

// ── Initial state dispatch ──

/** Exported for the Vite dev plugin. Accepts any object with .send(). */
export async function sendInitialState(
	ws: { send(data: string): void },
	tags: string[],
	internals: LocalProviderInternals,
): Promise<void> {
	for (const tag of tags) {
		try {
			if (tag.startsWith('progress:')) {
				// No snapshot accumulation — client picks up from next live event
			} else if (tag.startsWith('processing:')) {
				const parts = tag.split(':');
				if (parts.length === 2) {
					const ecosystem = parts[1];
					const cache = internals.getCache();
					const count = cache.getProcessingCount(ecosystem);
					ws.send(JSON.stringify({ tag, data: { type: 'processing', count } }));
				}
			} else if (!tag.startsWith('edge:')) {
				const parts = tag.split(':');
				if (parts.length === 3) {
					const [, name, version] = parts;
					const status = await internals.getCrateStatus(name, version);
					if (status) {
						ws.send(JSON.stringify({ tag, data: status }));
					}
				}
			}
		} catch (err) {
			log.warn`initial state error for ${tag}: ${String(err)}`;
		}
	}
}
