/**
 * Streaming JSON parser for rustdoc JSON files.
 *
 * Uses @streamparser/json-whatwg to parse large JSON files without
 * loading the entire document into memory. The WHATWG version provides
 * a TransformStream that emits parsed elements.
 *
 * This module is environment-agnostic - decompression is handled
 * by the caller, making it usable in both Cloudflare and local modes.
 */

import { JSONParser } from '@streamparser/json-whatwg';
import { type StackElement } from '@streamparser/json';
import type {
	Id,
	Item,
	ItemSummary,
	ExternalCrate
} from '../rustdoc.types';
import { getLogger } from '$lib/log';

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
 * Callbacks invoked during streaming parse.
 * Each callback is called as soon as the corresponding data is available.
 */
export interface StreamingParseCallbacks {
	/** Called once when root ID is found */
	onRoot: (root: Id) => void;
	/** Called once when crate_version is found */
	onCrateVersion: (version: string | null) => void;
	/** Called for each item in $.index.* */
	onItem: (id: string, item: Item) => void;
	/** Called for each path in $.paths.* */
	onPath: (id: string, summary: ItemSummary) => void;
	/** Called for each external crate in $.external_crates.* */
	onExternalCrate: (id: string, crate: ExternalCrate) => void;
	/** Called when parsing is complete */
	onComplete?: () => void;
	/** Called on parse error */
	onError?: (error: Error) => void;
}

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
 *
 * @returns A TransformStream that accepts text and emits ParsedElementInfo
 */
export function createRustdocJsonParser(): InstanceType<typeof JSONParser> {
	return new JSONParser({
		paths: [
			'$.root',
			'$.crate_version',
			'$.index.*',
			'$.paths.*',
			'$.external_crates.*'
		],
		keepStack: false
	});
}

/**
 * Process a ParsedElementInfo and invoke appropriate callbacks.
 */
export function processParsedElement(
	info: ParsedElementInfo,
	callbacks: StreamingParseCallbacks,
	state: ParseState
): void {
	if (info.value === undefined) return;

	// Stack path - the root element has empty string key, filter it out
	const rawKeys = info.stack.map((s: StackElement) => s.key);
	const stackPath = rawKeys.filter(k => k !== '' && k != null).join('.');
	const key = info.key;

	// Debug: log first few elements to understand structure
	if (state.itemCount < 3 && state.pathCount < 3) {
		log.debug`element: rawKeys=${JSON.stringify(rawKeys)} stackPath="${stackPath}" key="${String(key)}"`;
	}

	if (stackPath === '' && key === 'root') {
		state.root = info.value as Id;
		callbacks.onRoot(info.value as Id);
	} else if (stackPath === '' && key === 'crate_version') {
		state.crateVersion = info.value as string | null;
		callbacks.onCrateVersion(info.value as string | null);
	} else if (stackPath === 'index' && typeof key === 'string') {
		state.itemCount++;
		callbacks.onItem(key, info.value as Item);
	} else if (stackPath === 'paths' && typeof key === 'string') {
		state.pathCount++;
		callbacks.onPath(key, info.value as ItemSummary);
	} else if (stackPath === 'external_crates' && typeof key === 'string') {
		state.externalCrateCount++;
		callbacks.onExternalCrate(key, info.value as ExternalCrate);
	}
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
		externalCrateCount: 0
	};
}

/**
 * Pipes a readable text stream through the streaming parser.
 * This is the main entry point for streaming parsing.
 *
 * @param source - Source text stream (e.g., from TextDecoderStream)
 * @param callbacks - Parse callbacks
 * @returns Promise that resolves with final parse state
 */
export async function parseRustdocStream(
	source: ReadableStream<string>,
	callbacks: StreamingParseCallbacks
): Promise<ParseState> {
	const parser = createRustdocJsonParser();
	const parsedStream = source.pipeThrough(parser);
	const state = createParseState();

	const reader = parsedStream.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			processParsedElement(value as ParsedElementInfo, callbacks, state);
		}
		callbacks.onComplete?.();
	} catch (err) {
		callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
		throw err;
	} finally {
		reader.releaseLock();
	}

	return state;
}

/**
 * Parses a byte stream (e.g., from fetch response or file) through the streaming parser.
 * Handles text decoding internally.
 *
 * @param byteStream - Source byte stream
 * @param callbacks - Parse callbacks
 * @returns Promise that resolves with final parse state
 */
export async function parseRustdocByteStream(
	byteStream: ReadableStream<Uint8Array>,
	callbacks: StreamingParseCallbacks
): Promise<ParseState> {
	const textDecoder = new TextDecoderStream();
	const textStream = byteStream.pipeThrough(textDecoder as unknown as TransformStream<Uint8Array, string>);
	return parseRustdocStream(textStream, callbacks);
}

/**
 * Parses a fetch Response through the streaming parser.
 * Convenience wrapper that handles the response body stream.
 *
 * Note: This does NOT handle decompression. If the response is compressed,
 * decompress the body before calling this function, or use the environment-specific
 * parse functions that handle decompression (gzip streams in hosted/local).
 *
 * @param response - Fetch response with JSON body
 * @param callbacks - Parse callbacks
 * @returns Promise that resolves with final parse state
 */
export async function parseRustdocResponse(
	response: Response,
	callbacks: StreamingParseCallbacks
): Promise<ParseState> {
	if (!response.body) {
		throw new Error('Response has no body');
	}
	return parseRustdocByteStream(response.body, callbacks);
}
