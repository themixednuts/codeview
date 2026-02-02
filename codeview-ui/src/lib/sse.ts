import { Result } from 'better-result';
import type { Logger } from '@logtape/logtape';

/**
 * Base class for reactive SSE connections.
 * Uses fetch + AbortController for connection management.
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
export abstract class SSEConnection implements Disposable {
	#abort: AbortController | null = null;
	#active = true;
	#destroyed = false;

	protected abstract readonly log: Logger;

	/** Short identifier for log lines (e.g. `"serde@1.0"`). */
	protected abstract get tag(): string;

	/** Full SSE endpoint URL. */
	protected abstract get endpoint(): string;

	/** Handle a parsed JSON message from the stream. */
	protected abstract onData(data: unknown): void;

	/** Whether the connection is currently open. */
	get connected() {
		return this.#abort !== null;
	}

	/**
	 * Open a new SSE connection. Closes any existing connection first.
	 * No-op after `destroy()`.
	 */
	protected open() {
		if (this.#destroyed || !this.#active) return;
		this.close();
		this.log.debug`open ${this.tag}`;

		const controller = new AbortController();
		this.#abort = controller;

		this.#read(controller).catch(() => {
			// Silently ignore — errors are logged inside #read
		});
	}

	async #read(controller: AbortController) {
		const fetchResult = await Result.tryPromise(() => fetch(this.endpoint, { signal: controller.signal }));
		if (fetchResult.isErr()) {
			if (controller.signal.aborted) return;
			this.log.warn`fetch error ${this.tag}: ${fetchResult.error}`;
			if (this.#abort === controller) this.#abort = null;
			return;
		}

		const response = fetchResult.value;
		if (!response.ok || !response.body) {
			this.log.warn`bad response ${this.tag}: ${String(response.status)}`;
			if (this.#abort === controller) this.#abort = null;
			return;
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });

				// Process complete SSE events (separated by \n\n)
				let idx;
				while ((idx = buffer.indexOf('\n\n')) !== -1) {
					const event = buffer.slice(0, idx);
					buffer = buffer.slice(idx + 2);

					for (const line of event.split('\n')) {
						if (line.startsWith('data: ')) {
							const parseResult = Result.try(() => JSON.parse(line.slice(6)));
							if (parseResult.isErr()) {
								this.log.warn`parse error ${this.tag}: ${parseResult.error}`;
							} else {
								this.onData(parseResult.value);
							}
						}
						// SSE comments (`: ...`) are silently ignored
					}
				}
			}
		} catch (err) {
			if (controller.signal.aborted) return;
			this.log.warn`read error ${this.tag}: ${String(err)}`;
		} finally {
			if (this.#abort === controller) this.#abort = null;
		}

		// Stream ended normally (server TTL) — reconnect if still active
		if (!controller.signal.aborted && !this.#destroyed && this.#active) {
			this.log.debug`reconnect ${this.tag}`;
			this.open();
		}
	}

	/** Close the current connection without preventing future opens. */
	protected close() {
		if (this.#abort) {
			this.#abort.abort();
			this.#abort = null;
		}
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
	}

	[Symbol.dispose]() {
		this.destroy();
	}
}
