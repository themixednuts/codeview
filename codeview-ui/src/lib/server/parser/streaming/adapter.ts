/**
 * Streaming parser utilities for rustdoc JSON parsing.
 *
 * Provides progressive parsing helpers that operate on byte streams
 * so parsing can begin before the full payload is available.
 */

import type { Node, Edge } from '$lib/graph';
import type { CrateTree } from '$lib/schema';
import { createStreamingGraphBuilder, type ProgressiveStorageCallbacks } from './builder';
import { parseRustdocByteStream } from './parser';
import { getLogger } from '$lib/log';
import { perf } from '$lib/perf';
import { normalizeCrateName } from '$lib/crate-names';

const log = getLogger('streaming-parser');

/**
 * Result from progressive parsing - no full graph, just metadata.
 */
export interface ProgressiveParseResult {
	nodeCount: number;
	edgeCount: number;
	tree: CrateTree;
	externalCrates: Array<{ id: string; name: string }>;
	crateVersion: string | null;
}

/**
 * Input source for progressive parsing.
 *
 * Streaming byte input allows parsing to begin before the full payload
 * has downloaded, per the progressive JSON approach.
 */
export type ProgressiveParseInput = ReadableStream<Uint8Array>;

/**
 * Progress update emitted during parsing.
 * Tree payloads are no longer sent — the sidebar uses lazy RPC instead.
 */
export interface ParseProgress {
	type: 'delta' | 'complete';
	nodeCount: number;
	edgeCount: number;
	/** Total items parsed (sent in 'complete' event) */
	totalItems?: number;
}

/**
 * Parse a rustdoc JSON stream or buffer with progressive storage.
 *
 * Nodes and edges are stored directly to the database via callbacks,
 * without accumulating in memory. This enables parsing very large crates
 * (100K+ nodes) without memory issues.
 *
 * @param input - The rustdoc JSON as a Uint8Array or ReadableStream
 * @param crateName - The crate name (hyphens will be normalized to underscores)
 * @param storageCallbacks - Callbacks for progressive database storage
 * @param options - Additional options
 * @returns Metadata about the parsed crate (no full graph)
 */
export async function parseWithProgressiveStorage(
	input: ProgressiveParseInput,
	crateName: string,
	storageCallbacks: ProgressiveStorageCallbacks,
	options: {
		batchSize?: number;
		skipExternalNodes?: boolean;
		retainItemIndex?: boolean;
		dedupeEdgesInMemory?: boolean;
		pruneOrphanTreeNodes?: boolean;
		yieldInterval?: number;
		/** Called periodically with progress updates */
		onProgress?: (progress: ParseProgress) => void;
	} = {},
): Promise<ProgressiveParseResult> {
	const {
		batchSize = 1000,
		skipExternalNodes = true,
		retainItemIndex = true,
		dedupeEdgesInMemory = true,
		pruneOrphanTreeNodes = true,
		yieldInterval = batchSize,
		onProgress,
	} = options;

	const normalizedName = normalizeCrateName(crateName);
	const t0 = performance.now();

	// Track tree data during streaming (needed for return value + orphan filter)
	const treeNodeMap = pruneOrphanTreeNodes ? new Map<string, CrateTree['nodes'][number]>() : null;
	const treeNodes: CrateTree['nodes'] = [];
	const treeEdges: CrateTree['edges'] = [];

	// Progress tracking
	let nodeCount = 0;
	let edgeCount = 0;
	let firstDeltaSent = false;
	// Time-based emission for responsive UI
	let lastEmitMs = performance.now();
	const emitTimeoutMs = 250; // Emit at least every 250ms for responsive UI

	function emitProgress() {
		if (!onProgress) return;
		lastEmitMs = performance.now();
		onProgress({
			type: 'delta',
			nodeCount,
			edgeCount,
		});
	}

	function shouldEmit(): boolean {
		return performance.now() - lastEmitMs >= emitTimeoutMs;
	}

	// Wrap storage callbacks to also collect tree data
	const wrappedStorageCallbacks: ProgressiveStorageCallbacks = {
		storeNodes: async (nodes) => {
			// Collect tree nodes (non-external only)
			for (const node of nodes) {
				if (!node.is_external) {
					const treeNode = {
						id: node.id,
						name: node.name,
						kind: node.kind,
						visibility: node.visibility,
						is_external: node.is_external,
						...(node.kind === 'Impl'
							? {
									impl_trait: node.impl_trait,
									generics: node.generics,
									where_clause: node.where_clause,
									bound_links: node.bound_links,
								}
							: {}),
					};
					if (treeNodeMap) {
						treeNodeMap.set(node.id, treeNode);
					} else {
						treeNodes.push(treeNode);
					}
				}
			}

			// Track and emit progress BEFORE awaiting DO write
			nodeCount += nodes.length;

			// Emit logic: first delta immediately, then time-based
			if (!firstDeltaSent && nodeCount > 0) {
				firstDeltaSent = true;
				emitProgress();
			} else if (shouldEmit()) {
				emitProgress();
			}

			await storageCallbacks.storeNodes(nodes);
		},
		storeEdges: async (edges) => {
			// Track and emit progress BEFORE awaiting DO write
			edgeCount += edges.length;

			// Collect tree edges (Contains/Defines) — batch all at end for orphan filter
			for (const edge of edges) {
				if (edge.kind === 'Contains' || edge.kind === 'Defines') {
					treeEdges.push(edge);
				}
			}

			// Emit if time elapsed
			if (firstDeltaSent && shouldEmit()) {
				emitProgress();
			}

			await storageCallbacks.storeEdges(edges);
		},
		updateNode: storageCallbacks.updateNode,
	};

	// Create the streaming graph builder with progressive storage
	const builder = createStreamingGraphBuilder(normalizedName, {
		batchSize,
		skipExternalNodes,
		retainItemIndex,
		dedupeEdgesInMemory,
		storageCallbacks: wrappedStorageCallbacks,
	});

	const callbacks = builder.createParseCallbacks();

	// Parse the stream through the streaming parser
	const tParse = performance.now();
	await parseRustdocByteStream(input, callbacks, { yieldInterval });
	const parseElapsed = performance.now() - tParse;
	log.info`parse phase: ${parseElapsed.toFixed(0)}ms`;

	// Finalize (resolves deferred edges, stores remaining batches)
	const tFinalize = performance.now();
	const result = await builder.finalize();
	const finalizeElapsed = performance.now() - tFinalize;
	log.info`finalize phase: ${finalizeElapsed.toFixed(0)}ms`;

	const elapsed = performance.now() - t0;
	log.info`progressive parsed ${normalizedName}: ${String(result.nodeCount)} nodes, ${String(result.edgeCount)} edges in ${elapsed.toFixed(0)}ms`;

	let filteredNodes = treeNodes;
	let filteredEdges = treeEdges;

	if (pruneOrphanTreeNodes) {
		const nodes = Array.from(treeNodeMap?.values() ?? []);
		const validTreeEdges = treeEdges.filter(
			(e) => Boolean(treeNodeMap?.has(e.from)) && Boolean(treeNodeMap?.has(e.to)),
		);
		filteredNodes = nodes;
		filteredEdges = validTreeEdges;

		// Server-side orphan filtering: only keep nodes reachable from Crate roots via Contains/Defines
		const tFilter = performance.now();
		const childMap = new Map<string, string[]>();
		for (const edge of validTreeEdges) {
			if (!childMap.has(edge.from)) childMap.set(edge.from, []);
			childMap.get(edge.from)!.push(edge.to);
		}
		const reachable = new Set<string>();
		const crateIds = nodes.filter((n) => n.kind === 'Crate').map((n) => n.id);
		const queue = [...crateIds];
		for (const id of queue) {
			if (reachable.has(id)) continue;
			reachable.add(id);
			const children = childMap.get(id);
			if (children) queue.push(...children);
		}
		if (reachable.size < nodes.length) {
			filteredNodes = nodes.filter((n) => reachable.has(n.id));
			filteredEdges = validTreeEdges.filter((e) => reachable.has(e.from) && reachable.has(e.to));
		}
		const filterElapsed = performance.now() - tFilter;
		log.info`orphan filter: ${filteredNodes.length}/${nodes.length} nodes, ${filteredEdges.length}/${validTreeEdges.length} edges in ${filterElapsed.toFixed(0)}ms`;
	} else {
		log.info`orphan filter: skipped (${treeNodes.length} nodes, ${treeEdges.length} edges)`;
	}

	// Emit complete event with totalItems
	if (onProgress) {
		onProgress({
			type: 'complete',
			nodeCount: result.nodeCount,
			edgeCount: result.edgeCount,
			totalItems: result.nodeCount,
		});
	}

	return {
		nodeCount: result.nodeCount,
		edgeCount: result.edgeCount,
		tree: { nodes: filteredNodes, edges: filteredEdges },
		externalCrates: result.externalCrates,
		crateVersion: result.crateVersion,
	};
}
