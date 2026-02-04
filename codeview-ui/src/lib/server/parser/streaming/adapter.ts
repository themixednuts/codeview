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

import type { PathStructureMetadata } from '$lib/path-structure';

/**
 * Delta update emitted during parsing.
 */
export interface ParseProgress {
	type: 'delta' | 'snapshot';
	sequence: number;
	contentId?: string;
	nodeCount: number;
	edgeCount: number;
	/** Partial tree available so far */
	tree?: CrateTree;
	/** Path structure metadata for accurate skeleton rendering */
	pathStructure?: PathStructureMetadata;
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
		/** Called periodically with progress updates */
		onProgress?: (progress: ParseProgress) => void;
		/** How often to emit progress (in nodes). Default: 5000 */
		progressInterval?: number;
		/** How often to emit full snapshot events (in nodes). Default: 20000 */
		snapshotInterval?: number;
		/** Identifier for the artifact content (etag/hash). */
		contentId?: string;
	} = {}
): Promise<ProgressiveParseResult> {
	const {
		batchSize = 1000,
		skipExternalNodes = true,
		onProgress,
		progressInterval = 5000,
		snapshotInterval = 20000,
		contentId
	} = options;

	const normalizedName = crateName.replace(/-/g, '_');
	const t0 = performance.now();

	// Track tree data during streaming
	const treeNodes: CrateTree['nodes'] = [];
	const treeEdges: CrateTree['edges'] = [];
	const internalNodeIds = new Set<string>();
	// Candidate tree edges awaiting filtering (edges may arrive before nodes)
	const pendingTreeEdges: CrateTree['edges'] = [];

	// Track path structure for accurate skeleton rendering
	// Maps parent node ID -> Set of child node IDs (only for tree-structure Contains edges)
	const parentChildMap = new Map<string, Set<string>>();
	// Track which nodes have been fully processed (have all their children)
	const completedNodes = new Set<string>();

	// Progress tracking
	let nodeCount = 0;
	let edgeCount = 0;
	let lastProgressAt = 0;
	let lastEdgeProgressAt = 0;
	let lastSnapshotAt = 0;
	let firstDeltaSent = false;
	let firstEdgeDeltaSent = false;
	let progressSequence = 0;
	// Delta tracking - only send new nodes/edges since last emit
	let lastSentNodeIndex = 0;
	let lastSentEdgeIndex = 0;

	/**
	 * Filter pending tree edges against internalNodeIds.
	 * Moves edges where both endpoints exist to treeEdges.
	 * Edges with unknown endpoints remain in pendingTreeEdges for later.
	 */
	function flushPendingTreeEdges(): void {
		let i = 0;
		while (i < pendingTreeEdges.length) {
			const edge = pendingTreeEdges[i];
			if (internalNodeIds.has(edge.from) && internalNodeIds.has(edge.to)) {
				treeEdges.push(edge);
				// Remove from pending by swapping with last element
				pendingTreeEdges[i] = pendingTreeEdges[pendingTreeEdges.length - 1];
				pendingTreeEdges.pop();
			} else {
				i++;
			}
		}
	}

	function emitProgress(
		type: 'delta' | 'snapshot',
		includeTree = false,
		advanceCursor = includeTree,
		fullTree = false,
		includePathStructure = false
	) {
		if (onProgress) {
			// Filter any pending edges that now have known endpoints
			flushPendingTreeEdges();

			// Build delta - only nodes/edges since last emit
			const deltaNodes = includeTree
				? (fullTree ? treeNodes : treeNodes.slice(lastSentNodeIndex))
				: undefined;
			const deltaEdges = includeTree
				? (fullTree ? treeEdges : treeEdges.slice(lastSentEdgeIndex))
				: undefined;

			if (advanceCursor) {
				lastSentNodeIndex = treeNodes.length;
				lastSentEdgeIndex = treeEdges.length;
			}

			const tree = includeTree
				? { nodes: deltaNodes ?? treeNodes, edges: deltaEdges ?? treeEdges }
				: undefined;

			// Build path structure metadata for accurate skeleton rendering
			let pathStructure: PathStructureMetadata | undefined;
			if (includePathStructure && parentChildMap.size > 0) {
				const childCounts: Record<string, number> = {};
				for (const [parentId, children] of parentChildMap) {
					childCounts[parentId] = children.size;
				}
				pathStructure = {
					childCounts,
					completedNodes: Array.from(completedNodes),
					timestamp: Date.now()
				};
			}

			const detail = tree ? `${String(tree.nodes.length)}n ${String(tree.edges.length)}e` : 'no-tree';
			if (type === 'snapshot') {
				perf.event('parser', 'snapshot', `${String(nodeCount)} total (${detail})`);
			}
			onProgress({
				type,
				sequence: progressSequence++,
				contentId,
				nodeCount,
				edgeCount,
				tree: tree && (tree.nodes.length > 0 || tree.edges.length > 0) ? tree : undefined,
				pathStructure
			});
		}
	}

	// Wrap storage callbacks to also collect tree data
	const wrappedStorageCallbacks: ProgressiveStorageCallbacks = {
		storeNodes: async (nodes) => {
			// Collect tree nodes (non-external only)
			for (const node of nodes) {
				if (!node.is_external) {
					internalNodeIds.add(node.id);
					treeNodes.push({
						id: node.id,
						name: node.name,
						kind: node.kind,
						visibility: node.visibility,
						is_external: node.is_external,
						...(node.kind === 'Impl' ? {
							impl_trait: node.impl_trait,
							generics: node.generics,
							where_clause: node.where_clause,
							bound_links: node.bound_links
						} : {})
					});
				}
			}

			// Track and emit progress BEFORE awaiting DO write
			// (flushes run concurrently so we need to emit with accurate deltas)
			nodeCount += nodes.length;
			if (!firstDeltaSent && nodeCount > 0) {
				firstDeltaSent = true;
				lastProgressAt = nodeCount;
				emitProgress('delta', true, true, false); // First delta as soon as nodes arrive
			} else if (nodeCount - lastProgressAt >= progressInterval) {
				lastProgressAt = nodeCount;
				emitProgress('delta', true, true, false); // Include tree at intervals
			}
			if (nodeCount - lastSnapshotAt >= snapshotInterval && treeNodes.length > 0) {
				lastSnapshotAt = nodeCount;
				// Include full path structure in snapshots
				emitProgress('snapshot', true, true, true, true);
			}

			await storageCallbacks.storeNodes(nodes);
		},
		storeEdges: async (edges) => {
			// Collect candidate tree edges (Contains/Defines) - defer filtering
			// because edges may arrive before their nodes
			for (const edge of edges) {
				if (edge.kind === 'Contains' || edge.kind === 'Defines') {
					pendingTreeEdges.push(edge);

					// Track parent-child relationships for path structure metadata
					if (edge.kind === 'Contains') {
						if (!parentChildMap.has(edge.from)) {
							parentChildMap.set(edge.from, new Set());
						}
						parentChildMap.get(edge.from)!.add(edge.to);
					}
				}
			}
			await storageCallbacks.storeEdges(edges);
			edgeCount += edges.length;
			if (firstDeltaSent && edgeCount > 0) {
				if (!firstEdgeDeltaSent) {
					firstEdgeDeltaSent = true;
					lastEdgeProgressAt = edgeCount;
					// Include path structure on first edge delta
					emitProgress('delta', true, true, false, true);
				} else if (edgeCount - lastEdgeProgressAt >= progressInterval) {
					lastEdgeProgressAt = edgeCount;
					// Include path structure periodically
					emitProgress('delta', true, true, false, true);
				}
			}
		},
		updateNode: storageCallbacks.updateNode
	};

	// Create the streaming graph builder with progressive storage
	const builder = createStreamingGraphBuilder(normalizedName, {
		batchSize,
		skipExternalNodes,
		storageCallbacks: wrappedStorageCallbacks
	});

	const callbacks = builder.createParseCallbacks();

	// Emit initial progress only after we have data (first delta)

	// Parse the stream through the streaming parser
	const tParse = performance.now();
	await parseRustdocByteStream(input, callbacks);
	const parseElapsed = performance.now() - tParse;
	log.info`parse phase: ${parseElapsed.toFixed(0)}ms`;

	// Finalize (resolves deferred edges, stores remaining batches)
	const tFinalize = performance.now();
	const result = await builder.finalize();
	const finalizeElapsed = performance.now() - tFinalize;
	log.info`finalize phase: ${finalizeElapsed.toFixed(0)}ms`;

	const elapsed = performance.now() - t0;
	log.info`progressive parsed ${normalizedName}: ${String(result.nodeCount)} nodes, ${String(result.edgeCount)} edges in ${elapsed.toFixed(0)}ms`;

	// Final flush of any remaining pending tree edges
	flushPendingTreeEdges();

	// Server-side orphan filtering: only keep nodes reachable from Crate roots via Contains/Defines
	const tFilter = performance.now();
	const childMap = new Map<string, string[]>();
	for (const edge of treeEdges) {
		if (edge.kind === 'Contains' || edge.kind === 'Defines') {
			if (!childMap.has(edge.from)) childMap.set(edge.from, []);
			childMap.get(edge.from)!.push(edge.to);
		}
	}
	const reachable = new Set<string>();
	const crateIds = treeNodes.filter((n) => n.kind === 'Crate').map((n) => n.id);
	const queue = [...crateIds];
	for (const id of queue) {
		if (reachable.has(id)) continue;
		reachable.add(id);
		const children = childMap.get(id);
		if (children) queue.push(...children);
	}
	const filteredNodes = reachable.size < treeNodes.length
		? treeNodes.filter((n) => reachable.has(n.id))
		: treeNodes;
	const filteredEdges = reachable.size < treeNodes.length
		? treeEdges.filter((e) => reachable.has(e.from) && reachable.has(e.to))
		: treeEdges;
	const filterElapsed = performance.now() - tFilter;
	log.info`orphan filter: ${filteredNodes.length}/${treeNodes.length} nodes, ${filteredEdges.length}/${treeEdges.length} edges in ${filterElapsed.toFixed(0)}ms`;

	return {
		nodeCount: result.nodeCount,
		edgeCount: result.edgeCount,
		tree: { nodes: filteredNodes, edges: filteredEdges },
		externalCrates: result.externalCrates,
		crateVersion: result.crateVersion
	};
}
