import { getLogger } from '$lib/log';
import { connect } from '$realtime';
import type { RealtimeClient } from './types';

interface ProcessingMessage {
	type?: string;
	count?: number;
}

export class ProcessingStatusConnection implements Disposable {
	count = $state(0);

	#client: RealtimeClient = connect();
	#log = getLogger('processing');
	#ecosystem = 'rust';
	#currentTag: string | null = null;
	#callback = (data: unknown) => this.#onData(data as ProcessingMessage);

	get tag() {
		return `processing:${this.#ecosystem}`;
	}

	connect(ecosystem = 'rust') {
		if (this.#ecosystem === ecosystem && this.#currentTag) return;
		this.disconnect();

		this.#ecosystem = ecosystem;
		const tag = `processing:${ecosystem}`;
		this.#currentTag = tag;

		this.#log.debug`connect ${this.tag}`;

		this.#client.subscribe(tag, this.#callback);
	}

	disconnect() {
		if (this.#currentTag) {
			this.#client.unsubscribe(this.#currentTag, this.#callback);
			this.#currentTag = null;
		}
	}

	#onData(msg: ProcessingMessage) {
		if (msg.type && msg.type !== 'processing') return;
		if (typeof msg.count === 'number') {
			this.#log.debug`msg ${this.tag} count=${String(msg.count)}`;
			this.count = msg.count;
		}
	}

	destroy() {
		this.disconnect();
	}

	[Symbol.dispose]() {
		this.destroy();
	}
}
