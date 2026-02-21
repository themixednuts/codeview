import type { Logger } from '@logtape/logtape';

export type SSEEndReason = 'eof' | 'aborted' | 'fetch-error' | 'bad-response' | 'read-error';

type WorkerMessage =
	| { type: 'ready'; id: number }
	| { type: 'data'; id: number; payload: unknown }
	| { type: 'warn'; id: number; error: string }
	| { type: 'end'; id: number; reason: SSEEndReason; detail?: string };

type WorkerCommand =
	| { type: 'connect'; id: number; endpoint: string }
	| { type: 'abort'; id: number }
	| { type: 'dispose' };

/**
 * Base class for reactive SSE connections.
 * Uses a web worker for fetch + stream parsing.
 *
 * The server closes SSE streams after a TTL to prevent zombie
 * connections from exhausting HTTP/1.1 connection limits. When
 * a stream ends normally (server TTL), this class automatically
 * reconnects. When `close()` or `destroy()` is called, no
 * reconnection occurs.
 *
 * Subclasses implement `tag`, `endpoint`, and `onData` to define
 * the connection identity and message handling. Call `open()` from
 * your `connect()` method to start streaming.
 */
export abstract class SSEConnection implements Disposable, AsyncDisposable {
	#worker: Worker | null = null;
	#currentSession: number | null = null;
	#sessionId = 0;
	#active = true;
	#destroyed = false;
	#retryDelay = 500;
	#retryDelayRateLimit = 10000; // 10s initial for 429 errors
	#retryTimer: ReturnType<typeof setTimeout> | null = null;
	#lastErrorWasRateLimit = false;

	protected abstract readonly log: Logger;

	/** Short identifier for log lines (e.g. `"serde@1.0"`). */
	protected abstract get tag(): string;

	/** Full SSE endpoint URL. */
	protected abstract get endpoint(): string;

	/** Handle a parsed JSON message from the stream. */
	protected abstract onData(data: unknown): void;
	protected onStreamOpening() {}
	protected onStreamReady() {}
	protected onStreamWarn(_error: string) {}
	protected onStreamEnd(_reason: SSEEndReason, _detail?: string) {}
	protected onStreamReconnectScheduled(_delayMs: number) {}

	/** Whether the connection is currently open. */
	get connected() {
		return this.#currentSession !== null;
	}

	#opening = false;

	/**
	 * Open a new SSE connection. Closes any existing connection first.
	 * No-op after `destroy()`.
	 */
	protected open() {
		if (this.#destroyed || !this.#active) return;
		if (import.meta.env.SSR) return;
		if (this.#opening) {
			this.log.debug`open ${this.tag} skipped - already opening`;
			return;
		}
		this.#opening = true;
		this.close();
		this.onStreamOpening();
		this.log.debug`open ${this.tag}`;
		this.#cancelRetryTimer();

		const sessionId = ++this.#sessionId;
		this.#currentSession = sessionId;
		this.#ensureWorker();
		this.#worker?.postMessage({
			type: 'connect',
			id: sessionId,
			endpoint: this.endpoint,
		} satisfies WorkerCommand);
	}

	#ensureWorker() {
		if (this.#worker) return;
		const worker = new Worker(new URL('../workers/sse.ts', import.meta.url), { type: 'module' });
		worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
			this.#handleWorkerMessage(event.data);
		};
		worker.onerror = (event) => {
			this.log.warn`worker error ${this.tag}: ${String(event.message ?? 'unknown')}`;
			this.#handleWorkerFailure();
		};
		worker.onmessageerror = () => {
			this.log.warn`worker message error ${this.tag}`;
			this.#handleWorkerFailure();
		};
		this.#worker = worker;
	}

	#handleWorkerFailure() {
		if (this.#worker) {
			this.#worker.terminate();
			this.#worker = null;
		}
		if (this.#currentSession !== null) this.#currentSession = null;
		this.#scheduleReconnect();
	}

	#handleWorkerMessage(message: WorkerMessage) {
		if (message.type === 'ready') {
			if (message.id === this.#currentSession) {
				this.#retryDelay = 500;
				this.#retryDelayRateLimit = 10000;
				this.#lastErrorWasRateLimit = false;
				this.#opening = false;
				this.onStreamReady();
			}
			return;
		}

		if (message.id !== this.#currentSession) return;

		if (message.type === 'data') {
			this.onData(message.payload);
			return;
		}

		if (message.type === 'warn') {
			this.log.warn`parse error ${this.tag}: ${message.error}`;
			this.onStreamWarn(message.error);
			return;
		}

		this.#opening = false;
		this.onStreamEnd(message.reason, message.detail);
		this.#currentSession = null;
		if (message.reason === 'aborted') return;

		// Track rate limit errors for longer backoff
		const isRateLimit = message.reason === 'bad-response' && message.detail === '429';
		this.#lastErrorWasRateLimit = isRateLimit;

		if (message.reason === 'bad-response') {
			this.log.warn`bad response ${this.tag}: ${message.detail ?? 'unknown'}`;
		} else if (message.reason === 'fetch-error') {
			this.log.warn`fetch error ${this.tag}: ${message.detail ?? 'unknown'}`;
		} else if (message.reason === 'read-error') {
			this.log.warn`read error ${this.tag}: ${message.detail ?? 'unknown'}`;
		} else if (message.reason === 'eof') {
			this.log.debug`reconnect ${this.tag}`;
		}

		this.#scheduleReconnect();
	}

	#scheduleReconnect() {
		if (this.#destroyed || !this.#active) return;
		if (this.#retryTimer) return;

		// Use much longer backoff for rate limit errors (429)
		const isRateLimit = this.#lastErrorWasRateLimit;
		const delay = isRateLimit ? this.#retryDelayRateLimit : this.#retryDelay;
		const maxDelay = isRateLimit ? 30000 : 5000; // 30s max for rate limits, 5s for normal

		this.onStreamReconnectScheduled(delay);
		this.log.debug`retry in ${String(delay)}ms ${this.tag}${isRateLimit ? ' (rate limit)' : ''}`;
		this.#retryTimer = setTimeout(() => {
			this.#retryTimer = null;
			if (!this.#destroyed && this.#active) {
				this.open();
			}
		}, delay);

		// Increase delay for next retry
		if (isRateLimit) {
			this.#retryDelayRateLimit = Math.min(this.#retryDelayRateLimit * 2, maxDelay);
		} else {
			this.#retryDelay = Math.min(this.#retryDelay * 2, maxDelay);
		}
	}

	#cancelRetryTimer() {
		if (this.#retryTimer) {
			clearTimeout(this.#retryTimer);
			this.#retryTimer = null;
		}
	}

	#clearRetry() {
		this.#cancelRetryTimer();
		this.#retryDelay = 500;
	}

	/** Close the current connection without preventing future opens. */
	protected close() {
		const sessionId = this.#currentSession;
		this.#currentSession = null;
		if (this.#worker && sessionId !== null) {
			this.#worker.postMessage({ type: 'abort', id: sessionId } satisfies WorkerCommand);
		}
		this.#clearRetry();
	}

	/** Re-enable `open()` after a `destroy()`. No-op once permanently destroyed. */
	protected activate() {
		if (!this.#destroyed) this.#active = true;
	}

	/** Permanently close. Prevents any future connections on this instance. */
	destroy() {
		const t = this.tag;
		if (t) this.log.debug`destroy ${t}`;
		this.#destroyed = true;
		this.#active = false;
		this.close();
		if (this.#worker) {
			this.#worker.postMessage({ type: 'dispose' } satisfies WorkerCommand);
			this.#worker.terminate();
			this.#worker = null;
		}
	}

	[Symbol.dispose]() {
		this.destroy();
	}

	async [Symbol.asyncDispose]() {
		this.destroy();
	}
}
