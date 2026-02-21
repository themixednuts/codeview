/**
 * Streaming JSON parser for rustdoc JSON files.
 *
 * Uses @streamparser/json-whatwg to parse large JSON files without
 * loading the entire document into memory. The WHATWG version provides
 * a TransformStream that emits parsed elements.
 *
 * The parser is exposed as an async generator so consumers can iterate
 * with `for await...of` and control back-pressure naturally.
 *
 * This module is environment-agnostic - decompression is handled
 * by the caller, making it usable in both Cloudflare and local modes.
 */

import { JSONParser } from '@streamparser/json-whatwg';
import { type StackElement } from '@streamparser/json';
import type { Id, Item, ItemSummary, ExternalCrate } from '../rustdoc.types';
import { getLogger } from '$lib/log';
import { DEFAULT_BATCH_SIZE } from './builder';

const log = getLogger('streaming-parser');

/**
 * Parsed element info from the JSON parser.
 * Re-defined here to avoid namespace import issues.
 */
export interface ParsedElementInfo {
	value?: unknown;
	parent?: unknown;
	key?: string | number;
	stack: StackElement[];
	partial?: boolean;
}

/**
 * Typed rustdoc element emitted by the async generator.
 */
export type RustdocElement =
	| { type: 'root'; id: Id }
	| { type: 'crate_version'; version: string | null }
	| { type: 'item'; id: string; item: Item }
	| { type: 'path'; id: string; summary: ItemSummary }
	| { type: 'external_crate'; id: string; crate: ExternalCrate };

/**
 * Parse state tracking for streaming parser.
 */
export interface ParseState {
	root: Id | null;
	crateVersion: string | null;
	itemCount: number;
	pathCount: number;
	externalCrateCount: number;
}

/**
 * Creates a streaming rustdoc JSON parser using WHATWG TransformStream.
 *
 * The parser extracts specific paths from the JSON document:
 * - $.root - the crate root ID
 * - $.crate_version - the crate version string
 * - $.index.* - all items in the index
 * - $.paths.* - all path summaries
 * - $.external_crates.* - all external crate references
 */
export function createRustdocJsonParser(): InstanceType<typeof JSONParser> {
	return new JSONParser({
		paths: ['$.root', '$.crate_version', '$.index.*', '$.paths.*', '$.external_crates.*'],
		keepStack: false,
	});
}

/**
 * Creates initial parse state.
 */
export function createParseState(): ParseState {
	return {
		root: null,
		crateVersion: null,
		itemCount: 0,
		pathCount: 0,
		externalCrateCount: 0,
	};
}

/**
 * Classify a raw ParsedElementInfo into a typed RustdocElement.
 * Returns null for unrecognized or valueless elements.
 */
function classify(info: ParsedElementInfo, state: ParseState): RustdocElement | null {
	if (info.value === undefined) return null;

	const rawKeys = info.stack.map((s: StackElement) => s.key);
	const stackPath = rawKeys.filter((k) => k !== '' && k != null).join('.');
	const key = info.key;

	if (state.itemCount < 3 && state.pathCount < 3) {
		log.debug`element: rawKeys=${JSON.stringify(rawKeys)} stackPath="${stackPath}" key="${String(key)}"`;
	}

	if (stackPath === '' && key === 'root') {
		state.root = info.value as Id;
		return { type: 'root', id: info.value as Id };
	} else if (stackPath === '' && key === 'crate_version') {
		state.crateVersion = info.value as string | null;
		return { type: 'crate_version', version: info.value as string | null };
	} else if (stackPath === 'index' && typeof key === 'string') {
		state.itemCount++;
		return { type: 'item', id: key, item: info.value as Item };
	} else if (stackPath === 'paths' && typeof key === 'string') {
		state.pathCount++;
		return { type: 'path', id: key, summary: info.value as ItemSummary };
	} else if (stackPath === 'external_crates' && typeof key === 'string') {
		state.externalCrateCount++;
		return { type: 'external_crate', id: key, crate: info.value as ExternalCrate };
	}
	return null;
}

/** Options for the async generator. */
export interface IterateOptions {
	/** Pre-existing parse state to continue from. */
	state?: ParseState;
	/**
	 * How many elements to process between macro-task yields.
	 * Defaults to {@link DEFAULT_BATCH_SIZE}.
	 * CF uses 200 (DO RPC payload limits); local uses 1000.
	 */
	yieldInterval?: number;
}

/**
 * Async generator that yields typed rustdoc elements from a text stream.
 *
 * Every `yieldInterval` elements (default {@link DEFAULT_BATCH_SIZE}),
 * yields to the macro-task queue via `setTimeout` so the server thread
 * stays responsive for concurrent requests. Async generator `yield` alone
 * only posts a microtask which does not free the event loop for I/O —
 * hence the explicit setTimeout.
 */
export async function* iterateRustdocStream(
	source: ReadableStream<string>,
	opts: IterateOptions = {},
): AsyncGenerator<RustdocElement, ParseState> {
	const state = opts.state ?? createParseState();
	const interval = opts.yieldInterval ?? DEFAULT_BATCH_SIZE;
	const parser = createRustdocJsonParser();
	const parsedStream = source.pipeThrough(parser);
	const reader = parsedStream.getReader();
	let sinceYield = 0;
	const t0 = performance.now();
	let yieldCount = 0;
	let maxYieldGap = 0;
	let lastYieldAt = t0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			const el = classify(value as ParsedElementInfo, state);
			if (el) {
				yield el;
				// setTimeout posts to the macro-task queue, giving the event
				// loop a chance to service other connections/parses. A plain
				// `yield` (microtask) would not do this.
				if (++sinceYield >= interval) {
					sinceYield = 0;
					yieldCount++;
					const now = performance.now();
					const gap = now - lastYieldAt;
					if (gap > maxYieldGap) maxYieldGap = gap;
					lastYieldAt = now;
					await new Promise<void>((r) => setTimeout(r));
				}
			}
		}
	} finally {
		reader.releaseLock();
	}

	const elapsed = performance.now() - t0;
	const total = state.itemCount + state.pathCount + state.externalCrateCount;
	log.info`iterate done: ${total} elements, ${yieldCount} yields, maxGap=${maxYieldGap.toFixed(0)}ms, total=${elapsed.toFixed(0)}ms`;

	return state;
}

/**
 * Async generator over a byte stream. Handles text decoding internally.
 */
export async function* iterateRustdocByteStream(
	byteStream: ReadableStream<Uint8Array>,
	opts?: IterateOptions,
): AsyncGenerator<RustdocElement, ParseState> {
	const textDecoder = new TextDecoderStream();
	const textStream = byteStream.pipeThrough(
		textDecoder as unknown as TransformStream<Uint8Array, string>,
	);
	return yield* iterateRustdocStream(textStream, opts);
}

/**
 * Async generator over a fetch Response body.
 *
 * Note: Does NOT handle decompression. Decompress before calling, or use
 * environment-specific wrappers that handle gzip.
 */
export async function* iterateRustdocResponse(
	response: Response,
	opts?: IterateOptions,
): AsyncGenerator<RustdocElement, ParseState> {
	if (!response.body) {
		throw new Error('Response has no body');
	}
	return yield* iterateRustdocByteStream(response.body, opts);
}

// ---------------------------------------------------------------------------
// Legacy callback API — thin wrappers over the async generator
// ---------------------------------------------------------------------------

/**
 * Callbacks invoked during streaming parse.
 * Each callback is called as soon as the corresponding data is available.
 */
export interface StreamingParseCallbacks {
	onRoot: (root: Id) => void;
	onCrateVersion: (version: string | null) => void;
	onItem: (id: string, item: Item) => void;
	onPath: (id: string, summary: ItemSummary) => void;
	onExternalCrate: (id: string, crate: ExternalCrate) => void;
	onComplete?: () => void;
	onError?: (error: Error) => void;
}

/** Consume the async generator and dispatch to callbacks. */
async function drainToCallbacks(
	gen: AsyncGenerator<RustdocElement, ParseState>,
	callbacks: StreamingParseCallbacks,
): Promise<ParseState> {
	const t0 = performance.now();
	let callbackMs = 0;
	try {
		let result = await gen.next();
		while (!result.done) {
			const el = result.value;
			const tc = performance.now();
			switch (el.type) {
				case 'root':
					callbacks.onRoot(el.id);
					break;
				case 'crate_version':
					callbacks.onCrateVersion(el.version);
					break;
				case 'item':
					callbacks.onItem(el.id, el.item);
					break;
				case 'path':
					callbacks.onPath(el.id, el.summary);
					break;
				case 'external_crate':
					callbacks.onExternalCrate(el.id, el.crate);
					break;
			}
			callbackMs += performance.now() - tc;
			result = await gen.next();
		}
		callbacks.onComplete?.();
		const elapsed = performance.now() - t0;
		log.info`drain done: total=${elapsed.toFixed(0)}ms callbackTime=${callbackMs.toFixed(0)}ms`;
		return result.value;
	} catch (err) {
		callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
		throw err;
	}
}

export async function parseRustdocStream(
	source: ReadableStream<string>,
	callbacks: StreamingParseCallbacks,
	opts?: IterateOptions,
): Promise<ParseState> {
	return drainToCallbacks(iterateRustdocStream(source, opts), callbacks);
}

export async function parseRustdocByteStream(
	byteStream: ReadableStream<Uint8Array>,
	callbacks: StreamingParseCallbacks,
	opts?: IterateOptions,
): Promise<ParseState> {
	return drainToCallbacks(iterateRustdocByteStream(byteStream, opts), callbacks);
}

export async function parseRustdocResponse(
	response: Response,
	callbacks: StreamingParseCallbacks,
	opts?: IterateOptions,
): Promise<ParseState> {
	return drainToCallbacks(iterateRustdocResponse(response, opts), callbacks);
}
