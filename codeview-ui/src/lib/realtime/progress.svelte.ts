import { getLogger } from '$lib/log';
import { connect } from '$realtime';
import type { RealtimeClient } from './types';

interface ProgressEvent {
	type: 'meta' | 'delta' | 'complete';
	nodeCount?: number;
	edgeCount?: number;
	totalItems?: number;
}

export class ParseProgressConnection implements Disposable {
	nodeCount = $state(0);
	edgeCount = $state(0);
	totalItems = $state<number | null>(null);
	complete: boolean = $state(false);

	#client: RealtimeClient = connect();
	#log = getLogger('progress');
	#name = '';
	#version = '';
	#currentTag: string | null = null;
	#callback = (data: unknown) => this.#onProgressData(data as ProgressEvent);

	get tag() {
		return `${this.#name}@${this.#version}`;
	}

	connect(name: string, version: string) {
		this.reset();
		this.#name = name;
		this.#version = version;
		const tag = `progress:rust:${name}:${version}`;
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

	destroy() {
		this.disconnect();
		this.#resetCounters();
	}

	[Symbol.dispose]() {
		this.destroy();
	}

	reset() {
		this.disconnect();
		this.#resetCounters();
	}

	#resetCounters() {
		this.nodeCount = 0;
		this.edgeCount = 0;
		this.totalItems = null;
		this.complete = false;
	}

	#onProgressData(msg: ProgressEvent) {
		this.#log
			.debug`msg ${this.tag} type=${msg.type} nodes=${msg.nodeCount ?? 0} edges=${msg.edgeCount ?? 0} total=${msg.totalItems ?? '-'}`;

		if (typeof msg.nodeCount === 'number') this.nodeCount = msg.nodeCount;
		if (typeof msg.edgeCount === 'number') this.edgeCount = msg.edgeCount;

		if ((msg.type === 'meta' || msg.type === 'complete') && typeof msg.totalItems === 'number') {
			this.totalItems = msg.totalItems;
		}

		if (msg.type === 'complete') {
			this.complete = true;
			this.#log.debug`complete ${this.tag}`;
			this.disconnect();
		}
	}
}
