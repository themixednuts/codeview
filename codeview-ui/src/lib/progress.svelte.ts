import type { NodeKind } from '$lib/graph';
import type { CrateTree } from '$lib/schema';
import type { PathStructureMetadata } from '$lib/path-structure';
import { getLogger } from '$lib/log';
import { StreamConnection } from '$lib/stream.svelte';
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
 * Reactive SSE connection for streaming parse progress (tree updates).
 * Provides real-time tree data as parsing progresses.
 */
export class ParseProgressConnection extends StreamConnection {
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
	#lastSequence = -1;

	protected readonly log = getLogger('progress');
	#name = '';
	#version = '';

	protected get tag() {
		return `${this.#name}@${this.#version}`;
	}

	protected get endpoint() {
		const key = `progress:rust:${this.#name}:${this.#version}`;
		const params = new URLSearchParams({ key });
		if (this.#lastSequence >= 0) params.set('since', String(this.#lastSequence));
		if (this.contentId) params.set('contentId', this.contentId);
		return `/api/parse-progress/sse?${params.toString()}`;
	}

	/** Connect to a crate's progress stream. Closes any previous connection. */
	connect(name: string, version: string) {
		this.close();
		this.activate();
		this.#name = name;
		this.#version = version;
		this.beginStream(`progress:rust:${name}:${version}`);
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
		this.open();
	}

	protected onData(data: unknown) {
		const msg = data as ProgressEvent;
		this.log.debug`msg ${this.tag} type=${msg.type} nodes=${msg.nodeCount ?? 0} total=${msg.totalItems ?? '-'}`;
		const prevContentId = this.contentId;

		if (msg.contentId) {
			if (this.contentId && msg.contentId !== this.contentId) {
				this.stale = true;
				this.markStale(true);
				this.#lastSequence = -1;
				queueMicrotask(() => this.open());
			}
			this.contentId = msg.contentId;
			this.markContentId(msg.contentId);
		}

		const incomingNodeCount = msg.nodeCount ?? msg.tree?.nodes.length;
		const incomingEdgeCount = msg.edgeCount ?? msg.tree?.edges.length;
		const sameContent = !msg.contentId || !prevContentId || msg.contentId === prevContentId;
		if (msg.type === 'delta'
			&& sameContent
			&& incomingNodeCount !== undefined
			&& incomingNodeCount < this.nodeCount) {
			this.log.debug`regression ${this.tag} ${String(incomingNodeCount)} < ${String(this.nodeCount)}`;
			return;
		}
		if (msg.type === 'snapshot'
			&& sameContent
			&& incomingNodeCount !== undefined
			&& incomingNodeCount < this.nodeCount) {
			this.log.debug`snapshot regression ${this.tag} ${String(incomingNodeCount)} < ${String(this.nodeCount)}`;
			return;
		}

		if (msg.type === 'delta' && typeof msg.sequence === 'number') {
			if (this.#lastSequence >= 0) {
				if (msg.sequence <= this.#lastSequence) return;
				if (msg.sequence !== this.#lastSequence + 1) {
					this.stale = true;
					this.markStale(true);
					this.#lastSequence = -1;
					queueMicrotask(() => this.open());
				}
			}
			this.#lastSequence = msg.sequence;
			this.sequence = msg.sequence;
			this.markSequence(msg.sequence);
		}

		// Handle metadata event (sent before data streams)
		if (msg.type === 'meta' && typeof msg.totalItems === 'number') {
			this.totalItems = msg.totalItems;
		}

		// Handle path structure metadata for accurate skeleton rendering
		if (msg.pathStructure) {
			this.pathStructure = msg.pathStructure;
		}

		if (msg.type === 'delta' && msg.tree) {
			const emptyTreeDelta = msg.tree.nodes.length === 0 && msg.tree.edges.length === 0;
			const sameNodeCount = typeof incomingNodeCount !== 'number' || incomingNodeCount === this.nodeCount;
			const sameEdgeCount = typeof incomingEdgeCount !== 'number' || incomingEdgeCount === this.edgeCount;
			if (emptyTreeDelta && sameNodeCount && sameEdgeCount) return;
		}

		// Handle snapshot updates - replace tree
		if (msg.type === 'snapshot' && msg.tree) {
			this.touchStream();
			this.tree = msg.tree;
			this.recomputeKindCounts(msg.tree);
			this.stale = false;
			this.log.debug`snapshot ${this.tag} ${String(msg.tree.nodes.length)} nodes`;
			if (typeof msg.sequence === 'number') {
				this.#lastSequence = msg.sequence;
				this.sequence = msg.sequence;
				this.markSequence(msg.sequence);
			}
		} else if (msg.type === 'delta' && msg.tree) {
			this.touchStream();
			// Handle delta updates - accumulate into tree
			if (!this.tree) {
				// First delta - initialize tree
				this.tree = { nodes: [], edges: [] };
				for (const node of msg.tree.nodes) this.tree.nodes.push(node);
				for (const edge of msg.tree.edges) this.tree.edges.push(edge);
			} else {
				// Accumulate delta into existing tree - mutate in place to avoid O(n) copying
				for (const node of msg.tree.nodes) this.tree.nodes.push(node);
				for (const edge of msg.tree.edges) this.tree.edges.push(edge);
				// Force reactivity by reassigning
				this.tree = this.tree;
			}
			this.incrementKindCounts(msg.tree.nodes);
			// If we were marked stale due to a reconnect gap, keep rendering and
			// continue accumulating deltas until a fresh snapshot/complete arrives.
			this.stale = false;
			this.markStale(false);
			this.log.debug`delta ${this.tag} +${String(msg.tree.nodes.length)} nodes`;
		} else if (msg.type === 'complete' && msg.tree) {
			this.touchStream();
			// Complete event has full tree - replace accumulated
			this.tree = msg.tree;
			this.recomputeKindCounts(msg.tree);
			this.stale = false;
			this.log.debug`complete ${this.tag} ${String(msg.tree.nodes.length)} nodes`;
			if (typeof msg.sequence === 'number') {
				this.#lastSequence = msg.sequence;
				this.sequence = msg.sequence;
				this.markSequence(msg.sequence);
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
			this.log.debug`complete ${this.tag}`;
			this.close();
		}
	}

	protected override onStreamReady() {
		this.log.debug`ready ${this.tag} since=${String(this.#lastSequence)} contentId=${this.contentId ?? '-'}`;
	}

	protected override onStreamEnd(reason: 'eof' | 'aborted' | 'fetch-error' | 'bad-response' | 'read-error', detail?: string) {
		this.log.debug`end ${this.tag} reason=${reason}${detail ? ` detail=${detail}` : ''} seq=${String(this.sequence)} nodes=${String(this.nodeCount)}`;
	}

	/** Reset state without destroying the connection. */
	reset() {
		this.close();
		this.tree = null;
		this.nodeCount = 0;
		this.edgeCount = 0;
		this.sequence = null;
		this.kindCounts.clear();
		this.markSequence(null);
		this.markContentId(null);
		this.markStale(false);
		this.totalItems = null;
		this.pathStructure = null;
		this.complete = false;
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
