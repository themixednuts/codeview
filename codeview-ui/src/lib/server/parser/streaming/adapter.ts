/**
 * Streaming parser adapter for local mode.
 *
 * Provides a ParserAdapter implementation that uses streaming parsing
 * for better memory efficiency with large rustdoc JSON files.
 *
 * This adapter is environment-agnostic and can be used in both local
 * and Cloudflare modes. Decompression is handled by the caller.
 */

import type { ParserAdapter, ParseResult, SourceFiles } from '../types';
import type { Node, Edge, Graph } from '$lib/graph';
import { createStreamingGraphBuilder, type BatchCallbacks } from './builder';
import { parseRustdocBuffer, type StreamingParseCallbacks, type ParseState } from './parser';
import { getLogger } from '$lib/log';

const log = getLogger('streaming-parser');

/** Threshold for using streaming vs monolithic parse (in bytes) */
export const STREAMING_THRESHOLD_BYTES = 10 * 1024 * 1024; // 10MB uncompressed

/**
 * Options for the streaming parser adapter.
 */
export interface StreamingParserOptions {
	/** Batch size for node/edge callbacks (default: 1000) */
	batchSize?: number;
	/** Skip external nodes to reduce graph size (default: true) */
	skipExternalNodes?: boolean;
	/** Callbacks for batch progress */
	batchCallbacks?: BatchCallbacks;
	/** Force streaming even for small files (default: false) */
	forceStreaming?: boolean;
}

/**
 * Creates a streaming rustdoc parser adapter.
 *
 * This parser uses streaming JSON parsing and the streaming graph builder
 * for memory-efficient processing of large rustdoc JSON files.
 *
 * @param options - Parser options
 * @returns A ParserAdapter that uses streaming parsing
 */
export function createStreamingRustdocParser(options: StreamingParserOptions = {}): ParserAdapter {
	const {
		batchSize = 1000,
		skipExternalNodes = true,
		batchCallbacks,
		forceStreaming = false
	} = options;

	return {
		async parse(artifact, name, version, sourceFiles) {
			const buffer = typeof artifact === 'string'
				? new TextEncoder().encode(artifact)
				: artifact instanceof Uint8Array
					? artifact
					: new Uint8Array(artifact);

			const crateName = name.replace(/-/g, '_');

			// Decide whether to use streaming based on size
			const useStreaming = forceStreaming || buffer.length > STREAMING_THRESHOLD_BYTES;

			if (!useStreaming) {
				// Fall back to monolithic parse for small files
				// Import dynamically to avoid circular dependency
				const { createRustdocParser } = await import('../rustdoc');
				const parser = createRustdocParser();
				return parser.parse(artifact, name, version, sourceFiles);
			}

			const t0 = performance.now();

			// Create the streaming graph builder
			const builder = createStreamingGraphBuilder(crateName, {
				batchSize,
				skipExternalNodes,
				batchCallbacks
			});

			const callbacks = builder.createParseCallbacks();

			// Parse the buffer through the streaming parser
			await parseRustdocBuffer(buffer, callbacks);

			// Finalize the graph (resolve deferred edges)
			const result = await builder.finalize();

			const elapsed = performance.now() - t0;
			log.info`streaming parsed ${crateName}: ${String(result.nodes.length)} nodes, ${String(result.edges.length)} edges in ${elapsed.toFixed(0)}ms`;

			// Extract external crates
			const externalCrates = result.externalCrates.map((ec) => ({
				id: ec.id,
				name: ec.name,
				version: null,
				nodes: [] as Node[]
			}));

			return {
				graph: {
					id: crateName,
					name: crateName,
					version,
					nodes: result.nodes,
					edges: result.edges
				},
				externalCrates
			} satisfies ParseResult;
		}
	};
}

/**
 * Parse a rustdoc JSON buffer using streaming for memory efficiency.
 *
 * This is a lower-level function that gives you direct access to the
 * streaming builder and its batch callbacks.
 *
 * @param buffer - The rustdoc JSON as a Uint8Array
 * @param crateName - The crate name (with underscores)
 * @param options - Parser options
 * @returns The built graph with nodes, edges, and external crates
 */
export async function parseRustdocStreaming(
	buffer: Uint8Array,
	crateName: string,
	options: StreamingParserOptions = {}
): Promise<{
	nodes: Node[];
	edges: Edge[];
	externalCrates: Array<{ id: string; name: string }>;
	root: number | null;
	crateVersion: string | null;
}> {
	const {
		batchSize = 1000,
		skipExternalNodes = true,
		batchCallbacks
	} = options;

	const builder = createStreamingGraphBuilder(crateName, {
		batchSize,
		skipExternalNodes,
		batchCallbacks
	});

	const callbacks = builder.createParseCallbacks();
	await parseRustdocBuffer(buffer, callbacks);

	return builder.finalize();
}

/**
 * Estimates whether a buffer should use streaming parsing.
 *
 * @param sizeBytes - Size of the buffer in bytes
 * @returns true if streaming is recommended
 */
export function shouldUseStreaming(sizeBytes: number): boolean {
	return sizeBytes > STREAMING_THRESHOLD_BYTES;
}
