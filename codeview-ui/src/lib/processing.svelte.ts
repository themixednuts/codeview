import { getLogger } from '$lib/log';
import { SSEConnection } from '$lib/sse';

type ProcessingMessage = {
	type?: string;
	count?: number;
};

/**
 * Reactive SSE connection for global processing updates.
 * Emits the current count of crates being parsed.
 * In local mode the endpoint returns 503 and onerror silently closes.
 */
export class ProcessingStatusConnection extends SSEConnection {
	count = $state(0);

	protected readonly log = getLogger('processing');
	#ecosystem = 'rust';

	protected get tag() {
		return `processing:${this.#ecosystem}`;
	}

	protected get endpoint() {
		const key = `processing:${this.#ecosystem}`;
		return `/api/processing-status/sse?key=${encodeURIComponent(key)}`;
	}

	connect(ecosystem = 'rust') {
		if (this.#ecosystem === ecosystem && this.connected) return;
		this.close();
		this.activate();
		this.#ecosystem = ecosystem;
		this.open();
	}

	protected onData(data: unknown) {
		const msg = data as ProcessingMessage;
		if (msg.type && msg.type !== 'processing') return;
		if (typeof msg.count === 'number') {
			this.log.debug`msg ${this.tag} count=${String(msg.count)}`;
			this.count = msg.count;
		}
	}
}
