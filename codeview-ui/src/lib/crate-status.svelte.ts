import type { CrateStatus } from '$lib/schema';

type CrateStatusValue = CrateStatus['status'];

/**
 * Reactive WebSocket connection for streaming crate parse status.
 * Encapsulates connect/reconnect/fallback logic so the layout stays declarative.
 */
export class CrateStatusConnection {
	status = $state<CrateStatusValue>('unknown');
	error = $state<string | null>(null);
	hasStatus = $state(false);

	#ws: WebSocket | null = null;
	#reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	#reconnectAttempts = 0;
	#name = '';
	#version = '';
	#allowWebSocket = true;
	#destroyed = false;

	/** Connect to a crate's status stream. Closes any previous connection. */
	connect(name: string, version: string, options?: { allowWebSocket?: boolean }) {
		this.#cleanup();
		this.#name = name;
		this.#version = version;
		this.#allowWebSocket = options?.allowWebSocket ?? true;
		this.#destroyed = false;
		this.#reconnectAttempts = 0;
		this.status = 'unknown';
		this.error = null;
		this.hasStatus = false;
		if (this.#allowWebSocket) {
			this.#openSocket();
		} else {
			this.#fallbackToQuery();
		}
	}

	#openSocket() {
		if (this.#destroyed) return;
		const key = `rust:${this.#name}:${this.#version}`;
		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		const url = `${protocol}//${window.location.host}/api/crate-status/ws?key=${encodeURIComponent(key)}`;
		const ws = new WebSocket(url);
		this.#ws = ws;

		ws.onmessage = (event) => {
			try {
				const data = JSON.parse(event.data) as CrateStatus;
				this.status = data.status;
				this.error = data.error ?? null;
				this.hasStatus = true;
				// Reset reconnect counter on successful message
				this.#reconnectAttempts = 0;
				// Terminal states — close and don't reconnect
				if (data.status === 'ready' || data.status === 'failed') {
					ws.close();
					this.#ws = null;
				}
			} catch {
				// ignore parse errors
			}
		};

		ws.onerror = () => {
			ws.close();
			this.#ws = null;
			if (this.status === 'processing' && !this.#destroyed) {
				this.#scheduleReconnect();
			} else {
				// WebSocket not available (local mode) — fall back to server query
				this.#fallbackToQuery();
			}
		};

		ws.onclose = () => {
			this.#ws = null;
			if (this.status === 'processing' && !this.#destroyed) {
				this.#scheduleReconnect();
			}
		};
	}

	#scheduleReconnect() {
		if (this.#reconnectTimer) return;
		const delay = Math.min(1000 * 2 ** this.#reconnectAttempts, 30_000);
		this.#reconnectAttempts++;
		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = null;
			this.#openSocket();
		}, delay);
	}

	async #fallbackToQuery() {
		try {
			const { getCrateStatus } = await import('$lib/graph.remote');
			const query = getCrateStatus(`${this.#name}@${this.#version}`);
			// Wait for the query to resolve by polling the reactive object
			const check = () => {
				if (!query.loading && query.current) {
					this.status = query.current.status;
					this.error = query.current.error ?? null;
					this.hasStatus = true;
				}
			};
			// Check immediately and after a short delay for async resolution
			check();
			setTimeout(check, 100);
		} catch {
			// If fallback also fails, leave status as-is
		}
	}

	/** Trigger a parse and start watching. */
	async triggerParse(name: string, version: string, options?: { allowWebSocket?: boolean }) {
		this.status = 'processing';
		this.error = null;
		this.hasStatus = true;
		// Open WebSocket first so we catch status updates
		this.#cleanup();
		this.#name = name;
		this.#version = version;
		this.#allowWebSocket = options?.allowWebSocket ?? true;
		this.#destroyed = false;
		this.#reconnectAttempts = 0;
		if (this.#allowWebSocket) {
			this.#openSocket();
		}
		try {
			const { triggerCrateParse } = await import('$lib/graph.remote');
			await triggerCrateParse(`${name}@${version}`);
		} catch (err) {
			this.status = 'failed';
			this.error = err instanceof Error ? err.message : String(err);
			this.#cleanup();
		}
	}

	/** Retry a failed parse. */
	async retry(name: string, version: string, options?: { allowWebSocket?: boolean }) {
		this.error = null;
		await this.triggerParse(name, version, options);
	}

	/** Clean up — close WebSocket, cancel reconnect timers. */
	destroy() {
		this.#destroyed = true;
		this.#cleanup();
	}

	#cleanup() {
		if (this.#reconnectTimer) {
			clearTimeout(this.#reconnectTimer);
			this.#reconnectTimer = null;
		}
		if (this.#ws) {
			this.#ws.close();
			this.#ws = null;
		}
	}
}
