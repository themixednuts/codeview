import { getLogger } from '$lib/log';
import { connect } from '$realtime';
import type { CrateSummaryResult } from '$lib/server/provider';
import type { RealtimeClient } from './types';

interface ProcessingMessage {
	type?: string;
	count?: number;
	crates?: unknown;
}

export class ProcessingStatusConnection implements Disposable {
	count = $state(0);
	crates = $state.raw<CrateSummaryResult[]>([]);

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
		if (Array.isArray(msg.crates)) {
			this.crates = msg.crates.filter(isCrateSummary);
		}
	}

	destroy() {
		this.disconnect();
	}

	[Symbol.dispose]() {
		this.destroy();
	}
}

function isCrateSummary(value: unknown): value is CrateSummaryResult {
	if (!value || typeof value !== 'object') return false;
	const crate = value as Partial<CrateSummaryResult>;
	return (
		typeof crate.name === 'string' &&
		typeof crate.version === 'string' &&
		(crate.id === undefined || typeof crate.id === 'string') &&
		(crate.description === undefined || typeof crate.description === 'string')
	);
}
