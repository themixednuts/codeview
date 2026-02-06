import type { NodeKind } from '$lib/graph';
import type { CrateTree } from '$lib/schema';
import type { PathStructureMetadata } from '$lib/path-structure';
import { getLogger } from '$lib/log';
import { connect } from '$realtime';
import { SvelteMap } from 'svelte/reactivity';

export interface ProgressEvent {
	type: 'meta' | 'snapshot' | 'delta' | 'complete';
	sequence?: number;
	contentId?: string;
	tree?: CrateTree;
	nodeCount?: number;
	edgeCount?: number;
	/** Total expected items from metadata (sent in 'meta' event before data streams) */
	totalItems?: number;
	/** Path structure metadata for accurate skeleton rendering */
	pathStructure?: PathStructureMetadata;
}

/**
 * Reactive connection for streaming parse progress via shared event stream.
 * Uses multiplexed SSE to avoid connection limits.
 *
 * All public properties use $state and are automatically reactive.
 * Components can read them directly without subscribing.
 */
export class ParseProgressConnection implements Disposable {
	tree = $state<CrateTree | null>(null);
	nodeCount = $state(0);
	edgeCount = $state(0);
	sequence = $state<number | null>(null);
	kindCounts = new SvelteMap<NodeKind, number>();
	/** Total expected items from metadata (available before data streams) */
	totalItems = $state<number | null>(null);
	/** Path structure metadata for accurate skeleton rendering */
	pathStructure = $state<PathStructureMetadata | null>(null);
	complete: boolean = $state(false);
	/** True when delta sequence gaps were detected. */
	stale: boolean = $state(false);
	contentId: string | null = $state(null);

	#client = connect();
	#log = getLogger('progress');
	#name = '';
	#version = '';
	#lastSequence = -1;
	#currentTag: string | null = null;
	#unsubscribe: (() => void) | null = null;

	get tag() {
		return `${this.#name}@${this.#version}`;
	}

	/**
	 * Connect to a crate's progress stream.
	 */
	async connect(name: string, version: string) {
		// Unsubscribe from previous
		this.disconnect();

		this.#name = name;
		this.#version = version;
		const tag = `progress:rust:${name}:${version}`;
		this.#currentTag = tag;

		this.#log.debug`connect ${this.tag}`;

		// Reset state
		this.tree = null;
		this.nodeCount = 0;
		this.edgeCount = 0;
		this.sequence = null;
		this.kindCounts.clear();
		this.totalItems = null;
		this.pathStructure = null;
		this.complete = false;
		this.stale = false;
		this.contentId = null;
		this.#lastSequence = -1;

		// Subscribe via shared connection
		const callback = (data: unknown) => this.onProgressData(data as ProgressEvent);
		await this.#client.subscribe(tag, callback);
		this.#unsubscribe = () => this.#client.unsubscribe(tag, callback);
	}

	/**
	 * Disconnect from current progress stream.
	 */
	disconnect() {
		if (this.#unsubscribe) {
			this.#unsubscribe();
			this.#unsubscribe = null;
		}
		this.#currentTag = null;
	}

	destroy() {
		this.disconnect();
		this.reset();
	}

	[Symbol.dispose]() {
		this.destroy();
	}

	/**
	 * Reset state without disconnecting.
	 */
	reset() {
		this.disconnect();
		this.tree = null;
		this.nodeCount = 0;
		this.edgeCount = 0;
		this.sequence = null;
		this.kindCounts.clear();
		this.totalItems = null;
		this.pathStructure = null;
		this.complete = false;
		this.stale = false;
		this.contentId = null;
		this.#lastSequence = -1;
	}

	private onProgressData(msg: ProgressEvent) {
		this.#log.debug`msg ${this.tag} type=${msg.type} nodes=${msg.nodeCount ?? 0} total=${msg.totalItems ?? '-'}`;
		const prevContentId = this.contentId;

		if (msg.contentId) {
			if (this.contentId && msg.contentId !== this.contentId) {
				// Content changed - reset accumulated state to avoid corrupting tree
				this.#log.debug`contentId changed ${this.tag}: ${this.contentId} -> ${msg.contentId}, resetting state`;
				this.tree = null;
				this.nodeCount = 0;
				this.edgeCount = 0;
				this.kindCounts.clear();
				this.#lastSequence = -1;
				this.stale = false; // Fresh start, not stale
			}
			this.contentId = msg.contentId;
		}

		const incomingNodeCount = msg.nodeCount ?? msg.tree?.nodes.length;
		const incomingEdgeCount = msg.edgeCount ?? msg.tree?.edges.length;
		const sameContent = !msg.contentId || !prevContentId || msg.contentId === prevContentId;

		if (msg.type === 'delta'
			&& sameContent
			&& incomingNodeCount !== undefined
			&& incomingNodeCount < this.nodeCount) {
			this.#log.debug`regression ${this.tag} ${String(incomingNodeCount)} < ${String(this.nodeCount)}`;
			return;
		}

		if (msg.type === 'snapshot'
			&& sameContent
			&& incomingNodeCount !== undefined
			&& incomingNodeCount < this.nodeCount) {
			this.#log.debug`snapshot regression ${this.tag} ${String(incomingNodeCount)} < ${String(this.nodeCount)}`;
			return;
		}

		if (msg.type === 'delta' && typeof msg.sequence === 'number') {
			if (this.#lastSequence >= 0) {
				if (msg.sequence <= this.#lastSequence) return;
				if (msg.sequence !== this.#lastSequence + 1) {
					this.stale = true;
					this.#lastSequence = -1;
					// Don't apply out-of-order deltas - wait for a snapshot
					this.#log.debug`sequence gap ${this.tag}: expected ${this.#lastSequence + 1}, got ${msg.sequence}, waiting for snapshot`;
					return;
				}
			}
			this.#lastSequence = msg.sequence;
			this.sequence = msg.sequence;
		}

		// When stale, only accept snapshots or complete events to resync
		if (this.stale && msg.type === 'delta') {
			this.#log.debug`stale ${this.tag}: ignoring delta, waiting for snapshot`;
			return;
		}

		// Handle metadata event
		if (msg.type === 'meta' && typeof msg.totalItems === 'number') {
			this.totalItems = msg.totalItems;
		}

		// Handle path structure metadata
		if (msg.pathStructure) {
			this.pathStructure = msg.pathStructure;
		}

		if (msg.type === 'delta' && msg.tree) {
			const emptyTreeDelta = msg.tree.nodes.length === 0 && msg.tree.edges.length === 0;
			const sameNodeCount = typeof incomingNodeCount !== 'number' || incomingNodeCount === this.nodeCount;
			const sameEdgeCount = typeof incomingEdgeCount !== 'number' || incomingEdgeCount === this.edgeCount;
			if (emptyTreeDelta && sameNodeCount && sameEdgeCount) return;
		}

		// Handle updates
		if (msg.type === 'snapshot' && msg.tree) {
			this.tree = msg.tree;
			this.recomputeKindCounts(msg.tree);
			this.stale = false;
			this.#log.debug`snapshot ${this.tag} ${String(msg.tree.nodes.length)} nodes`;
			if (typeof msg.sequence === 'number') {
				this.#lastSequence = msg.sequence;
				this.sequence = msg.sequence;
			}
		} else if (msg.type === 'delta' && msg.tree) {
			if (!this.tree) {
				this.tree = { nodes: [], edges: [] };
			}
			// Accumulate delta
			for (const node of msg.tree.nodes) this.tree.nodes.push(node);
			for (const edge of msg.tree.edges) this.tree.edges.push(edge);
			this.tree = this.tree; // Force reactivity

			this.incrementKindCounts(msg.tree.nodes);
			this.stale = false;
			this.#log.debug`delta ${this.tag} +${String(msg.tree.nodes.length)} nodes`;
		} else if (msg.type === 'complete' && msg.tree) {
			this.tree = msg.tree;
			this.recomputeKindCounts(msg.tree);
			this.stale = false;
			this.#log.debug`complete ${this.tag} ${String(msg.tree.nodes.length)} nodes`;
			if (typeof msg.sequence === 'number') {
				this.#lastSequence = msg.sequence;
				this.sequence = msg.sequence;
			}
		}

		if (typeof msg.nodeCount === 'number') {
			this.nodeCount = msg.nodeCount;
		} else if ((msg.type === 'snapshot' || msg.type === 'complete') && msg.tree) {
			this.nodeCount = msg.tree.nodes.length;
		}

		if (typeof msg.edgeCount === 'number') {
			this.edgeCount = msg.edgeCount;
		} else if ((msg.type === 'snapshot' || msg.type === 'complete') && msg.tree) {
			this.edgeCount = msg.tree.edges.length;
		}

		if (msg.type === 'complete') {
			this.complete = true;
			this.#log.debug`complete ${this.tag}`;
			this.disconnect();
		}
	}

	private incrementKindCounts(nodes: CrateTree['nodes']) {
		if (nodes.length === 0) return;
		for (const node of nodes) {
			this.kindCounts.set(node.kind, (this.kindCounts.get(node.kind) ?? 0) + 1);
		}
	}

	private recomputeKindCounts(tree: CrateTree) {
		this.kindCounts.clear();
		for (const node of tree.nodes) {
			this.kindCounts.set(node.kind, (this.kindCounts.get(node.kind) ?? 0) + 1);
		}
	}

	getKindCount(kind: NodeKind): number {
		return this.kindCounts.get(kind) ?? 0;
	}
}
