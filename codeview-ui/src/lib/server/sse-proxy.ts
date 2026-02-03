export const SSE_HEADERS = {
	'Content-Type': 'text/event-stream',
	'Cache-Control': 'no-cache',
	Connection: 'keep-alive'
} as const;

export interface SSEOptions {
	/**
	 * Maximum time (ms) the connection stays open before the server
	 * closes it. The client can reconnect if still interested.
	 * Prevents zombie connections from exhausting HTTP/1.1's
	 * 6-connection-per-origin limit when the server can't detect
	 * client disconnects (common with Bun).
	 */
	ttl?: number;
}

/**
 * Create an SSE response that sends initial event(s) then stays open
 * until the TTL expires or the client disconnects.
 */
export function sseResponse(data: string, signal: AbortSignal, options?: SSEOptions): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		start(controller) {
			let closed = false;
			const doClose = () => {
				if (closed) return;
				closed = true;
				if (ttlTimer !== undefined) clearTimeout(ttlTimer);
				try {
					controller.close();
				} catch {}
			};

			if (data) {
				controller.enqueue(encoder.encode(data));
			}

			const ttlTimer = options?.ttl ? setTimeout(doClose, options.ttl) : undefined;
			signal.addEventListener('abort', doClose, { once: true });
		}
	});
	return new Response(stream, { headers: SSE_HEADERS });
}

/**
 * Create an SSE response that pushes multiple events via a subscribe function.
 * `subscribe` receives a `push` callback for sending data and a `close` callback
 * for ending the stream. It must return an unsubscribe function for cleanup.
 */
export function sseStreamResponse(
	subscribe: (push: (data: string) => void, close: () => void) => () => void,
	signal: AbortSignal,
	options?: SSEOptions
): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		start(controller) {
			let closed = false;
			const doClose = () => {
				if (closed) return;
				closed = true;
				if (ttlTimer !== undefined) clearTimeout(ttlTimer);
				unsubscribe();
				try {
					controller.close();
				} catch {}
			};
			const unsubscribe = subscribe(
				(data) => {
					if (!closed) {
						try {
							controller.enqueue(encoder.encode(data));
						} catch {
							doClose();
						}
					}
				},
				doClose
			);

			const ttlTimer = options?.ttl ? setTimeout(doClose, options.ttl) : undefined;
			signal.addEventListener('abort', doClose, { once: true });
		}
	});
	return new Response(stream, { headers: SSE_HEADERS });
}
