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

	const normalizedName = normalizeCrateName(crateName);
	const t0 = performance.now();

	// Track tree data during streaming
	const treeNodes: CrateTree['nodes'] = [];
	const treeEdges: CrateTree['edges'] = [];
	const internalNodeIds = new Set<string>();
	// Candidate tree edges awaiting filtering (edges may arrive before nodes)
	// Indexed by missing endpoint for O(1) lookup when nodes arrive
	const pendingEdgesByFrom = new Map<string, CrateTree['edges']>();
	const pendingEdgesByTo = new Map<string, CrateTree['edges']>();

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
	// Time-based emission for responsive UI
	let lastEmitMs = performance.now();
	const emitTimeoutMs = 250; // Emit at least every 250ms for responsive UI
	// Max delta size to prevent huge payloads
	const maxDeltaNodes = 2000;
	const maxDeltaEdges = 4000;
	// Unsent buffers - avoid slice() allocations
	let unsentNodes: CrateTree['nodes'] = [];
	let unsentEdges: CrateTree['edges'] = [];

	/**
	 * Add an edge to pending, indexed by missing endpoint(s).
	 */
	function addPendingEdge(edge: CrateTree['edges'][number]): void {
		const hasFrom = internalNodeIds.has(edge.from);
		const hasTo = internalNodeIds.has(edge.to);
		
		if (hasFrom && hasTo) {
			// Both endpoints exist, add directly to tree
			treeEdges.push(edge);
			unsentEdges.push(edge);
		} else {
			// Index by missing endpoint(s)
			if (!hasFrom) {
				if (!pendingEdgesByFrom.has(edge.from)) {
					pendingEdgesByFrom.set(edge.from, []);
				}
				pendingEdgesByFrom.get(edge.from)!.push(edge);
			}
			if (!hasTo) {
				if (!pendingEdgesByTo.has(edge.to)) {
					pendingEdgesByTo.set(edge.to, []);
				}
				pendingEdgesByTo.get(edge.to)!.push(edge);
			}
		}
	}

	/**
	 * Called when a new node is added. Resolves any pending edges waiting on this node.
	 */
	function resolveEdgesForNode(nodeId: string): void {
		// Check edges waiting for this node as 'from'
		const waitingFrom = pendingEdgesByFrom.get(nodeId);
		if (waitingFrom) {
			pendingEdgesByFrom.delete(nodeId);
			for (const edge of waitingFrom) {
				// Check if 'to' is now available
				if (internalNodeIds.has(edge.to)) {
					treeEdges.push(edge);
					unsentEdges.push(edge);
					// Remove from 'to' index if it was there
					const toList = pendingEdgesByTo.get(edge.to);
					if (toList) {
						const idx = toList.indexOf(edge);
						if (idx >= 0) toList.splice(idx, 1);
						if (toList.length === 0) pendingEdgesByTo.delete(edge.to);
					}
				}
			}
		}
		
		// Check edges waiting for this node as 'to'
		const waitingTo = pendingEdgesByTo.get(nodeId);
		if (waitingTo) {
			pendingEdgesByTo.delete(nodeId);
			for (const edge of waitingTo) {
				// Check if 'from' is now available
				if (internalNodeIds.has(edge.from)) {
					treeEdges.push(edge);
					unsentEdges.push(edge);
					// Remove from 'from' index if it was there
					const fromList = pendingEdgesByFrom.get(edge.from);
					if (fromList) {
						const idx = fromList.indexOf(edge);
						if (idx >= 0) fromList.splice(idx, 1);
						if (fromList.length === 0) pendingEdgesByFrom.delete(edge.from);
					}
				}
			}
		}
	}

	function emitProgress(
		type: 'delta' | 'snapshot',
		includeTree = false,
		fullTree = false,
		includePathStructure = false
	) {
		if (!onProgress) return;

		// Build tree payload
		let tree: CrateTree | undefined;
		if (includeTree) {
			if (fullTree) {
				// Snapshot: send full tree
				tree = { nodes: treeNodes, edges: treeEdges };
			} else {
				// Delta: send unsent buffers and reset them
				tree = { nodes: unsentNodes, edges: unsentEdges };
				unsentNodes = [];
				unsentEdges = [];
			}
		}

		// Only include pathStructure on snapshots to reduce payload size
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
		
		lastEmitMs = performance.now();
		
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

	/**
	 * Check if we should emit based on time or buffer size.
	 */
	function shouldEmitDelta(): boolean {
		const now = performance.now();
		const timeSinceEmit = now - lastEmitMs;
		const bufferFull = unsentNodes.length >= maxDeltaNodes || unsentEdges.length >= maxDeltaEdges;
		return bufferFull || timeSinceEmit >= emitTimeoutMs;
	}

	// Wrap storage callbacks to also collect tree data
	const wrappedStorageCallbacks: ProgressiveStorageCallbacks = {
		storeNodes: async (nodes) => {
			// Collect tree nodes (non-external only) into both full list and unsent buffer
			for (const node of nodes) {
				if (!node.is_external) {
					internalNodeIds.add(node.id);
					const treeNode = {
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
					};
					treeNodes.push(treeNode);
					unsentNodes.push(treeNode);
					// Resolve any pending edges waiting for this node
					resolveEdgesForNode(node.id);
				}
			}

			// Track and emit progress BEFORE awaiting DO write
			nodeCount += nodes.length;
			
			// Emit logic: first delta immediately, then time/size based
			if (!firstDeltaSent && nodeCount > 0) {
				firstDeltaSent = true;
				lastProgressAt = nodeCount;
				emitProgress('delta', true, false);
			} else if (shouldEmitDelta()) {
				lastProgressAt = nodeCount;
				emitProgress('delta', true, false);
			}
			
			// Periodic snapshots with full tree + path structure
			if (nodeCount - lastSnapshotAt >= snapshotInterval && treeNodes.length > 0) {
				lastSnapshotAt = nodeCount;
				emitProgress('snapshot', true, true, true);
			}

			await storageCallbacks.storeNodes(nodes);
		},
		storeEdges: async (edges) => {
			// Track and emit progress BEFORE awaiting DO write (match node behavior)
			edgeCount += edges.length;
			
			// Collect candidate tree edges (Contains/Defines)
			// Uses indexed pending edge tracking for O(1) resolution
			for (const edge of edges) {
				if (edge.kind === 'Contains' || edge.kind === 'Defines') {
					addPendingEdge(edge);

					// Track parent-child relationships for path structure metadata
					if (edge.kind === 'Contains') {
						if (!parentChildMap.has(edge.from)) {
							parentChildMap.set(edge.from, new Set());
						}
						parentChildMap.get(edge.from)!.add(edge.to);
					}
				}
			}
			
			// Emit if buffer full or time elapsed
			if (firstDeltaSent && shouldEmitDelta()) {
				lastEdgeProgressAt = edgeCount;
				// Include path structure on edge deltas since that's when we learn tree structure
				emitProgress('delta', true, false, true);
			}
			
			await storageCallbacks.storeEdges(edges);
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

	// Log any remaining unresolved pending edges (expected for edges to external/filtered nodes)
	const remainingPending = pendingEdgesByFrom.size + pendingEdgesByTo.size;
	if (remainingPending > 0) {
		log.debug`${remainingPending} pending edge references remain unresolved`;
	}

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
