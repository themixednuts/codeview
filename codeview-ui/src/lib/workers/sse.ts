/// <reference lib="webworker" />

type ConnectMessage = { type: 'connect'; id: number; endpoint: string };
type AbortMessage = { type: 'abort'; id: number };
type DisposeMessage = { type: 'dispose' };
type IncomingMessage = ConnectMessage | AbortMessage | DisposeMessage;

type OutgoingMessage =
	| { type: 'ready'; id: number }
	| { type: 'data'; id: number; payload: unknown }
	| { type: 'warn'; id: number; error: string }
	| { type: 'end'; id: number; reason: 'eof' | 'aborted' | 'fetch-error' | 'bad-response' | 'read-error'; detail?: string };

const ctx = self as DedicatedWorkerGlobalScope;

let activeId: number | null = null;
let activeController: AbortController | null = null;
let disposed = false;

const post = (message: OutgoingMessage) => {
	if (!disposed) ctx.postMessage(message);
};

const isActive = (id: number) => activeId === id && !disposed;

const abortActive = (id: number) => {
	if (activeId !== id) return;
	activeController?.abort();
};

const resetActive = (id: number) => {
	if (activeId === id) {
		activeId = null;
		activeController = null;
	}
};

const parseEvent = (event: string, id: number) => {
	// SSE allows multi-line data payloads:
	// data: line1
	// data: line2
	// -> "line1\nline2"
	const dataLines: string[] = [];
	for (const rawLine of event.split('\n')) {
		const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
		if (!line.startsWith('data:')) continue;
		let payload = line.slice(5);
		if (payload.startsWith(' ')) payload = payload.slice(1);
		dataLines.push(payload);
	}
	if (dataLines.length === 0) return;
	const payload = dataLines.join('\n');
	if (!payload) return;
	try {
		const parsed = JSON.parse(payload) as unknown;
		if (isActive(id)) post({ type: 'data', id, payload: parsed });
	} catch (err) {
		if (isActive(id)) post({ type: 'warn', id, error: String(err) });
	}
};

const streamSse = async (id: number, endpoint: string, controller: AbortController) => {
	let response: Response;
	try {
		response = await fetch(endpoint, { signal: controller.signal });
	} catch (err) {
		if (controller.signal.aborted) {
			if (isActive(id)) post({ type: 'end', id, reason: 'aborted' });
			resetActive(id);
			return;
		}
		if (isActive(id)) post({ type: 'end', id, reason: 'fetch-error', detail: String(err) });
		resetActive(id);
		return;
	}

	if (!isActive(id)) {
		// Consume and discard response to close connection properly
		void response.body?.cancel();
		return;
	}

	if (!response.ok || !response.body) {
		const detail = response.ok ? 'missing body' : String(response.status);
		post({ type: 'end', id, reason: 'bad-response', detail });
		// Consume error response body to close connection
		void response.body?.cancel();
		resetActive(id);
		return;
	}

	post({ type: 'ready', id });

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!isActive(id)) return;
			buffer += decoder.decode(value, { stream: true });

			let idx = -1;
			while (true) {
				const lfLf = buffer.indexOf('\n\n');
				const crlfCrlf = buffer.indexOf('\r\n\r\n');
				if (lfLf === -1 && crlfCrlf === -1) break;
				if (crlfCrlf === -1 || (lfLf !== -1 && lfLf < crlfCrlf)) {
					idx = lfLf;
					const event = buffer.slice(0, idx);
					buffer = buffer.slice(idx + 2);
					parseEvent(event, id);
				} else {
					idx = crlfCrlf;
					const event = buffer.slice(0, idx);
					buffer = buffer.slice(idx + 4);
					parseEvent(event, id);
				}
			}
		}
		// Final unterminated event chunk (some proxies omit trailing separator)
		if (buffer.length > 0 && isActive(id)) {
			parseEvent(buffer, id);
		}
	} catch (err) {
		if (!isActive(id)) return;
		if (controller.signal.aborted) {
			post({ type: 'end', id, reason: 'aborted' });
			resetActive(id);
			return;
		}
		post({ type: 'end', id, reason: 'read-error', detail: String(err) });
		resetActive(id);
		return;
	}

	if (isActive(id)) post({ type: 'end', id, reason: 'eof' });
	resetActive(id);
};

ctx.addEventListener('message', (event: MessageEvent<IncomingMessage>) => {
	const message = event.data;
	if (message.type === 'dispose') {
		disposed = true;
		activeController?.abort();
		activeController = null;
		activeId = null;
		return;
	}

	if (message.type === 'abort') {
		abortActive(message.id);
		return;
	}

	if (disposed) return;

	activeController?.abort();
	const controller = new AbortController();
	activeController = controller;
	activeId = message.id;
	void streamSse(message.id, message.endpoint, controller);
});

export {};
