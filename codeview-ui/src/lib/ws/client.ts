import { getLogger } from '$lib/log';
import type { RealtimeCallback, RealtimeClient } from '$lib/realtime/types';

const log = getLogger('ws-client');

const RECONNECT_DELAY_INITIAL_MS = 500;
const RECONNECT_DELAY_MAX_MS = 5000;
const CONNECT_ACK_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_STALE_MS = 30_000;

/**
 * Browser WebSocket client for real-time event subscriptions.
 *
 * Connects to `/api/events/ws`, multiplexes subscriptions via tags,
 * and auto-reconnects with exponential backoff.
 *
 * Protocol:
 *   Server -> Client:  { type: "connected", connectionId }
 *                       { tag, data }
 *   Client -> Server:  { action: "subscribe",   tags: [...] }
 *                       { action: "unsubscribe", tags: [...] }
 */
export type { RealtimeCallback };

export class Client implements Disposable, AsyncDisposable, RealtimeClient {
	#ws: WebSocket | null = null;
	#subscriptions = new Map<string, Set<RealtimeCallback>>();
	#connectionId: string | null = null;
	#destroyed = false;
	#connecting = false;
	#connected = false;
	#currentUrl: string | null = null;

	// Reconnect state
	#retryDelay = RECONNECT_DELAY_INITIAL_MS;
	#retryTimer: ReturnType<typeof setTimeout> | null = null;
	#connectAckTimer: ReturnType<typeof setTimeout> | null = null;

	// Liveness / heartbeat
	#heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	#lastServerActivityMs = 0;

	// Pending subscribe/unsubscribe batched while disconnected
	#pendingSubscribes = new Set<string>();

	get connected() {
		return this.#connected;
	}

	/**
	 * Subscribe to a tag. Opens the connection if needed.
	 */
	subscribe<T = unknown>(tag: string, callback: RealtimeCallback<T>): void {
		let callbacks = this.#subscriptions.get(tag);
		if (!callbacks) {
			callbacks = new Set();
			this.#subscriptions.set(tag, callbacks);
		}
		const isNew = !callbacks.has(callback as RealtimeCallback) && callbacks.size === 0;
		callbacks.add(callback as RealtimeCallback);

		if (isNew) {
			if (this.#connected && this.#ws) {
				log.debug`subscribe ${tag} (direct)`;
				this.#send({ action: 'subscribe', tags: [tag] });
			} else {
				log.debug`subscribe ${tag} (pending)`;
				this.#pendingSubscribes.add(tag);
				this.#ensureConnection();
			}
		}
	}

	/**
	 * Unsubscribe a callback from a tag.
	 * When the last callback for a tag is removed, unsubscribes from the server.
	 */
	unsubscribe<T = unknown>(tag: string, callback: RealtimeCallback<T>): void {
		const callbacks = this.#subscriptions.get(tag);
		if (!callbacks) return;

		callbacks.delete(callback as RealtimeCallback);
		log.debug`unsubscribe ${tag} (remaining=${String(callbacks.size)})`;

		if (callbacks.size === 0) {
			this.#subscriptions.delete(tag);
			this.#pendingSubscribes.delete(tag);
			if (this.#connected && this.#ws) {
				this.#send({ action: 'unsubscribe', tags: [tag] });
			}
		}
	}

	/**
	 * Check if subscribed to a tag (has active callbacks).
	 */
	isSubscribed(tag: string): boolean {
		const callbacks = this.#subscriptions.get(tag);
		return !!callbacks && callbacks.size > 0;
	}

	/**
	 * Permanently close the connection and clear all subscriptions.
	 */
	destroy(): void {
		this.#destroyed = true;
		this.#cancelRetry();
		this.#stopHeartbeat();
		this.#cancelConnectAckTimer();
		this.#closeSocket();
		this.#subscriptions.clear();
		this.#pendingSubscribes.clear();
		this.#connectionId = null;
	}

	[Symbol.dispose]() {
		this.destroy();
	}

	async [Symbol.asyncDispose]() {
		this.destroy();
	}

	// ── Internals ──

	#ensureConnection(): void {
		if (this.#destroyed || this.#connecting || this.#connected) return;
		if (typeof window === 'undefined') return; // SSR guard
		this.#connect();
	}

	#connect(): void {
		if (this.#destroyed) return;
		this.#connecting = true;
		this.#cancelRetry();
		this.#cancelConnectAckTimer();

		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		// In dev, Vite can't proxy WS under Bun — connect directly to the Bun side-server
		const host = import.meta.env.DEV ? `${location.hostname}:15173` : location.host;
		const url = `${protocol}//${host}/api/events/ws`;
		this.#currentUrl = url;

		log.debug`connecting to ${url}`;

		const ws = new WebSocket(url);
		this.#connectAckTimer = setTimeout(() => {
			if (this.#destroyed) return;
			if (!this.#connecting || this.#connected) return;
			if (this.#ws !== ws) return;
			log.warn`connect ack timeout url=${url}`;
			try {
				ws.close();
			} catch {
				this.#onDisconnect();
			}
		}, CONNECT_ACK_TIMEOUT_MS);

		ws.onopen = () => {
			log.debug`socket open`;
			// Wait for 'connected' message from server before marking as connected
		};

		ws.onmessage = (event) => {
			this.#onMessage(event.data as string);
		};

		ws.onclose = (event) => {
			const reason = event.reason || '(none)';
			if (event.code === 1000) {
				log.debug`socket closed code=${String(event.code)} reason=${reason}`;
			} else {
				log.warn`socket closed code=${String(event.code)} reason=${reason} url=${url}`;
			}
			this.#onDisconnect();
		};

		ws.onerror = () => {
			log.warn`socket error url=${url} readyState=${String(ws.readyState)}`;
			if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
				try {
					ws.close();
				} catch {
					this.#onDisconnect();
				}
			}
		};

		this.#ws = ws;
	}

	#onMessage(raw: string): void {
		this.#lastServerActivityMs = Date.now();

		let msg: { type?: string; connectionId?: string; tag?: string; data?: unknown };
		try {
			msg = JSON.parse(raw);
		} catch {
			const preview = raw.length > 120 ? `${raw.slice(0, 120)}...` : raw;
			log.warn`invalid JSON from server payload=${preview}`;
			return;
		}

		// Connection acknowledgment
		if (msg.type === 'connected' && msg.connectionId) {
			this.#connectionId = msg.connectionId;
			this.#connected = true;
			this.#connecting = false;
			this.#retryDelay = RECONNECT_DELAY_INITIAL_MS;
			this.#cancelConnectAckTimer();
			this.#startHeartbeat();
			log.debug`connected id=${msg.connectionId}`;

			// Subscribe to all active tags
			this.#resubscribeAll();
			return;
		}

		if (msg.type === 'pong') {
			return;
		}

		// Tagged data message
		if (msg.tag) {
			const callbacks = this.#subscriptions.get(msg.tag);
			if (callbacks && callbacks.size > 0) {
				for (const cb of callbacks) {
					try {
						cb(msg.data);
					} catch (err) {
						log.error`callback error for ${msg.tag}: ${String(err)}`;
					}
				}
			} else {
				log.debug`msg ${msg.tag} → no callbacks`;
			}
		}
	}

	#onDisconnect(): void {
		this.#cancelConnectAckTimer();
		this.#stopHeartbeat();
		this.#connected = false;
		this.#connecting = false;
		this.#connectionId = null;
		this.#ws = null;

		if (this.#destroyed) return;

		// Move all active tags to pending for resubscription
		for (const tag of this.#subscriptions.keys()) {
			this.#pendingSubscribes.add(tag);
		}

		// Only reconnect if we have subscriptions
		if (this.#subscriptions.size > 0) {
			log.debug`disconnect with active subscriptions=${String(this.#subscriptions.size)} url=${this.#currentUrl ?? '(none)'}`;
			this.#scheduleReconnect();
		}
	}

	#resubscribeAll(): void {
		// Gather all tags that need subscribing
		const tags: string[] = [];
		for (const tag of this.#subscriptions.keys()) {
			tags.push(tag);
		}
		// Also include any pending
		for (const tag of this.#pendingSubscribes) {
			if (!tags.includes(tag)) tags.push(tag);
		}
		this.#pendingSubscribes.clear();

		if (tags.length > 0) {
			this.#send({ action: 'subscribe', tags });
		}
	}

	#send(msg: { action: string; tags?: string[] }): void {
		if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
			this.#ws.send(JSON.stringify(msg));
		}
	}

	#closeSocket(): void {
		this.#cancelConnectAckTimer();
		this.#stopHeartbeat();
		this.#connected = false;
		this.#connecting = false;
		if (this.#ws) {
			this.#ws.onclose = null;
			this.#ws.onerror = null;
			this.#ws.onmessage = null;
			this.#ws.close();
			this.#ws = null;
		}
	}

	#scheduleReconnect(): void {
		if (this.#destroyed || this.#retryTimer) return;

		const delay = this.#retryDelay;
		log.debug`reconnecting in ${String(delay)}ms`;

		this.#retryTimer = setTimeout(() => {
			this.#retryTimer = null;
			if (!this.#destroyed && this.#subscriptions.size > 0) {
				this.#connect();
			}
		}, delay);

		this.#retryDelay = Math.min(this.#retryDelay * 2, RECONNECT_DELAY_MAX_MS);
	}

	#cancelRetry(): void {
		if (this.#retryTimer) {
			clearTimeout(this.#retryTimer);
			this.#retryTimer = null;
		}
	}

	#cancelConnectAckTimer(): void {
		if (this.#connectAckTimer) {
			clearTimeout(this.#connectAckTimer);
			this.#connectAckTimer = null;
		}
	}

	#startHeartbeat(): void {
		this.#stopHeartbeat();
		this.#lastServerActivityMs = Date.now();
		this.#heartbeatTimer = setInterval(() => {
			if (!this.#connected || !this.#ws || this.#ws.readyState !== WebSocket.OPEN) return;

			const idleMs = Date.now() - this.#lastServerActivityMs;
			if (idleMs > HEARTBEAT_STALE_MS) {
				log.warn`stale connection idleMs=${String(idleMs)} forcing reconnect`;
				try {
					this.#ws.close();
				} catch {
					this.#onDisconnect();
				}
				return;
			}

			this.#send({ action: 'ping' });
		}, HEARTBEAT_INTERVAL_MS);
	}

	#stopHeartbeat(): void {
		if (this.#heartbeatTimer) {
			clearInterval(this.#heartbeatTimer);
			this.#heartbeatTimer = null;
		}
	}
}

// Global singleton - one WebSocket connection per browser tab
let globalConnection: Client | null = null;

export function connect(): Client {
	if (!globalConnection) {
		globalConnection = new Client();
	}
	return globalConnection;
}
