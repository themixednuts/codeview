import { getLogger } from '$lib/log';
import { getSharedEventConnection } from '$lib/shared-events-client';

interface ProcessingMessage {
	type?: string;
	count?: number;
}

/**
 * Reactive connection for global processing updates via shared event stream.
 * Uses multiplexed SSE to avoid connection limits.
 * Emits the current count of crates being parsed.
 */
export class ProcessingStatusConnection {
	count = $state(0);

	#shared = getSharedEventConnection();
	#log = getLogger('processing');
	#ecosystem = 'rust';
	#currentTag: string | null = null;
	#unsubscribe: (() => void) | null = null;

	get tag() {
		return `processing:${this.#ecosystem}`;
	}

	/**
	 * Connect to processing status updates for an ecosystem.
	 */
	async connect(ecosystem = 'rust') {
		if (this.#ecosystem === ecosystem && this.#currentTag) return;
		this.disconnect();

		this.#ecosystem = ecosystem;
		const tag = `processing:${ecosystem}`;
		this.#currentTag = tag;

		this.#log.debug`connect ${this.tag}`;

		// Subscribe via shared connection
		const callback = (data: unknown) => this.#onData(data as ProcessingMessage);
		await this.#shared.subscribe(tag, callback);
		this.#unsubscribe = () => this.#shared.unsubscribe(tag, callback);
	}

	/**
	 * Disconnect from current processing status.
	 */
	disconnect() {
		if (this.#unsubscribe) {
			this.#unsubscribe();
			this.#unsubscribe = null;
		}
		this.#currentTag = null;
	}

	#onData(msg: ProcessingMessage) {
		if (msg.type && msg.type !== 'processing') return;
		if (typeof msg.count === 'number') {
			this.#log.debug`msg ${this.tag} count=${String(msg.count)}`;
			this.count = msg.count;
		}
	}

	/** Clean up and disconnect. */
	destroy() {
		this.disconnect();
	}
}
