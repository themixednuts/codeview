type GraphUpdateMessage = {
	type?: string;
	nodeId?: string;
};

/**
 * Reactive WebSocket connection for cross-crate edge updates.
 * Emits a monotonically increasing tick when updates arrive.
 */
export class CrossEdgeUpdatesConnection {
	updateTick = $state(0);

	#ws: WebSocket | null = null;
	#reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	#reconnectAttempts = 0;
	#nodeId = '';
	#destroyed = false;

	connect(nodeId: string) {
		if (this.#nodeId === nodeId && this.#ws) return;
		this.#cleanup();
		this.#nodeId = nodeId;
		this.#destroyed = false;
		this.#reconnectAttempts = 0;
		this.#openSocket();
	}

	destroy() {
		this.#destroyed = true;
		this.#cleanup();
	}

	#openSocket() {
		if (this.#destroyed || !this.#nodeId) return;
		const key = `edge:${this.#nodeId}`;
		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		const url = `${protocol}//${window.location.host}/api/graph-updates/ws?key=${encodeURIComponent(key)}`;
		const ws = new WebSocket(url);
		this.#ws = ws;

		ws.onmessage = (event) => {
			try {
				const data = JSON.parse(event.data) as GraphUpdateMessage;
				if (data.type && data.type !== 'cross-edges') return;
			} catch {
				// ignore parse errors
			}
			this.updateTick += 1;
			this.#reconnectAttempts = 0;
		};

		ws.onerror = () => {
			ws.close();
			this.#ws = null;
			this.#scheduleReconnect();
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
