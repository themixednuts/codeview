type ProcessingMessage = {
	type?: string;
	count?: number;
};

/**
 * Reactive WebSocket connection for global processing updates.
 * Emits the current count of crates being parsed.
 */
export class ProcessingStatusConnection {
	count = $state(0);

	#ws: WebSocket | null = null;
	#reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	#reconnectAttempts = 0;
	#ecosystem = 'rust';
	#destroyed = false;

	connect(ecosystem = 'rust') {
		if (this.#ecosystem === ecosystem && this.#ws) return;
		this.#cleanup();
		this.#ecosystem = ecosystem;
		this.#destroyed = false;
		this.#reconnectAttempts = 0;
		this.#openSocket();
	}

	destroy() {
		this.#destroyed = true;
		this.#cleanup();
	}

	#openSocket() {
		if (this.#destroyed) return;
		const key = `processing:${this.#ecosystem}`;
		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		const url = `${protocol}//${window.location.host}/api/crate-status/ws?key=${encodeURIComponent(key)}`;
		const ws = new WebSocket(url);
		this.#ws = ws;

		ws.onmessage = (event) => {
			try {
				const data = JSON.parse(event.data) as ProcessingMessage;
				if (data.type && data.type !== 'processing') return;
				if (typeof data.count === 'number') {
					this.count = data.count;
				}
			} catch {
				// ignore parse errors
			}
		};

		ws.onerror = () => {
			ws.close();
			this.#ws = null;
			this.#scheduleReconnect();
			this.#fallbackToQuery();
		};

		ws.onclose = () => {
			this.#ws = null;
			this.#scheduleReconnect();
		};
	}

	#scheduleReconnect() {
		if (this.#destroyed || this.#reconnectTimer) return;
		const delay = Math.min(1000 * 2 ** this.#reconnectAttempts, 30_000);
		this.#reconnectAttempts++;
		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = null;
			this.#openSocket();
		}, delay);
	}

	async #fallbackToQuery() {
		try {
			const { getProcessingCrates } = await import('$lib/graph.remote');
			const query = getProcessingCrates({});
			const check = () => {
				if (!query.loading && query.current) {
					this.count = query.current.length;
				}
			};
			check();
			setTimeout(check, 100);
		} catch {
			// If fallback fails, leave count as-is
		}
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
