import type { Graph, Node } from '$lib/graph';
import { kindOrder } from '$lib/tree';
import { getLogger } from '$lib/log';

const log = getLogger('tree-index');

/**
 * Builds and maintains a hierarchical tree index from a flat Graph (nodes + edges).
 *
 * Supports both full rebuilds (when the graph array reference changes or shrinks)
 * and incremental delta appends (when new nodes/edges are added to the same arrays).
 *
 * Pure TypeScript -- no Svelte reactivity.  Does NOT build TreeNode objects --
 * consumers (GraphTree / VirtualTree) materialise them on demand for visible rows.
 */
export class TreeIndex {
	// ── Public readable state ──────────────────────────────────────────
	/** Map from node id to Node. */
	readonly nodes: ReadonlyMap<string, Node>;
	/** Map from child id to parent id. */
	readonly parents: ReadonlyMap<string, string>;
	/** Monotonically increasing version counter. Bumped on every mutation. */
	version = 0;

	// ── Private internals ──────────────────────────────────────────────
	#nodes = new Map<string, Node>();
	#parents = new Map<string, string>();
	#children = new Map<string, string[]>();
	#rootIds = new Set<string>();
	/** Ordered root id list — maintained during streaming deltas. */
	#rootList: string[] = [];
	#nodeArrayRef: Graph['nodes'] | null = null;
	#edgeArrayRef: Graph['edges'] | null = null;
	#nodeLength = 0;
	#edgeLength = 0;

	constructor() {
		// Expose readonly views backed by the private maps
		this.nodes = this.#nodes;
		this.parents = this.#parents;
	}

	// ── Public accessors ──────────────────────────────────────────────

	/** Number of root nodes. */
	get rootCount(): number {
		return this.#rootIds.size;
	}

	/** Ordered root ids (sorted for query data, append-order for streaming). */
	getRootIds(): readonly string[] {
		return this.#rootList;
	}

	/** Get a node by id. */
	getNode(id: string): Node | undefined {
		return this.#nodes.get(id);
	}

	/** Whether a node has children. */
	hasChildren(id: string): boolean {
		return this.#children.has(id);
	}

	/** Get child ids for a node. */
	getChildIds(id: string): readonly string[] {
		return this.#children.get(id) ?? EMPTY_IDS;
	}

	// ── Public API ─────────────────────────────────────────────────────

	/**
	 * Ensure the index is current for `graph`.
	 * Auto-detects whether a full rebuild, incremental delta, or no-op is needed.
	 *
	 * @param streaming When true, new root nodes are appended unsorted (O(1))
	 *                  instead of binary-inserted in sorted order (O(log n)).
	 * @returns The action taken: `'rebuild'`, `'delta'`, or `'noop'`.
	 */
	ensure(graph: Graph, streaming = false): 'rebuild' | 'delta' | 'noop' {
		const t0 = performance.now();

		const requiresRebuild =
			this.#nodeArrayRef !== graph.nodes ||
			this.#edgeArrayRef !== graph.edges ||
			graph.nodes.length < this.#nodeLength ||
			graph.edges.length < this.#edgeLength;

		if (requiresRebuild) {
			// Before a full rebuild, check if the data is content-equivalent.
			// SWR's stale-while-revalidate pattern returns new object refs for
			// identical data — skip the rebuild to avoid a redundant O(n) pass.
			if (
				this.#nodeLength > 0 &&
				graph.nodes.length === this.#nodeLength &&
				graph.edges.length === this.#edgeLength
			) {
				const first = graph.nodes[0];
				const last = graph.nodes[graph.nodes.length - 1];
				const iFirst = first ? this.#nodes.get(first.id) : undefined;
				const iLast = last ? this.#nodes.get(last.id) : undefined;
				if (
					iFirst && iLast &&
					iFirst.kind === first.kind &&
					iLast.kind === last.kind
				) {
					this.#nodeArrayRef = graph.nodes;
					this.#edgeArrayRef = graph.edges;
					return 'noop';
				}
			}

			this.#rebuild(graph, streaming);
			this.#nodeArrayRef = graph.nodes;
			this.#edgeArrayRef = graph.edges;
			this.#nodeLength = graph.nodes.length;
			this.#edgeLength = graph.edges.length;
			this.version += 1;
			const ms = performance.now() - t0;
			if (ms > 5)
				log.warn`[cascade] ensureIndexed REBUILD ${Math.round(ms)}ms nodes=${graph.nodes.length} edges=${graph.edges.length} roots=${this.#rootIds.size}`;
			return 'rebuild';
		}

		if (
			graph.nodes.length === this.#nodeLength &&
			graph.edges.length === this.#edgeLength
		) {
			return 'noop';
		}

		const deltaNodes = graph.nodes.length - this.#nodeLength;
		const deltaEdges = graph.edges.length - this.#edgeLength;
		const changed = this.#appendIndex(graph, this.#nodeLength, this.#edgeLength, streaming);
		this.#nodeLength = graph.nodes.length;
		this.#edgeLength = graph.edges.length;
		if (changed) this.version += 1;
		const ms = performance.now() - t0;
		if (ms > 5)
			log.warn`[cascade] ensureIndexed DELTA ${Math.round(ms)}ms +${deltaNodes}n +${deltaEdges}e total=${graph.nodes.length}n roots=${this.#rootIds.size}`;
		return changed ? 'delta' : 'noop';
	}

	/** Reset all state. */
	reset(): void {
		this.#nodes.clear();
		this.#parents.clear();
		this.#children.clear();
		this.#rootIds.clear();
		this.#rootList = [];
		this.#nodeArrayRef = null;
		this.#edgeArrayRef = null;
		this.#nodeLength = 0;
		this.#edgeLength = 0;
		this.version += 1;
	}

	// ── Private: comparison helpers ────────────────────────────────────

	#compareNodeIds(a: string, b: string): number {
		const an = this.#nodes.get(a);
		const bn = this.#nodes.get(b);
		if (!an && !bn) return a < b ? -1 : a > b ? 1 : 0;
		if (!an) return 1;
		if (!bn) return -1;
		const kindDiff = (kindOrder[an.kind] ?? 99) - (kindOrder[bn.kind] ?? 99);
		if (kindDiff !== 0) return kindDiff;
		return an.name < bn.name ? -1 : an.name > bn.name ? 1 : 0;
	}

	// ── Private: sorted insertion ──────────────────────────────────────

	#insertSortedUnique(list: string[], id: string): void {
		let lo = 0;
		let hi = list.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			const cmp = this.#compareNodeIds(id, list[mid]);
			if (cmp === 0 && list[mid] === id) return;
			if (cmp > 0) lo = mid + 1;
			else hi = mid;
		}
		if (list[lo] === id) return;
		list.splice(lo, 0, id);
	}

	// ── Private: incremental mutation ──────────────────────────────────

	#addNode(node: Node, streaming: boolean): boolean {
		const existed = this.#nodes.has(node.id);
		this.#nodes.set(node.id, node);
		if (!existed) {
			if (!this.#parents.has(node.id)) {
				this.#rootIds.add(node.id);
				if (streaming) {
					this.#rootList.push(node.id);
				} else {
					this.#insertSortedUnique(this.#rootList, node.id);
				}
			}
			return true;
		}
		return false;
	}

	#addEdge(from: string, to: string): boolean {
		if (this.#parents.has(to)) return false;
		this.#parents.set(to, from);
		const children = this.#children.get(from);
		if (children) {
			this.#insertSortedUnique(children, to);
		} else {
			this.#children.set(from, [to]);
		}
		if (this.#rootIds.has(to)) {
			this.#rootIds.delete(to);
			// Remove from rootList — O(n) but rootList is typically small (1-5 items)
			const idx = this.#rootList.indexOf(to);
			if (idx !== -1) this.#rootList.splice(idx, 1);
		}
		return true;
	}

	#appendIndex(
		graph: Graph,
		nodeStart: number,
		edgeStart: number,
		streaming: boolean,
	): boolean {
		let changed = false;

		for (let i = nodeStart; i < graph.nodes.length; i++) {
			if (this.#addNode(graph.nodes[i], streaming)) changed = true;
		}

		for (let i = edgeStart; i < graph.edges.length; i++) {
			const edge = graph.edges[i];
			if (edge.kind !== 'Contains' && edge.kind !== 'Defines') continue;
			if (this.#addEdge(edge.from, edge.to)) changed = true;
		}

		return changed;
	}

	// ── Private: full rebuild ──────────────────────────────────────────

	#rebuild(graph: Graph, streaming: boolean): void {
		const passes: string[] = [];
		let t = performance.now();
		const mark = (label: string) => {
			const ms = performance.now() - t;
			passes.push(`${label}=${Math.round(ms)}ms`);
			t = performance.now();
		};

		this.reset();
		mark('reset');

		// Pass 1: register nodes.
		for (const node of graph.nodes) {
			this.#nodes.set(node.id, node);
		}
		mark('nodes');

		// Pass 2: register parent links from structural edges.
		// Children arrays are created lazily (only for parents that have children).
		for (const edge of graph.edges) {
			if (edge.kind !== 'Contains' && edge.kind !== 'Defines') continue;
			if (this.#parents.has(edge.to)) continue;
			if (!this.#nodes.has(edge.from) || !this.#nodes.has(edge.to)) continue;
			this.#parents.set(edge.to, edge.from);
			const children = this.#children.get(edge.from);
			if (children) {
				children.push(edge.to);
			} else {
				this.#children.set(edge.from, [edge.to]);
			}
		}
		mark('edges');

		// Pass 3: sort child lists (streaming only).
		// For streaming, sort is required to maintain the sorted invariant for
		// incremental binary-insertion in #addEdge. For query data, sorting is
		// deferred to lazy on-demand sort in VirtualTree (saves ~166ms).
		if (streaming) {
			for (const children of this.#children.values()) {
				if (children.length <= 1) continue;
				const decorated: [string, number, string][] = new Array(children.length);
				for (let i = 0; i < children.length; i++) {
					const n = this.#nodes.get(children[i])!;
					decorated[i] = [children[i], kindOrder[n.kind] ?? 99, n.name];
				}
				decorated.sort((a, b) => {
					const kd = a[1] - b[1];
					if (kd !== 0) return kd;
					return a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0;
				});
				for (let i = 0; i < children.length; i++) children[i] = decorated[i][0];
			}
		}
		mark('sort');

		// Pass 4: identify roots (no TreeNode creation — that's lazy now).
		for (const nodeId of this.#nodes.keys()) {
			if (!this.#parents.has(nodeId)) this.#rootIds.add(nodeId);
		}
		// Build sorted root list
		this.#rootList = Array.from(this.#rootIds);
		if (!streaming && this.#rootList.length > 1) {
			this.#rootList.sort((a, b) => this.#compareNodeIds(a, b));
		}
		mark('roots');

		log.debug`[rebuild] ${graph.nodes.length}n ${graph.edges.length}e ${passes.join(' ')}`;
	}
}

const EMPTY_IDS: readonly string[] = Object.freeze([]);
