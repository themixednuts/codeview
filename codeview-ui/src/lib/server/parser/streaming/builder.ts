/**
 * Streaming graph builder for rustdoc JSON.
 *
 * Builds a crate graph incrementally as items are streamed from the parser.
 * Uses a single-pass approach with deferred edge resolution to minimize memory usage.
 *
 * Architecture:
 * - Phase 1 (streaming): Process items as they arrive, create nodes, collect edge references
 * - Phase 2 (post-stream): Build lookup indices from collected data
 * - Phase 3 (resolve): Resolve deferred edges using indices
 */

import type {
	Node,
	Edge,
	NodeKind,
	ImplType,
	Visibility,
	EdgeKind,
	Confidence,
	Span,
	FieldInfo,
	VariantInfo,
	FunctionSignature as FunctionSignatureOut,
	Graph
} from '$lib/graph';
import type {
	Id,
	Item,
	ItemSummary,
	ExternalCrate,
	ItemEnum,
	Type,
	GenericArgs,
	GenericBound,
	Generics,
	FunctionSignature as RdtFunctionSignature,
	FunctionHeader,
	Impl,
	StructKind,
	VariantKind,
	Attribute,
	Visibility as RdtVisibility
} from '../rustdoc.types';
import type { StreamingParseCallbacks } from './parser';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default batch size for node/edge callbacks */
export const DEFAULT_BATCH_SIZE = 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Checkpoint state for workflow resumption */
export interface BuilderCheckpoint {
	nodeCount: number;
	pendingEdgeCount: number;
	lastItemId: string | null;
	phase: 'streaming' | 'resolving' | 'complete';
}

/** Batch callback for progressive output */
export interface BatchCallbacks {
	onNodeBatch?: (nodes: Node[], batchIndex: number) => void | Promise<void>;
	onEdgeBatch?: (edges: Edge[], batchIndex: number) => void | Promise<void>;
	onCheckpoint?: (checkpoint: BuilderCheckpoint) => void | Promise<void>;
}

/** Deferred edge reference (to be resolved after streaming) */
interface DeferredEdge {
	fromId: string;
	toTypeId: Id;
	kind: EdgeKind;
	confidence: Confidence;
}

/** Deferred impl edge (needs type resolution) */
interface DeferredImplEdge {
	implNodeId: string;
	forTypeId: Id | null;
	traitId: Id | null;
	items: Id[];
}

/** External crate info collected during streaming */
interface ExternalCrateInfo {
	id: string;
	name: string;
}

// ---------------------------------------------------------------------------
// Streaming Graph Builder
// ---------------------------------------------------------------------------

export class StreamingGraphBuilder {
	// Configuration
	private readonly crateName: string;
	private readonly batchSize: number;
	private readonly skipExternalNodes: boolean;
	private readonly batchCallbacks: BatchCallbacks;

	// Collected data during streaming
	private nodes: Node[] = [];
	private edges: Edge[] = [];
	private nodeCache = new Set<string>();
	private edgeCache = new Set<string>();

	// Deferred resolution data
	private deferredUsesEdges: DeferredEdge[] = [];
	private deferredImplEdges: DeferredImplEdge[] = [];

	// Path index (built from $.paths.*)
	private pathIndex = new Map<Id, { path: string[]; crateId: number; kind: string }>();

	// Method IDs (items inside impl/trait blocks)
	private methodIds = new Set<Id>();

	// External crates
	private externalCrates: ExternalCrateInfo[] = [];
	private externalCrateNames = new Map<number, string>(); // crateId -> name

	// Metadata
	private root: Id | null = null;
	private crateVersion: string | null = null;

	// Batch tracking
	private nodeBatchIndex = 0;
	private edgeBatchIndex = 0;
	private pendingNodes: Node[] = [];
	private pendingEdges: Edge[] = [];
	private lastItemId: string | null = null;

	constructor(
		crateName: string,
		options: {
			batchSize?: number;
			skipExternalNodes?: boolean;
			batchCallbacks?: BatchCallbacks;
		} = {}
	) {
		this.crateName = crateName.replace(/-/g, '_');
		this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
		this.skipExternalNodes = options.skipExternalNodes ?? true;
		this.batchCallbacks = options.batchCallbacks ?? {};

		// Ensure crate root node exists
		this.ensureCrateNode(this.crateName, 'Public', false);
	}

	/**
	 * Creates parse callbacks for the streaming parser.
	 */
	createParseCallbacks(): StreamingParseCallbacks {
		return {
			onRoot: (root) => {
				this.root = root;
			},
			onCrateVersion: (version) => {
				this.crateVersion = version;
			},
			onItem: (id, item) => {
				this.processItem(id, item);
			},
			onPath: (id, summary) => {
				this.processPath(id, summary);
			},
			onExternalCrate: (id, crate) => {
				this.processExternalCrate(id, crate);
			},
			onComplete: () => {
				// Flush any remaining pending nodes
				this.flushPendingNodes();
			},
			onError: (error) => {
				console.error('Streaming parse error:', error);
			}
		};
	}

	/**
	 * Process a single item from $.index.*
	 */
	private processItem(idStr: string, item: Item): void {
		this.lastItemId = idStr;
		const itemId = Number(idStr);

		try {
			// Collect method IDs from impl and trait blocks
			if ('impl' in item.inner) {
				for (const id of item.inner.impl.items) {
					this.methodIds.add(id);
				}
				// Process impl block
				this.processImplItem(itemId, item);
			} else if ('trait' in item.inner) {
				for (const id of item.inner.trait.items) {
					this.methodIds.add(id);
				}
			}

			// Collect type references for UsesType edges (deferred)
			this.collectDeferredTypeEdges(idStr, item);
		} catch (err) {
			// Log but don't fail - continue processing
			console.warn(`Skipped item ${idStr}:`, err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * Process a path summary from $.paths.*
	 */
	private processPath(idStr: string, summary: ItemSummary): void {
		const itemId = Number(idStr);

		// Store in path index for later resolution
		this.pathIndex.set(itemId, {
			path: summary.path,
			crateId: summary.crate_id,
			kind: summary.kind
		});

		// Skip internal/generated paths
		if (summary.path.length === 0) return;
		if (summary.path.some((seg) => seg === '_' || seg.startsWith('__'))) return;

		const isMethod = this.methodIds.has(itemId);
		const nodeKind = this.mapItemKind(summary.kind, isMethod);
		if (!nodeKind) return;

		const itemCrateName = this.crateNameForId(summary.crate_id);
		const isExternal = itemCrateName !== this.crateName;

		if (isExternal && this.skipExternalNodes) return;

		// Ensure crate and module nodes exist
		this.ensureCrateNode(itemCrateName, 'Public', isExternal);
		this.ensureModuleNodes(itemCrateName, summary.path, isExternal);

		// Create node
		const nodeId = this.joinPath(itemCrateName, summary.path);
		if (!this.nodeCache.has(nodeId)) {
			const name = summary.path[summary.path.length - 1] ?? nodeId;

			const node: Node = {
				id: nodeId,
				name,
				kind: nodeKind,
				visibility: 'Unknown', // Will be updated when we see the item
				attrs: [],
				is_external: isExternal || undefined
			};

			this.addNode(node);
		}

		// Add Contains edge from parent
		const parentId = this.parentPathId(itemCrateName, summary.path);
		if (parentId && parentId !== nodeId) {
			this.addEdge(parentId, nodeId, 'Contains', 'Static');
		}
	}

	/**
	 * Process an external crate from $.external_crates.*
	 */
	private processExternalCrate(idStr: string, crate: ExternalCrate): void {
		const crateId = Number(idStr);
		const normalizedName = crate.name.replace(/-/g, '_');

		this.externalCrateNames.set(crateId, normalizedName);
		this.externalCrates.push({
			id: normalizedName,
			name: crate.name
		});
	}

	/**
	 * Process an impl block item.
	 */
	private processImplItem(itemId: Id, item: Item): void {
		const implBlock = item.inner as { impl: Impl };
		const impl = implBlock.impl;

		const itemCrateName = this.crateNameForId(item.crate_id);
		const isExternal = itemCrateName !== this.crateName;

		if (isExternal && this.skipExternalNodes) return;

		this.ensureCrateNode(itemCrateName, 'Public', isExternal);

		const implNodeId = `${itemCrateName}::impl-${itemId}`;
		const implTraitId = impl.trait ? impl.trait.id : null;
		const forTypeId = this.typeToId(impl.for);

		if (!this.nodeCache.has(implNodeId)) {
			const name = this.implNodeName(impl);
			const implType: ImplType | null = impl.trait ? 'Trait' : 'Inherent';

			const node: Node = {
				id: implNodeId,
				name,
				kind: 'Impl',
				visibility: this.mapVisibility(item.visibility),
				span: item.span ? this.mapSpan(item.span) : null,
				attrs: this.formatAttributes(item.attrs),
				is_external: isExternal || undefined,
				generics: this.extractGenerics(impl.generics),
				where_clause: this.extractWhereClause(impl.generics),
				docs: item.docs ?? null,
				impl_type: implType,
				parent_impl: null,
				impl_trait: null // Will be resolved later
			};

			this.addNode(node);
		}

		// Defer impl edge resolution
		this.deferredImplEdges.push({
			implNodeId,
			forTypeId,
			traitId: implTraitId,
			items: impl.items
		});
	}

	/**
	 * Collect deferred type edges from an item.
	 */
	private collectDeferredTypeEdges(idStr: string, item: Item): void {
		const itemId = Number(idStr);
		const inner = item.inner;

		// Determine owner node ID
		let ownerId: string | null = null;

		if ('impl' in inner) {
			const itemCrateName = this.crateNameForId(item.crate_id);
			ownerId = `${itemCrateName}::impl-${itemId}`;
		} else {
			// Try to resolve from path index (may not be available yet during streaming)
			const pathInfo = this.pathIndex.get(itemId);
			if (pathInfo) {
				const cn = this.crateNameForId(pathInfo.crateId);
				ownerId = this.joinPath(cn, pathInfo.path);
			}
		}

		if (!ownerId) return;

		// Collect type IDs based on item kind
		const typeIds = new Set<Id>();

		if ('struct' in inner) {
			this.collectGenericsIds(inner.struct.generics, typeIds);
		} else if ('union' in inner) {
			this.collectGenericsIds(inner.union.generics, typeIds);
		} else if ('enum' in inner) {
			this.collectGenericsIds(inner.enum.generics, typeIds);
		} else if ('trait' in inner) {
			this.collectGenericsIds(inner.trait.generics, typeIds);
			this.collectBoundsIds(inner.trait.bounds, typeIds);
		} else if ('function' in inner) {
			this.collectSignatureIds(inner.function.sig, typeIds);
			this.collectGenericsIds(inner.function.generics, typeIds);
		} else if ('type_alias' in inner) {
			this.collectTypeIds(inner.type_alias.type, typeIds);
			this.collectGenericsIds(inner.type_alias.generics, typeIds);
		} else if ('impl' in inner) {
			this.collectGenericsIds(inner.impl.generics, typeIds);
			this.collectTypeIds(inner.impl.for, typeIds);
			if (inner.impl.trait) {
				typeIds.add(inner.impl.trait.id);
			}
		}

		// Defer UsesType edges
		for (const typeId of typeIds) {
			this.deferredUsesEdges.push({
				fromId: ownerId,
				toTypeId: typeId,
				kind: 'UsesType',
				confidence: 'Static'
			});
		}
	}

	/**
	 * Finalize the graph after streaming is complete.
	 * Resolves all deferred edges and flushes remaining batches.
	 */
	async finalize(): Promise<{
		nodes: Node[];
		edges: Edge[];
		externalCrates: ExternalCrateInfo[];
		root: Id | null;
		crateVersion: string | null;
	}> {
		// Resolve deferred UsesType edges
		for (const deferred of this.deferredUsesEdges) {
			const targetId = this.resolveId(deferred.toTypeId);
			if (targetId && targetId !== deferred.fromId) {
				this.addEdge(deferred.fromId, targetId, deferred.kind, deferred.confidence);
			}
		}

		// Resolve deferred impl edges
		for (const impl of this.deferredImplEdges) {
			// Update impl_trait on the impl node
			if (impl.traitId !== null) {
				const traitNodeId = this.resolveId(impl.traitId);
				if (traitNodeId) {
					const implNode = this.nodes.find((n) => n.id === impl.implNodeId);
					if (implNode) {
						implNode.impl_trait = traitNodeId;
					}
				}
			}

			// Defines edge from type to impl
			if (impl.forTypeId !== null) {
				const typeNodeId = this.resolveId(impl.forTypeId);
				if (typeNodeId) {
					this.addEdge(typeNodeId, impl.implNodeId, 'Defines', 'Static');

					// Implements edge from type to trait
					if (impl.traitId !== null) {
						const traitNodeId = this.resolveId(impl.traitId);
						if (traitNodeId) {
							this.addEdge(typeNodeId, traitNodeId, 'Implements', 'Static');
						}
					}
				}
			}
		}

		// Flush remaining batches
		this.flushPendingNodes();
		this.flushPendingEdges();

		// Report final checkpoint
		await this.batchCallbacks.onCheckpoint?.({
			nodeCount: this.nodes.length,
			pendingEdgeCount: 0,
			lastItemId: this.lastItemId,
			phase: 'complete'
		});

		return {
			nodes: this.nodes,
			edges: this.edges,
			externalCrates: this.externalCrates,
			root: this.root,
			crateVersion: this.crateVersion
		};
	}

	/**
	 * Get current checkpoint state.
	 */
	getCheckpoint(): BuilderCheckpoint {
		return {
			nodeCount: this.nodes.length,
			pendingEdgeCount: this.deferredUsesEdges.length + this.deferredImplEdges.length,
			lastItemId: this.lastItemId,
			phase: 'streaming'
		};
	}

	// ---------------------------------------------------------------------------
	// Node/Edge helpers
	// ---------------------------------------------------------------------------

	private addNode(node: Node): void {
		if (this.nodeCache.has(node.id)) return;

		this.nodeCache.add(node.id);
		this.nodes.push(node);
		this.pendingNodes.push(node);

		if (this.pendingNodes.length >= this.batchSize) {
			this.flushPendingNodes();
		}
	}

	private addEdge(from: string, to: string, kind: EdgeKind, confidence: Confidence): void {
		const key = `${from}|${to}|${kind}`;
		if (this.edgeCache.has(key)) return;

		this.edgeCache.add(key);
		const edge: Edge = { from, to, kind, confidence };
		this.edges.push(edge);
		this.pendingEdges.push(edge);

		if (this.pendingEdges.length >= this.batchSize) {
			this.flushPendingEdges();
		}
	}

	private async flushPendingNodes(): Promise<void> {
		if (this.pendingNodes.length === 0) return;

		const batch = this.pendingNodes;
		this.pendingNodes = [];

		await this.batchCallbacks.onNodeBatch?.(batch, this.nodeBatchIndex);
		this.nodeBatchIndex++;
	}

	private async flushPendingEdges(): Promise<void> {
		if (this.pendingEdges.length === 0) return;

		const batch = this.pendingEdges;
		this.pendingEdges = [];

		await this.batchCallbacks.onEdgeBatch?.(batch, this.edgeBatchIndex);
		this.edgeBatchIndex++;
	}

	private ensureCrateNode(crateName: string, visibility: Visibility, isExternal: boolean): void {
		if (this.nodeCache.has(crateName)) return;

		this.addNode({
			id: crateName,
			name: crateName,
			kind: 'Crate',
			visibility,
			attrs: [],
			is_external: isExternal || undefined
		});
	}

	private ensureModuleNodes(
		crateName: string,
		path: string[],
		isExternal: boolean
	): void {
		if (path.length <= 1) return;

		let parentId = crateName;
		for (let i = 0; i < path.length - 1; i++) {
			const moduleId = this.joinPath(crateName, path.slice(0, i + 1));
			if (!this.nodeCache.has(moduleId)) {
				this.addNode({
					id: moduleId,
					name: path[i],
					kind: 'Module',
					visibility: 'Unknown',
					attrs: [],
					is_external: isExternal || undefined
				});
			}
			if (parentId !== moduleId) {
				this.addEdge(parentId, moduleId, 'Contains', 'Static');
			}
			parentId = moduleId;
		}
	}

	// ---------------------------------------------------------------------------
	// ID resolution
	// ---------------------------------------------------------------------------

	private resolveId(id: Id): string | null {
		const pathInfo = this.pathIndex.get(id);
		if (!pathInfo) return null;

		const cn = this.crateNameForId(pathInfo.crateId);
		return this.joinPath(cn, pathInfo.path);
	}

	private crateNameForId(crateId: number): string {
		return this.externalCrateNames.get(crateId) ?? this.crateName;
	}

	private joinPath(crateName: string, path: string[]): string {
		if (path.length === 0) return crateName;
		const start = path[0] === crateName ? 1 : 0;
		if (start >= path.length) return crateName;
		return `${crateName}::${path.slice(start).join('::')}`;
	}

	private parentPathId(crateName: string, path: string[]): string | null {
		if (path.length === 0) return null;
		if (path.length === 1) return crateName;
		return this.joinPath(crateName, path.slice(0, -1));
	}

	private typeToId(ty: Type): Id | null {
		if (!ty || typeof ty === 'string') return null;
		if ('resolved_path' in ty) return ty.resolved_path.id;
		if ('qualified_path' in ty) return this.typeToId(ty.qualified_path.self_type);
		return null;
	}

	// ---------------------------------------------------------------------------
	// Item kind mapping
	// ---------------------------------------------------------------------------

	private mapItemKind(kind: string, isMethod: boolean): NodeKind | null {
		switch (kind) {
			case 'module': return 'Module';
			case 'struct': return 'Struct';
			case 'union': return 'Union';
			case 'enum': return 'Enum';
			case 'trait': return 'Trait';
			case 'trait_alias': return 'TraitAlias';
			case 'impl': return 'Impl';
			case 'function': return isMethod ? 'Method' : 'Function';
			case 'type_alias': return 'TypeAlias';
			default: return null;
		}
	}

	private mapVisibility(vis: RdtVisibility): Visibility {
		if (typeof vis === 'string') {
			switch (vis) {
				case 'public': return 'Public';
				case 'crate': return 'Crate';
				case 'default': return 'Inherited';
				default: return 'Unknown';
			}
		}
		if (vis && typeof vis === 'object' && 'restricted' in vis) return 'Restricted';
		return 'Unknown';
	}

	private mapSpan(span: { filename: string; begin: [number, number]; end: [number, number] }): Span {
		return {
			file: span.filename,
			line: span.begin[0],
			column: span.begin[1],
			end_line: span.end[0],
			end_column: span.end[1]
		};
	}

	// ---------------------------------------------------------------------------
	// Generics/bounds extraction
	// ---------------------------------------------------------------------------

	private extractGenerics(generics: Generics): string[] | null {
		const params = generics.params.map((p) => {
			const kind = p.kind;
			if ('type' in kind) {
				let s = p.name;
				const boundStrs = this.formatBoundsStr(kind.type.bounds);
				if (boundStrs.length > 0) s += `: ${boundStrs.join(' + ')}`;
				if (kind.type.default) s += ` = ${this.formatType(kind.type.default)}`;
				return s;
			}
			if ('lifetime' in kind) return p.name;
			if ('const' in kind) return `const ${p.name}: ${this.formatType(kind.const.type)}`;
			return p.name;
		});
		return params.length > 0 ? params : null;
	}

	private extractWhereClause(generics: Generics): string[] | null {
		const predicates: string[] = [];
		for (const pred of generics.where_predicates) {
			if ('bound_predicate' in pred) {
				const ty = this.formatType(pred.bound_predicate.type);
				const boundStrs = this.formatBoundsStr(pred.bound_predicate.bounds);
				if (boundStrs.length > 0) predicates.push(`${ty}: ${boundStrs.join(' + ')}`);
			} else if ('lifetime_predicate' in pred) {
				const outlives = pred.lifetime_predicate.outlives;
				if (outlives.length > 0) {
					predicates.push(`${pred.lifetime_predicate.lifetime}: ${outlives.join(' + ')}`);
				}
			}
		}
		return predicates.length > 0 ? predicates : null;
	}

	private formatBoundsStr(bounds: GenericBound[]): string[] {
		return bounds
			.map((b) => {
				if ('trait_bound' in b) return b.trait_bound?.trait?.path ? this.cleanPath(b.trait_bound.trait.path) : null;
				if ('outlives' in b) return b.outlives;
				return null;
			})
			.filter((s): s is string => s !== null);
	}

	private cleanPath(path: string): string {
		const last = path.split('::').pop();
		return last ?? path;
	}

	private formatType(ty: Type): string {
		if (!ty || typeof ty === 'string') return '_';
		if ('resolved_path' in ty) {
			let result = this.cleanPath(ty.resolved_path.path);
			if (ty.resolved_path.args) {
				result += this.formatGenericArgs(ty.resolved_path.args);
			}
			return result;
		}
		if ('generic' in ty) return ty.generic;
		if ('primitive' in ty) return ty.primitive;
		if ('tuple' in ty) return `(${ty.tuple.map((t) => this.formatType(t)).join(', ')})`;
		if ('slice' in ty) return `[${this.formatType(ty.slice)}]`;
		if ('borrowed_ref' in ty) {
			const mut = ty.borrowed_ref.is_mutable ? 'mut ' : '';
			return `&${mut}${this.formatType(ty.borrowed_ref.type)}`;
		}
		return '_';
	}

	private formatGenericArgs(args: GenericArgs): string {
		if (!args || typeof args === 'string') {
			return args === 'return_type_notation' ? '(..)' : '';
		}
		if ('angle_bracketed' in args) {
			const a = args.angle_bracketed.args;
			if (a.length === 0) return '';
			const strs = a.map((arg) => {
				if (typeof arg === 'string') return '_';
				if ('type' in arg) return this.formatType(arg.type);
				if ('lifetime' in arg) return arg.lifetime;
				if ('const' in arg) return arg.const.value ?? '';
				return '_';
			});
			return `<${strs.join(', ')}>`;
		}
		return '';
	}

	private implNodeName(impl: Impl): string {
		const forId = this.typeToId(impl.for);
		let typeName = 'type';
		if (forId !== null) {
			const resolved = this.resolveId(forId);
			if (resolved) typeName = resolved.split('::').pop() ?? 'type';
		} else if (impl.for && typeof impl.for === 'object' && 'resolved_path' in impl.for) {
			typeName = this.cleanPath(impl.for.resolved_path.path);
		}

		if (impl.trait) {
			const traitName = this.cleanPath(impl.trait.path);
			return `impl ${traitName} for ${typeName}`;
		}
		return `impl ${typeName}`;
	}

	// ---------------------------------------------------------------------------
	// Attribute formatting
	// ---------------------------------------------------------------------------

	private formatAttributes(attrs: Attribute[]): string[] {
		return attrs.map((attr) => this.attributeToString(attr)).filter((s): s is string => s !== null);
	}

	private attributeToString(attr: Attribute): string | null {
		if (typeof attr === 'string') {
			switch (attr) {
				case 'non_exhaustive': return '#[non_exhaustive]';
				case 'automatically_derived': return '#[automatically_derived]';
				case 'macro_export': return '#[macro_export]';
				case 'no_mangle': return '#[no_mangle]';
				default: return attr;
			}
		}
		if ('must_use' in attr) {
			return attr.must_use.reason ? `#[must_use = "${attr.must_use.reason}"]` : '#[must_use]';
		}
		if ('repr' in attr) return `#[repr(...)]`;
		if ('other' in attr) return attr.other;
		return null;
	}

	// ---------------------------------------------------------------------------
	// Type ID collection (for deferred edges)
	// ---------------------------------------------------------------------------

	private collectTypeIds(ty: Type, ids: Set<Id>): void {
		if (!ty || typeof ty === 'string') return;
		if ('resolved_path' in ty) {
			ids.add(ty.resolved_path.id);
			if (ty.resolved_path.args) this.collectGenericArgsIds(ty.resolved_path.args, ids);
		} else if ('dyn_trait' in ty) {
			for (const poly of ty.dyn_trait.traits) {
				if (poly.trait) {
					ids.add(poly.trait.id);
					if (poly.trait.args) this.collectGenericArgsIds(poly.trait.args, ids);
				}
			}
		} else if ('tuple' in ty) {
			for (const t of ty.tuple) this.collectTypeIds(t, ids);
		} else if ('slice' in ty) {
			this.collectTypeIds(ty.slice, ids);
		} else if ('array' in ty) {
			this.collectTypeIds(ty.array.type, ids);
		} else if ('impl_trait' in ty) {
			this.collectBoundsIds(ty.impl_trait, ids);
		} else if ('borrowed_ref' in ty) {
			this.collectTypeIds(ty.borrowed_ref.type, ids);
		} else if ('raw_pointer' in ty) {
			this.collectTypeIds(ty.raw_pointer.type, ids);
		} else if ('qualified_path' in ty) {
			this.collectTypeIds(ty.qualified_path.self_type, ids);
			if (ty.qualified_path.trait) {
				ids.add(ty.qualified_path.trait.id);
				if (ty.qualified_path.trait.args) {
					this.collectGenericArgsIds(ty.qualified_path.trait.args, ids);
				}
			}
		}
	}

	private collectGenericArgsIds(args: GenericArgs, ids: Set<Id>): void {
		if (!args || typeof args === 'string') return;
		if ('angle_bracketed' in args) {
			for (const arg of args.angle_bracketed.args) {
				if (typeof arg !== 'string' && 'type' in arg) {
					this.collectTypeIds(arg.type, ids);
				}
			}
		} else if ('parenthesized' in args) {
			for (const input of args.parenthesized.inputs) {
				this.collectTypeIds(input, ids);
			}
			if (args.parenthesized.output) {
				this.collectTypeIds(args.parenthesized.output, ids);
			}
		}
	}

	private collectBoundsIds(bounds: GenericBound[], ids: Set<Id>): void {
		for (const bound of bounds) {
			if ('trait_bound' in bound && bound.trait_bound?.trait) {
				ids.add(bound.trait_bound.trait.id);
				if (bound.trait_bound.trait.args) {
					this.collectGenericArgsIds(bound.trait_bound.trait.args, ids);
				}
			}
		}
	}

	private collectGenericsIds(generics: Generics, ids: Set<Id>): void {
		for (const param of generics.params) {
			const kind = param.kind;
			if ('type' in kind) {
				this.collectBoundsIds(kind.type.bounds, ids);
				if (kind.type.default) this.collectTypeIds(kind.type.default, ids);
			} else if ('const' in kind) {
				this.collectTypeIds(kind.const.type, ids);
			}
		}
		for (const pred of generics.where_predicates) {
			if ('bound_predicate' in pred) {
				this.collectTypeIds(pred.bound_predicate.type, ids);
				this.collectBoundsIds(pred.bound_predicate.bounds, ids);
			}
		}
	}

	private collectSignatureIds(sig: RdtFunctionSignature, ids: Set<Id>): void {
		for (const [, ty] of sig.inputs) {
			this.collectTypeIds(ty, ids);
		}
		if (sig.output) {
			this.collectTypeIds(sig.output, ids);
		}
	}
}

/**
 * Build a graph from a streaming parser with batch callbacks.
 *
 * @param crateName - The crate name
 * @param options - Build options including batch callbacks
 * @returns The builder instance (call createParseCallbacks() to get callbacks for parser)
 */
export function createStreamingGraphBuilder(
	crateName: string,
	options?: {
		batchSize?: number;
		skipExternalNodes?: boolean;
		batchCallbacks?: BatchCallbacks;
	}
): StreamingGraphBuilder {
	return new StreamingGraphBuilder(crateName, options);
}
