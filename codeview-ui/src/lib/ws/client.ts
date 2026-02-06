import { getLogger } from '$lib/log';

const log = getLogger('ws-client');

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
export type RealtimeCallback<T = unknown> = (data: T) => void;

export class Client implements Disposable, AsyncDisposable {
	#ws: WebSocket | null = null;
	#subscriptions = new Map<string, Set<RealtimeCallback>>();
	#connectionId: string | null = null;
	#destroyed = false;
	#connecting = false;
	#connected = false;

	// Reconnect state
	#retryDelay = 500;
	#retryTimer: ReturnType<typeof setTimeout> | null = null;

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
				this.#send({ action: 'subscribe', tags: [tag] });
			} else {
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

		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const url = `${protocol}//${location.host}/api/events/ws`;

		log.debug`connecting to ${url}`;

		const ws = new WebSocket(url);

		ws.onopen = () => {
			log.debug`socket open`;
			// Wait for 'connected' message from server before marking as connected
		};

		ws.onmessage = (event) => {
			this.#onMessage(event.data as string);
		};

		ws.onclose = (event) => {
			log.debug`socket closed code=${String(event.code)} reason=${event.reason || '(none)'}`;
			this.#onDisconnect();
		};

		ws.onerror = () => {
			log.warn`socket error`;
			// onclose will fire after onerror
		};

		this.#ws = ws;
	}

	#onMessage(raw: string): void {
		let msg: { type?: string; connectionId?: string; tag?: string; data?: unknown };
		try {
			msg = JSON.parse(raw);
		} catch {
			log.warn`invalid JSON from server`;
			return;
		}

		// Connection acknowledgment
		if (msg.type === 'connected' && msg.connectionId) {
			this.#connectionId = msg.connectionId;
			this.#connected = true;
			this.#connecting = false;
			this.#retryDelay = 500;
			log.debug`connected id=${msg.connectionId}`;

			// Subscribe to all active tags
			this.#resubscribeAll();
			return;
		}

		// Tagged data message
		if (msg.tag) {
			const callbacks = this.#subscriptions.get(msg.tag);
			if (callbacks) {
				for (const cb of callbacks) {
					try {
						cb(msg.data);
					} catch (err) {
						log.error`callback error for ${msg.tag}: ${String(err)}`;
					}
				}
			}
		}
	}

	#onDisconnect(): void {
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

		this.#retryDelay = Math.min(this.#retryDelay * 2, 5000);
	}

	#cancelRetry(): void {
		if (this.#retryTimer) {
			clearTimeout(this.#retryTimer);
			this.#retryTimer = null;
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
