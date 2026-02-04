import { SSEConnection, type SSEEndReason } from '$lib/sse';

export type StreamPhase = 'idle' | 'connecting' | 'streaming' | 'retrying' | 'closed' | 'error';

export interface StreamSnapshot {
	key: string;
	phase: StreamPhase;
	updatedAt: number | null;
	error: string | null;
	stale: boolean;
	sequence: number | null;
	contentId: string | null;
}

export type StreamListener = (snapshot: StreamSnapshot) => void;

/**
 * Common stream lifecycle/state contract for all SSE consumers.
 * Subclasses can opt into only the fields they need.
 */
export abstract class StreamConnection extends SSEConnection implements AsyncIterable<StreamSnapshot> {
	streamKey = $state('');
	streamPhase = $state<StreamPhase>('idle');
	streamUpdatedAt = $state<number | null>(null);
	streamError = $state<string | null>(null);
	streamStale = $state(false);
	streamSequence = $state<number | null>(null);
	streamContentId = $state<string | null>(null);
	#listeners = new Set<StreamListener>();
	#iteratorClosers = new Set<() => void>();

	#publishSnapshot() {
		const snapshot = this.stream;
		for (const listener of this.#listeners) {
			listener(snapshot);
		}
	}

	protected beginStream(key: string) {
		this.streamKey = key;
		this.streamPhase = 'connecting';
		this.streamUpdatedAt = null;
		this.streamError = null;
		this.streamStale = false;
		this.streamSequence = null;
		this.streamContentId = null;
		this.#publishSnapshot();
	}

	protected markSequence(sequence: number | null) {
		this.streamSequence = sequence;
		this.#publishSnapshot();
	}

	protected markContentId(contentId: string | null) {
		this.streamContentId = contentId;
		this.#publishSnapshot();
	}

	protected markStale(stale: boolean) {
		this.streamStale = stale;
		this.#publishSnapshot();
	}

	protected override onStreamOpening() {
		this.streamPhase = 'connecting';
		this.#publishSnapshot();
	}

	protected override onStreamReady() {
		if (this.streamPhase === 'idle' || this.streamPhase === 'closed') {
			this.streamPhase = 'connecting';
			this.#publishSnapshot();
		}
	}

	protected override onStreamWarn(error: string) {
		this.streamError = error;
		this.#publishSnapshot();
	}

	protected override onStreamEnd(reason: SSEEndReason, detail?: string) {
		if (reason === 'aborted') {
			this.streamPhase = 'closed';
			this.#publishSnapshot();
			return;
		}
		if (reason === 'eof') {
			this.streamPhase = 'retrying';
			this.#publishSnapshot();
			return;
		}
		this.streamPhase = 'error';
		this.streamError = detail ?? reason;
		this.#publishSnapshot();
	}

	protected override onStreamReconnectScheduled(_delayMs: number) {
		this.streamPhase = 'retrying';
		this.#publishSnapshot();
	}

	protected touchStream() {
		this.streamPhase = 'streaming';
		this.streamUpdatedAt = Date.now();
		this.#publishSnapshot();
	}

	get stream(): StreamSnapshot {
		return {
			key: this.streamKey,
			phase: this.streamPhase,
			updatedAt: this.streamUpdatedAt,
			error: this.streamError,
			stale: this.streamStale,
			sequence: this.streamSequence,
			contentId: this.streamContentId
		};
	}

	subscribe(listener: StreamListener): Disposable {
		this.#listeners.add(listener);
		listener(this.stream);
		return {
			[Symbol.dispose]: () => {
				this.#listeners.delete(listener);
			}
		};
	}

	disconnect() {
		this.close();
		this.streamPhase = 'closed';
		this.#publishSnapshot();
	}

	[Symbol.asyncIterator](): AsyncIterator<StreamSnapshot> {
		const queue: StreamSnapshot[] = [];
		let done = false;
		let resolveNext: ((value: IteratorResult<StreamSnapshot>) => void) | null = null;

		const sub = this.subscribe((snapshot) => {
			if (done) return;
			if (resolveNext) {
				const resolve = resolveNext;
				resolveNext = null;
				resolve({ value: snapshot, done: false });
				return;
			}
			if (queue.length >= 256) queue.shift();
			queue.push(snapshot);
		});

		const close = () => {
			if (done) return;
			done = true;
			sub[Symbol.dispose]();
			this.#iteratorClosers.delete(close);
			if (resolveNext) {
				const resolve = resolveNext;
				resolveNext = null;
				resolve({ value: undefined, done: true });
			}
		};
		this.#iteratorClosers.add(close);

		return {
			next: async () => {
				if (done) return { value: undefined, done: true };
				if (queue.length > 0) {
					const value = queue.shift() as StreamSnapshot;
					return { value, done: false };
				}
				return await new Promise<IteratorResult<StreamSnapshot>>((resolve) => {
					resolveNext = resolve;
				});
			},
			return: async () => {
				close();
				return { value: undefined, done: true };
			}
		};
	}

	override destroy() {
		this.streamPhase = 'closed';
		this.#publishSnapshot();
		for (const close of this.#iteratorClosers) close();
		this.#iteratorClosers.clear();
		this.#listeners.clear();
		super.destroy();
	}
}
