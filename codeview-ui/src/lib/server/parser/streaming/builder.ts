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
	Graph,
} from '$lib/graph';
import { getLogger } from '$lib/log';
import { normalizeCrateName } from '$lib/crate-names';
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
	Visibility as RdtVisibility,
} from '../rustdoc.types';
import type { StreamingParseCallbacks } from './parser';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default batch size for node/edge callbacks */
export const DEFAULT_BATCH_SIZE = 1000;

const log = getLogger('streaming-builder');

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

/**
 * Storage callbacks for progressive database storage.
 * When provided, nodes/edges are stored directly without accumulating in memory.
 */
export interface ProgressiveStorageCallbacks {
	/** Called for each batch of nodes - should INSERT to DB */
	storeNodes: (nodes: Node[]) => void | Promise<void>;
	/** Called for each batch of edges - should INSERT to DB */
	storeEdges: (edges: Edge[]) => void | Promise<void>;
	/** Called to update a node (e.g., impl_trait field) - should UPDATE in DB */
	updateNode?: (nodeId: string, updates: Partial<Node>) => void | Promise<void>;
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
	forTypeName: string;
	traitName: string | null;
	items: Id[];
}

/** External crate info collected during streaming */
interface ExternalCrateInfo {
	id: string;
	name: string;
}

type DeferredNodeKindMetadata =
	| { kind: 'none' }
	| {
			kind: 'function';
			signature: FunctionSignatureOut;
			generics: string[] | null;
			whereClause: string[] | null;
	  }
	| {
			kind: 'struct';
			generics: string[] | null;
			whereClause: string[] | null;
			structKind: StructKind;
	  }
	| {
			kind: 'union';
			generics: string[] | null;
			whereClause: string[] | null;
			fieldIds: Id[];
	  }
	| {
			kind: 'enum';
			generics: string[] | null;
			whereClause: string[] | null;
			variantIds: Id[];
	  };

interface DeferredNodeMetadata {
	visibility: Visibility;
	span: Span | null;
	attrs: string[];
	docs: string | null;
	links: Record<string, Id>;
	kindMeta: DeferredNodeKindMetadata;
}

// ---------------------------------------------------------------------------
// Streaming Graph Builder
// ---------------------------------------------------------------------------

export class StreamingGraphBuilder {
	// Configuration
	private readonly crateName: string;
	private readonly batchSize: number;
	private readonly skipExternalNodes: boolean;
	private readonly retainItemIndex: boolean;
	private readonly dedupeEdgesInMemory: boolean;
	private readonly batchCallbacks: BatchCallbacks;
	private readonly storageCallbacks: ProgressiveStorageCallbacks | null;

	// Collected data during streaming (only used when NOT in progressive mode)
	private nodes: Node[] = [];
	private edges: Edge[] = [];

	// Always used - for O(1) lookup
	private nodeIndex = new Map<string, Node>(); // O(1) node lookup
	private edgeCache = new Set<string>();

	// Counters for progressive mode
	private _nodeCount = 0;
	private _edgeCount = 0;

	// Deferred resolution data - indexed by target ID for incremental resolution
	private pendingEdgesByTarget = new Map<Id, DeferredEdge[]>();
	private pendingImplEdgesByTarget = new Map<Id, DeferredImplEdge[]>();
	// Track unresolved for final pass
	private unresolvedEdgeCount = 0;
	private unresolvedImplCount = 0;

	// Path index (built from $.paths.*) maps rustdoc item id -> canonical node id
	private pathIndex = new Map<Id, string>();
	// Item index (built from $.index.*) for metadata enrichment (docs/fields/variants/signatures)
	private itemIndex = new Map<Id, Item>();
	// Metadata deferred until the matching path is processed.
	private deferredMetadata = new Map<Id, DeferredNodeMetadata>();

	// External crates
	private externalCrates: ExternalCrateInfo[] = [];
	private externalCrateNames = new Map<number, string>(); // crateId -> name
	private localCrateId: number | null = null;
	private deferredPathsByCrate = new Map<number, Array<{ id: Id; summary: ItemSummary }>>();

	// Metadata
	private root: Id | null = null;
	private crateVersion: string | null = null;

	// Impl item tracking: maps item ID -> impl node ID for creating Impl->Function edges
	private implItemToImplNode = new Map<Id, string>();
	// Track processed item node IDs for deferred impl->item edge creation
	private processedItemNodes = new Map<Id, string>(); // itemId -> nodeId

	// Batch tracking
	private nodeBatchIndex = 0;
	private edgeBatchIndex = 0;
	private pendingNodes: Node[] = [];
	private pendingEdges: Edge[] = [];
	private lastItemId: string | null = null;
	private updatedNodes = new Set<string>();

	constructor(
		crateName: string,
		options: {
			batchSize?: number;
			skipExternalNodes?: boolean;
			/** Keep full item objects for finalize-time metadata enrichment. */
			retainItemIndex?: boolean;
			/** Deduplicate edges in-memory (higher memory usage). */
			dedupeEdgesInMemory?: boolean;
			batchCallbacks?: BatchCallbacks;
			/** Progressive storage - when set, nodes/edges stored directly to DB without accumulating in memory */
			storageCallbacks?: ProgressiveStorageCallbacks;
		} = {},
	) {
		this.crateName = normalizeCrateName(crateName);
		this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
		this.skipExternalNodes = options.skipExternalNodes ?? true;
		this.retainItemIndex = options.retainItemIndex ?? true;
		this.dedupeEdgesInMemory = options.dedupeEdgesInMemory ?? true;
		this.batchCallbacks = options.batchCallbacks ?? {};
		this.storageCallbacks = options.storageCallbacks ?? null;

		// Ensure crate root node exists
		this.ensureCrateNode(this.crateName, 'Public', false);
	}

	/** Get current node count for progress reporting. */
	get nodeCount(): number {
		return this._nodeCount;
	}

	/** Get current edge count for progress reporting. */
	get edgeCount(): number {
		return this._edgeCount;
	}

	/** Get accumulated nodes (for delta updates during streaming). */
	getNodes(): readonly Node[] {
		return this.nodes;
	}

	/** Get accumulated edges (for delta updates during streaming). */
	getEdges(): readonly Edge[] {
		return this.edges;
	}

	/**
	 * Creates parse callbacks for the streaming parser.
	 */
	createParseCallbacks(): StreamingParseCallbacks {
		let itemCount = 0;
		let pathCount = 0;
		const PROGRESS_INTERVAL = 50000;

		return {
			onRoot: (root) => {
				this.root = root;
			},
			onCrateVersion: (version) => {
				this.crateVersion = version;
			},
			onItem: (id, item) => {
				this.processItem(id, item);
				itemCount++;
				if (itemCount % PROGRESS_INTERVAL === 0) {
					log.debug`parse: ${String(itemCount)} items, ${String(this._nodeCount)} nodes, ${String(this._edgeCount)} edges`;
				}
			},
			onPath: (id, summary) => {
				this.processPath(id, summary);
				pathCount++;
				if (pathCount % PROGRESS_INTERVAL === 0) {
					log.debug`parse: ${String(pathCount)} paths, ${String(this._nodeCount)} nodes, ${String(this._edgeCount)} edges`;
				}
			},
			onExternalCrate: (id, crate) => {
				this.processExternalCrate(id, crate);
			},
			onComplete: () => {
				this.flushRemainingDeferredPaths();
				let pendingCount = 0;
				for (const edges of this.pendingEdgesByTarget.values()) pendingCount += edges.length;
				for (const impls of this.pendingImplEdgesByTarget.values()) pendingCount += impls.length;
				log.info`parse complete: ${String(itemCount)} items, ${String(pathCount)} paths → ${String(this._nodeCount)} nodes, ${String(this._edgeCount)} edges (${String(pendingCount)} pending)`;
				// Flush any remaining pending nodes
				this.flushPendingNodes();
			},
			onError: (error) => {
				log.error`parse error: ${error}`;
			},
		};
	}

	/**
	 * Process a single item from $.index.*
	 */
	private processItem(idStr: string, item: Item): void {
		this.lastItemId = idStr;
		const itemId = Number(idStr);
		if (this.retainItemIndex || this.shouldRetainReferencedItem(item)) {
			this.itemIndex.set(itemId, item);
		}

		try {
			const applied = this.applyItemMetadata(itemId, item);
			if (!applied && !this.retainItemIndex && this.shouldDeferNodeMetadata(item.inner)) {
				this.deferredMetadata.set(itemId, this.toDeferredNodeMetadata(item));
			}

			if ('impl' in item.inner) {
				// Process impl block
				this.processImplItem(itemId, item);
			}

			// Handle impl items (methods/associated items) that may not have path entries
			// Check if this item belongs to an impl and create node + edge if needed
			const implNodeId = this.implItemToImplNode.get(itemId);
			if (implNodeId && !this.processedItemNodes.has(itemId)) {
				this.createImplItemNode(itemId, item, implNodeId);
			}

			// Collect type references for UsesType edges (deferred)
			this.collectDeferredTypeEdges(idStr, item);
		} catch (err) {
			// Log but don't fail - continue processing
			log.warn`Skipped item ${idStr}: ${err instanceof Error ? err.message : String(err)}`;
		}
	}

	/**
	 * Process a path summary from $.paths.*
	 * Also resolves any pending edges that were waiting for this path.
	 */
	private processPath(idStr: string, summary: ItemSummary): void {
		const itemId = Number(idStr);

		if (this.localCrateId === null && summary.path[0] === this.crateName) {
			this.localCrateId = summary.crate_id;
			this.flushDeferredPathsFor(summary.crate_id);
		}

		const crateKnown =
			(this.localCrateId !== null && summary.crate_id === this.localCrateId) ||
			this.externalCrateNames.has(summary.crate_id);
		if (!crateKnown) {
			const pending = this.deferredPathsByCrate.get(summary.crate_id) ?? [];
			pending.push({ id: itemId, summary });
			this.deferredPathsByCrate.set(summary.crate_id, pending);
			return;
		}

		this.processResolvedPath(itemId, summary);
	}

	private processResolvedPath(itemId: Id, summary: ItemSummary): void {
		// Skip internal/generated paths
		if (summary.path.length === 0) return;
		if (summary.path.some((seg) => seg === '_' || seg.startsWith('__'))) return;

		const nodeKind = this.mapItemKind(summary.kind);
		if (!nodeKind) return;

		const itemCrateName = this.crateNameForId(summary.crate_id);
		const isExternal = itemCrateName !== this.crateName;

		if (isExternal && this.skipExternalNodes) return;

		// Ensure crate and module nodes exist
		this.ensureCrateNode(itemCrateName, 'Public', isExternal);
		this.ensureModuleNodes(itemCrateName, summary.path, isExternal);

		// Create node
		const nodeId = this.joinPath(itemCrateName, summary.path);
		this.pathIndex.set(itemId, nodeId);
		if (!this.nodeIndex.has(nodeId)) {
			const name = summary.path[summary.path.length - 1] ?? nodeId;

			const node: Node = {
				id: nodeId,
				name,
				kind: nodeKind,
				visibility: 'Unknown', // Will be updated when we see the item
				attrs: [],
				is_external: isExternal || undefined,
			};

			this.addNode(node);
		}

		// INCREMENTAL: resolve pending edges only after crate mapping for this path is known.
		this.resolvePendingEdgesFor(itemId);

		// Track this item for impl->method edge creation
		this.processedItemNodes.set(itemId, nodeId);

		// Check if this item belongs to an impl block and create edge
		const implNodeId = this.implItemToImplNode.get(itemId);
		if (implNodeId) {
			this.addEdge(implNodeId, nodeId, 'Defines', 'Static');
		}

		// Add Contains edge from parent (skip impl nodes/items; impl relationships are
		// modeled via Defines/Implements edges from the target type)
		const parentId = this.parentPathId(itemCrateName, summary.path);
		if (parentId && parentId !== nodeId && !implNodeId && nodeKind !== 'Impl') {
			this.addEdge(parentId, nodeId, 'Contains', 'Static');
		}

		// If the full item already arrived, apply rich metadata now.
		const item = this.itemIndex.get(itemId);
		if (item) this.applyItemMetadata(itemId, item);

		if (!this.retainItemIndex) {
			const deferred = this.deferredMetadata.get(itemId);
			if (deferred) this.applyDeferredMetadata(itemId, deferred);
		}
	}

	/**
	 * Process an external crate from $.external_crates.*
	 */
	private processExternalCrate(idStr: string, crate: ExternalCrate): void {
		const crateId = Number(idStr);
		const normalizedName = normalizeCrateName(crate.name);

		this.externalCrateNames.set(crateId, normalizedName);
		this.externalCrates.push({
			id: normalizedName,
			name: crate.name,
		});
		this.flushDeferredPathsFor(crateId);
	}

	private flushDeferredPathsFor(crateId: number): void {
		const pending = this.deferredPathsByCrate.get(crateId);
		if (!pending || pending.length === 0) return;
		this.deferredPathsByCrate.delete(crateId);
		for (const entry of pending) {
			this.processResolvedPath(entry.id, entry.summary);
		}
	}

	private flushRemainingDeferredPaths(): void {
		let count = 0;
		for (const pending of this.deferredPathsByCrate.values()) count += pending.length;
		if (count > 0) {
			// Expected for items from external crates that weren't explicitly mapped
			log.debug`finalize: processing ${String(count)} deferred paths without crate mapping`;
		}
		for (const [, pending] of this.deferredPathsByCrate) {
			for (const entry of pending) {
				this.processResolvedPath(entry.id, entry.summary);
			}
		}
		this.deferredPathsByCrate.clear();
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
		const forTypeName = this.implForTypeName(impl.for);
		const traitName = impl.trait ? this.cleanPath(impl.trait.path) : null;

		if (!this.nodeIndex.has(implNodeId)) {
			const name = this.implNodeName(forTypeName, traitName);
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
				impl_trait: null, // Will be resolved later
			};

			this.addNode(node);
		}

		// Try to resolve impl edges immediately, or defer indexed by target
		const implEdge: DeferredImplEdge = {
			implNodeId,
			forTypeId,
			traitId: implTraitId,
			forTypeName,
			traitName,
			items: impl.items,
		};

		// Try immediate resolution
		const forResolved = forTypeId !== null ? this.resolveId(forTypeId) : null;
		const traitResolved = implTraitId !== null ? this.resolveId(implTraitId) : null;

		if (forResolved || forTypeId === null) {
			// Can resolve now
			this.tryResolveImplEdge(implEdge);
		} else {
			// Queue by forTypeId for later resolution
			if (forTypeId !== null) {
				const pending = this.pendingImplEdgesByTarget.get(forTypeId) ?? [];
				pending.push(implEdge);
				this.pendingImplEdgesByTarget.set(forTypeId, pending);
			}
			// Also queue by traitId if different
			if (implTraitId !== null && implTraitId !== forTypeId) {
				const pending = this.pendingImplEdgesByTarget.get(implTraitId) ?? [];
				pending.push(implEdge);
				this.pendingImplEdgesByTarget.set(implTraitId, pending);
			}
		}

		// Register impl items for edge creation (impl -> method/function edges)
		// This enables showing methods in type detail views
		for (const assocItemId of impl.items) {
			this.implItemToImplNode.set(assocItemId, implNodeId);
			// If we already processed this item, create the edge now
			const existingNodeId = this.processedItemNodes.get(assocItemId);
			if (existingNodeId) {
				this.addEdge(implNodeId, existingNodeId, 'Defines', 'Static');
			}
		}
	}

	/**
	 * Create a node for an impl item (method/associated type) and link it to its impl.
	 * This handles items that don't have path entries but are listed in impl.items.
	 */
	private createImplItemNode(itemId: Id, item: Item, implNodeId: string): void {
		const inner = item.inner;

		// Determine node kind from item inner type
		// Associated items in impls use specific kinds matching rustdoc schema
		let nodeKind: NodeKind | null = null;
		if ('function' in inner) {
			nodeKind = 'Function';
		} else if ('assoc_type' in inner) {
			nodeKind = 'AssocType';
		} else if ('assoc_const' in inner) {
			nodeKind = 'AssocConst';
		} else if ('type_alias' in inner) {
			// Fallback for older rustdoc versions
			nodeKind = 'TypeAlias';
		} else if ('constant' in inner) {
			// Fallback for older rustdoc versions
			nodeKind = 'Constant';
		}

		if (!nodeKind) return;

		const name = item.name ?? `item-${itemId}`;
		// Use impl-scoped node ID to match Rust parser pattern
		const nodeId = `${implNodeId}::${name}`;

		if (this.nodeIndex.has(nodeId)) {
			// Node already exists, just track and add edge
			this.processedItemNodes.set(itemId, nodeId);
			this.addEdge(implNodeId, nodeId, 'Defines', 'Static');
			return;
		}

		const itemCrateName = this.crateNameForId(item.crate_id);
		const isExternal = itemCrateName !== this.crateName;

		if (isExternal && this.skipExternalNodes) return;

		const node: Node = {
			id: nodeId,
			name,
			kind: nodeKind,
			visibility: this.mapVisibility(item.visibility),
			span: item.span ? this.mapSpan(item.span) : null,
			attrs: this.formatAttributes(item.attrs),
			is_external: isExternal || undefined,
			docs: item.docs ?? null,
			parent_impl: implNodeId,
		};

		// Add type-specific data
		if ('function' in inner) {
			const sig = inner.function.sig;
			const header = inner.function.header;
			node.signature = {
				inputs: sig.inputs.map(([name, ty]) => ({ name, type_name: this.formatType(ty) })),
				output: sig.output ? this.formatType(sig.output) : null,
				is_async: header.is_async,
				is_unsafe: header.is_unsafe,
				is_const: header.is_const,
			};
			node.generics = this.extractGenerics(inner.function.generics);
			node.where_clause = this.extractWhereClause(inner.function.generics);
		} else if ('assoc_type' in inner) {
			const assocType = inner.assoc_type;
			node.generics = this.extractGenerics(assocType.generics);
			node.bounds = assocType.bounds?.map((b: unknown) => this.formatGenericBound(b)) ?? null;
			node.type_name = assocType.type ? this.formatType(assocType.type) : null;
		} else if ('assoc_const' in inner) {
			const assocConst = inner.assoc_const;
			node.type_name = this.formatType(assocConst.type);
			node.const_value = assocConst.value ?? null;
		}

		this.addNode(node);
		this.processedItemNodes.set(itemId, nodeId);
		this.addEdge(implNodeId, nodeId, 'Defines', 'Static');
	}

	/**
	 * Collect deferred type edges from an item.
	 */
	private collectDeferredTypeEdges(idStr: string, item: Item): void {
		const itemId = Number(idStr);
		const inner = item.inner;

		// Determine owner node ID
		const ownerId =
			'impl' in inner
				? `${this.crateNameForId(item.crate_id)}::impl-${itemId}`
				: (this.pathIndex.get(itemId) ?? null);

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

		// Defer UsesType edges - indexed by target for incremental resolution
		for (const typeId of typeIds) {
			const edge: DeferredEdge = {
				fromId: ownerId,
				toTypeId: typeId,
				kind: 'UsesType',
				confidence: 'Static',
			};

			// Try to resolve immediately if path already known
			const targetId = this.resolveId(typeId);
			if (targetId && targetId !== ownerId) {
				this.addEdge(ownerId, targetId, 'UsesType', 'Static');
			} else {
				// Queue for resolution when path arrives
				const pending = this.pendingEdgesByTarget.get(typeId) ?? [];
				pending.push(edge);
				this.pendingEdgesByTarget.set(typeId, pending);
			}
		}
	}

	/**
	 * Resolve any pending edges that were waiting for a specific path ID.
	 * Called incrementally as each path arrives.
	 */
	private resolvePendingEdgesFor(pathId: Id): void {
		// Resolve pending UsesType edges
		const pendingEdges = this.pendingEdgesByTarget.get(pathId);
		if (pendingEdges) {
			const targetId = this.resolveId(pathId);
			if (targetId) {
				for (const edge of pendingEdges) {
					if (targetId !== edge.fromId) {
						this.addEdge(edge.fromId, targetId, edge.kind, edge.confidence);
					}
				}
			} else {
				this.unresolvedEdgeCount += pendingEdges.length;
			}
			this.pendingEdgesByTarget.delete(pathId);
		}

		// Resolve pending impl edges that reference this path as forType or trait
		const pendingImpls = this.pendingImplEdgesByTarget.get(pathId);
		if (pendingImpls) {
			for (const impl of pendingImpls) {
				this.tryResolveImplEdge(impl);
			}
			this.pendingImplEdgesByTarget.delete(pathId);
		}
	}

	/**
	 * Try to resolve an impl edge. If not fully resolvable, re-queue it.
	 */
	private tryResolveImplEdge(impl: DeferredImplEdge): void {
		const forTypeNodeId = impl.forTypeId !== null ? this.resolveId(impl.forTypeId) : null;
		const traitNodeId = impl.traitId !== null ? this.resolveId(impl.traitId) : null;
		const implNode = this.nodeIndex.get(impl.implNodeId);

		if (implNode) {
			const resolvedForTypeName = forTypeNodeId
				? (this.nodeIndex.get(forTypeNodeId)?.name ?? impl.forTypeName)
				: impl.forTypeName;
			const resolvedTraitName = traitNodeId
				? (this.nodeIndex.get(traitNodeId)?.name ?? impl.traitName)
				: impl.traitName;
			const nextName = this.implNodeName(resolvedForTypeName, resolvedTraitName);
			if (nextName !== implNode.name) implNode.name = nextName;
		}

		// Update impl_trait on the impl node if trait is resolved
		if (impl.traitId !== null && traitNodeId) {
			if (implNode && !implNode.impl_trait) {
				implNode.impl_trait = traitNodeId;
			}
		}

		// Create edges if forType is resolved
		if (forTypeNodeId) {
			this.addEdge(forTypeNodeId, impl.implNodeId, 'Defines', 'Static');
			if (traitNodeId) {
				this.addEdge(forTypeNodeId, traitNodeId, 'Implements', 'Static');
			}
		}
	}

	/**
	 * Finalize the graph after streaming is complete.
	 * Most edges were resolved incrementally - this handles remaining stragglers.
	 */
	async finalize(): Promise<{
		nodes: Node[];
		edges: Edge[];
		nodeCount: number;
		edgeCount: number;
		externalCrates: ExternalCrateInfo[];
		root: Id | null;
		crateVersion: string | null;
	}> {
		const t0 = performance.now();
		const remainingEdges = this.pendingEdgesByTarget.size;
		const remainingImpls = this.pendingImplEdgesByTarget.size;
		log.info`finalize: ${String(remainingEdges)} unresolved edge targets, ${String(remainingImpls)} unresolved impl targets`;

		// Process any remaining unresolved edges (external crates, missing paths)
		let resolvedEdges = 0;
		for (const [targetId, edges] of this.pendingEdgesByTarget) {
			const resolved = this.resolveId(targetId);
			if (resolved) {
				for (const edge of edges) {
					if (resolved !== edge.fromId) {
						this.addEdge(edge.fromId, resolved, edge.kind, edge.confidence);
						resolvedEdges++;
					}
				}
			}
		}
		this.pendingEdgesByTarget.clear();
		log.info`finalize: resolved ${String(resolvedEdges)} remaining edges in ${(performance.now() - t0).toFixed(0)}ms`;

		// Process any remaining impl edges
		const t1 = performance.now();
		const updatedImplNodes: Node[] = [];
		let resolvedImpls = 0;

		for (const [, impls] of this.pendingImplEdgesByTarget) {
			for (const impl of impls) {
				const forTypeNodeId = impl.forTypeId !== null ? this.resolveId(impl.forTypeId) : null;
				const traitNodeId = impl.traitId !== null ? this.resolveId(impl.traitId) : null;

				if (impl.traitId !== null && traitNodeId) {
					const implNode = this.nodeIndex.get(impl.implNodeId);
					if (implNode && !implNode.impl_trait) {
						implNode.impl_trait = traitNodeId;
						if (this.storageCallbacks) {
							updatedImplNodes.push(implNode);
						}
					}
				}

				if (forTypeNodeId) {
					this.addEdge(forTypeNodeId, impl.implNodeId, 'Defines', 'Static');
					if (traitNodeId) {
						this.addEdge(forTypeNodeId, traitNodeId, 'Implements', 'Static');
					}
					resolvedImpls++;
				}
			}
		}
		this.pendingImplEdgesByTarget.clear();
		log.info`finalize: resolved ${String(resolvedImpls)} remaining impls in ${(performance.now() - t1).toFixed(0)}ms`;

		// Apply rich per-item metadata once all paths/items are available.
		const tMeta = performance.now();
		if (this.retainItemIndex) {
			for (const [itemId, item] of this.itemIndex) {
				this.applyItemMetadata(itemId, item);
			}
			this.itemIndex.clear();
		} else {
			for (const [itemId, metadata] of this.deferredMetadata) {
				this.applyDeferredMetadata(itemId, metadata);
			}
			this.deferredMetadata.clear();
			this.itemIndex.clear();
		}
		if (this.storageCallbacks && this.updatedNodes.size > 0) {
			const updates: Node[] = [];
			for (const nodeId of this.updatedNodes) {
				const node = this.nodeIndex.get(nodeId);
				if (node) updates.push(node);
			}
			const BATCH = 500;
			for (let i = 0; i < updates.length; i += BATCH) {
				await this.storageCallbacks.storeNodes(updates.slice(i, i + BATCH));
			}
			log.info`finalize: applied metadata to ${String(updates.length)} nodes in ${(performance.now() - tMeta).toFixed(0)}ms`;
			this.updatedNodes.clear();
		}

		// Flush remaining batches
		const t2 = performance.now();
		await this.flushPendingNodes();
		await this.flushPendingEdges();
		log.info`finalize: flushed batches in ${(performance.now() - t2).toFixed(0)}ms`;

		// Update impl nodes in storage
		if (this.storageCallbacks && updatedImplNodes.length > 0) {
			const t3 = performance.now();
			const BATCH = 500;
			for (let i = 0; i < updatedImplNodes.length; i += BATCH) {
				await this.storageCallbacks.storeNodes(updatedImplNodes.slice(i, i + BATCH));
			}
			log.info`finalize: updated ${String(updatedImplNodes.length)} impl nodes in ${(performance.now() - t3).toFixed(0)}ms`;
		}

		// Report final checkpoint
		await this.batchCallbacks.onCheckpoint?.({
			nodeCount: this._nodeCount,
			pendingEdgeCount: 0,
			lastItemId: this.lastItemId,
			phase: 'complete',
		});

		const total = performance.now() - t0;
		log.info`finalize: complete - ${String(this._nodeCount)} nodes, ${String(this._edgeCount)} edges in ${total.toFixed(0)}ms`;

		return {
			nodes: this.nodes,
			edges: this.edges,
			nodeCount: this._nodeCount,
			edgeCount: this._edgeCount,
			externalCrates: this.externalCrates,
			root: this.root,
			crateVersion: this.crateVersion,
		};
	}

	/**
	 * Get current checkpoint state.
	 */
	getCheckpoint(): BuilderCheckpoint {
		let pendingCount = 0;
		for (const edges of this.pendingEdgesByTarget.values()) pendingCount += edges.length;
		for (const impls of this.pendingImplEdgesByTarget.values()) pendingCount += impls.length;

		return {
			nodeCount: this._nodeCount,
			pendingEdgeCount: pendingCount,
			lastItemId: this.lastItemId,
			phase: 'streaming',
		};
	}

	// ---------------------------------------------------------------------------
	// Node/Edge helpers
	// ---------------------------------------------------------------------------

	private addNode(node: Node): void {
		if (this.nodeIndex.has(node.id)) return;

		this.nodeIndex.set(node.id, node);
		this._nodeCount++;

		// Only accumulate in memory if NOT using progressive storage
		if (!this.storageCallbacks) {
			this.nodes.push(node);
		}

		this.pendingNodes.push(node);

		if (this.pendingNodes.length >= this.batchSize) {
			this.flushPendingNodes();
		}
	}

	private addEdge(from: string, to: string, kind: EdgeKind, confidence: Confidence): void {
		const key = `${from}|${to}|${kind}`;
		if (this.dedupeEdgesInMemory) {
			if (this.edgeCache.has(key)) return;
			this.edgeCache.add(key);
		}
		const edge: Edge = { from, to, kind, confidence };
		this._edgeCount++;

		// Only accumulate in memory if NOT using progressive storage
		if (!this.storageCallbacks) {
			this.edges.push(edge);
		}

		this.pendingEdges.push(edge);

		if (this.pendingEdges.length >= this.batchSize) {
			this.flushPendingEdges();
		}
	}

	private async flushPendingNodes(): Promise<void> {
		if (this.pendingNodes.length === 0) return;

		const batch = this.pendingNodes;
		this.pendingNodes = [];

		// Store to DB if progressive mode
		if (this.storageCallbacks) {
			await this.storageCallbacks.storeNodes(batch);
		}

		await this.batchCallbacks.onNodeBatch?.(batch, this.nodeBatchIndex);
		this.nodeBatchIndex++;
	}

	private async flushPendingEdges(): Promise<void> {
		if (this.pendingEdges.length === 0) return;

		const batch = this.pendingEdges;
		this.pendingEdges = [];

		// Store to DB if progressive mode
		if (this.storageCallbacks) {
			await this.storageCallbacks.storeEdges(batch);
		}

		await this.batchCallbacks.onEdgeBatch?.(batch, this.edgeBatchIndex);
		this.edgeBatchIndex++;
	}

	private ensureCrateNode(crateName: string, visibility: Visibility, isExternal: boolean): void {
		if (this.nodeIndex.has(crateName)) return;

		this.addNode({
			id: crateName,
			name: crateName,
			kind: 'Crate',
			visibility,
			attrs: [],
			is_external: isExternal || undefined,
		});
	}

	private ensureModuleNodes(crateName: string, path: string[], isExternal: boolean): void {
		if (path.length <= 1) return;

		let parentId = crateName;
		for (let i = 0; i < path.length - 1; i++) {
			const moduleId = this.joinPath(crateName, path.slice(0, i + 1));
			if (!this.nodeIndex.has(moduleId)) {
				this.addNode({
					id: moduleId,
					name: path[i],
					kind: 'Module',
					visibility: 'Unknown',
					attrs: [],
					is_external: isExternal || undefined,
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
		return this.pathIndex.get(id) ?? null;
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

	private mapItemKind(kind: string): NodeKind | null {
		switch (kind) {
			case 'module':
				return 'Module';
			case 'struct':
				return 'Struct';
			case 'struct_field':
				return 'StructField';
			case 'union':
				return 'Union';
			case 'enum':
				return 'Enum';
			case 'variant':
				return 'Variant';
			case 'trait':
				return 'Trait';
			case 'trait_alias':
				return 'TraitAlias';
			case 'impl':
				return 'Impl';
			case 'function':
				return 'Function';
			case 'type_alias':
				return 'TypeAlias';
			case 'assoc_type':
				return 'AssocType';
			case 'constant':
				return 'Constant';
			case 'assoc_const':
				return 'AssocConst';
			case 'static':
				return 'Static';
			case 'macro':
				return 'Macro';
			case 'primitive':
				return 'Primitive';
			case 'extern_crate':
				return 'ExternCrate';
			case 'import':
				return 'Import';
			case 'proc_attribute':
				return 'ProcMacro';
			case 'proc_derive':
				return 'ProcMacro';
			default:
				return null;
		}
	}

	private mapVisibility(vis: RdtVisibility): Visibility {
		if (typeof vis === 'string') {
			switch (vis) {
				case 'public':
					return 'Public';
				case 'crate':
					return 'Crate';
				case 'default':
					return 'Inherited';
				default:
					return 'Unknown';
			}
		}
		if (vis && typeof vis === 'object' && 'restricted' in vis) return 'Restricted';
		return 'Unknown';
	}

	private mapSpan(span: {
		filename: string;
		begin: [number, number];
		end: [number, number];
	}): Span {
		return {
			file: span.filename,
			line: span.begin[0],
			column: span.begin[1],
			end_line: span.end[0],
			end_column: span.end[1],
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
				if ('trait_bound' in b)
					return b.trait_bound?.trait?.path ? this.cleanPath(b.trait_bound.trait.path) : null;
				if ('outlives' in b) return b.outlives;
				return null;
			})
			.filter((s): s is string => s !== null);
	}

	private formatGenericBound(bound: unknown): string {
		if (!bound || typeof bound !== 'object') return String(bound);
		const b = bound as GenericBound;
		if ('trait_bound' in b && b.trait_bound?.trait?.path) {
			return this.cleanPath(b.trait_bound.trait.path);
		}
		if ('outlives' in b) return b.outlives as string;
		return '_';
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

	private implForTypeName(ty: Type): string {
		const name = this.formatType(ty).trim();
		if (!name || name === '_') return 'type';
		return name;
	}

	private implNodeName(typeName: string, traitName: string | null): string {
		if (traitName) return `impl ${traitName} for ${typeName}`;
		return `impl ${typeName}`;
	}

	// ---------------------------------------------------------------------------
	// Item metadata enrichment
	// ---------------------------------------------------------------------------

	private applyItemMetadata(itemId: Id, item: Item): boolean {
		const nodeId = this.pathIndex.get(itemId);
		if (!nodeId) return false;
		const node = this.nodeIndex.get(nodeId);
		if (!node) return false;

		let changed = false;
		const nextVisibility = this.mapVisibility(item.visibility);
		if (node.visibility !== nextVisibility) {
			node.visibility = nextVisibility;
			changed = true;
		}
		const nextSpan = item.span ? this.mapSpan(item.span) : null;
		if (JSON.stringify(node.span ?? null) !== JSON.stringify(nextSpan)) {
			node.span = nextSpan;
			changed = true;
		}
		const nextAttrs = this.formatAttributes(item.attrs);
		if (!this.arrayShallowEqual(node.attrs ?? [], nextAttrs)) {
			node.attrs = nextAttrs;
			changed = true;
		}
		const nextDocs = item.docs ?? null;
		if ((node.docs ?? null) !== nextDocs) {
			node.docs = nextDocs;
			changed = true;
		}

		const nextDocLinks: Record<string, string> = {};
		for (const [label, targetId] of Object.entries(item.links ?? {})) {
			const resolved = this.resolveId(targetId);
			if (resolved) nextDocLinks[label] = resolved;
		}
		if (!this.recordShallowEqual(node.doc_links ?? {}, nextDocLinks)) {
			node.doc_links = Object.keys(nextDocLinks).length > 0 ? nextDocLinks : undefined;
			changed = true;
		}

		const inner = item.inner;
		if ('function' in inner) {
			const sig = inner.function.sig;
			const header = inner.function.header;
			const nextSig: FunctionSignatureOut = {
				inputs: sig.inputs.map(([name, ty]) => ({ name, type_name: this.formatType(ty) })),
				output: sig.output ? this.formatType(sig.output) : null,
				is_async: header.is_async,
				is_unsafe: header.is_unsafe,
				is_const: header.is_const,
			};
			if (JSON.stringify(node.signature ?? null) !== JSON.stringify(nextSig)) {
				node.signature = nextSig;
				changed = true;
			}
			const nextGenerics = this.extractGenerics(inner.function.generics);
			if (!this.arrayShallowEqual(node.generics ?? null, nextGenerics)) {
				node.generics = nextGenerics;
				changed = true;
			}
			const nextWhere = this.extractWhereClause(inner.function.generics);
			if (!this.arrayShallowEqual(node.where_clause ?? null, nextWhere)) {
				node.where_clause = nextWhere;
				changed = true;
			}
		} else if ('struct' in inner) {
			const nextGenerics = this.extractGenerics(inner.struct.generics);
			const nextWhere = this.extractWhereClause(inner.struct.generics);
			if (!this.arrayShallowEqual(node.generics ?? null, nextGenerics)) {
				node.generics = nextGenerics;
				changed = true;
			}
			if (!this.arrayShallowEqual(node.where_clause ?? null, nextWhere)) {
				node.where_clause = nextWhere;
				changed = true;
			}
			const nextFields = this.extractStructFields(inner.struct.kind);
			if (
				!this.arrayShallowEqual(
					node.fields ?? null,
					nextFields,
					(a, b) =>
						a.name === b.name && a.type_name === b.type_name && a.visibility === b.visibility,
				)
			) {
				node.fields = nextFields;
				changed = true;
			}
		} else if ('union' in inner) {
			const nextGenerics = this.extractGenerics(inner.union.generics);
			const nextWhere = this.extractWhereClause(inner.union.generics);
			if (!this.arrayShallowEqual(node.generics ?? null, nextGenerics)) {
				node.generics = nextGenerics;
				changed = true;
			}
			if (!this.arrayShallowEqual(node.where_clause ?? null, nextWhere)) {
				node.where_clause = nextWhere;
				changed = true;
			}
			const nextFields = this.extractFieldList(inner.union.fields);
			if (
				!this.arrayShallowEqual(
					node.fields ?? null,
					nextFields,
					(a, b) =>
						a.name === b.name && a.type_name === b.type_name && a.visibility === b.visibility,
				)
			) {
				node.fields = nextFields;
				changed = true;
			}
		} else if ('enum' in inner) {
			const nextGenerics = this.extractGenerics(inner.enum.generics);
			const nextWhere = this.extractWhereClause(inner.enum.generics);
			if (!this.arrayShallowEqual(node.generics ?? null, nextGenerics)) {
				node.generics = nextGenerics;
				changed = true;
			}
			if (!this.arrayShallowEqual(node.where_clause ?? null, nextWhere)) {
				node.where_clause = nextWhere;
				changed = true;
			}
			const nextVariants = this.extractVariants(inner.enum.variants);
			if (
				!this.arrayShallowEqual(
					node.variants ?? null,
					nextVariants,
					(a, b) =>
						a.name === b.name &&
						this.arrayShallowEqual(
							a.fields,
							b.fields,
							(x, y) =>
								x.name === y.name && x.type_name === y.type_name && x.visibility === y.visibility,
						),
				)
			) {
				node.variants = nextVariants;
				changed = true;
			}
		}

		if (changed) this.updatedNodes.add(node.id);
		return true;
	}

	private applyDeferredMetadata(itemId: Id, metadata: DeferredNodeMetadata): boolean {
		const nodeId = this.pathIndex.get(itemId);
		if (!nodeId) return false;
		const node = this.nodeIndex.get(nodeId);
		if (!node) return false;

		let changed = false;
		if (node.visibility !== metadata.visibility) {
			node.visibility = metadata.visibility;
			changed = true;
		}
		if (JSON.stringify(node.span ?? null) !== JSON.stringify(metadata.span)) {
			node.span = metadata.span;
			changed = true;
		}
		if (!this.arrayShallowEqual(node.attrs ?? [], metadata.attrs)) {
			node.attrs = metadata.attrs;
			changed = true;
		}
		if ((node.docs ?? null) !== metadata.docs) {
			node.docs = metadata.docs;
			changed = true;
		}

		const nextDocLinks: Record<string, string> = {};
		for (const [label, targetId] of Object.entries(metadata.links)) {
			const resolved = this.resolveId(targetId);
			if (resolved) nextDocLinks[label] = resolved;
		}
		if (!this.recordShallowEqual(node.doc_links ?? {}, nextDocLinks)) {
			node.doc_links = Object.keys(nextDocLinks).length > 0 ? nextDocLinks : undefined;
			changed = true;
		}

		const kindMeta = metadata.kindMeta;
		if (kindMeta.kind === 'function') {
			if (JSON.stringify(node.signature ?? null) !== JSON.stringify(kindMeta.signature)) {
				node.signature = kindMeta.signature;
				changed = true;
			}
			if (!this.arrayShallowEqual(node.generics ?? null, kindMeta.generics)) {
				node.generics = kindMeta.generics;
				changed = true;
			}
			if (!this.arrayShallowEqual(node.where_clause ?? null, kindMeta.whereClause)) {
				node.where_clause = kindMeta.whereClause;
				changed = true;
			}
		} else if (kindMeta.kind === 'struct') {
			if (!this.arrayShallowEqual(node.generics ?? null, kindMeta.generics)) {
				node.generics = kindMeta.generics;
				changed = true;
			}
			if (!this.arrayShallowEqual(node.where_clause ?? null, kindMeta.whereClause)) {
				node.where_clause = kindMeta.whereClause;
				changed = true;
			}
			const nextFields = this.extractStructFields(kindMeta.structKind);
			if (
				!this.arrayShallowEqual(
					node.fields ?? null,
					nextFields,
					(a, b) =>
						a.name === b.name && a.type_name === b.type_name && a.visibility === b.visibility,
				)
			) {
				node.fields = nextFields;
				changed = true;
			}
		} else if (kindMeta.kind === 'union') {
			if (!this.arrayShallowEqual(node.generics ?? null, kindMeta.generics)) {
				node.generics = kindMeta.generics;
				changed = true;
			}
			if (!this.arrayShallowEqual(node.where_clause ?? null, kindMeta.whereClause)) {
				node.where_clause = kindMeta.whereClause;
				changed = true;
			}
			const nextFields = this.extractFieldList(kindMeta.fieldIds);
			if (
				!this.arrayShallowEqual(
					node.fields ?? null,
					nextFields,
					(a, b) =>
						a.name === b.name && a.type_name === b.type_name && a.visibility === b.visibility,
				)
			) {
				node.fields = nextFields;
				changed = true;
			}
		} else if (kindMeta.kind === 'enum') {
			if (!this.arrayShallowEqual(node.generics ?? null, kindMeta.generics)) {
				node.generics = kindMeta.generics;
				changed = true;
			}
			if (!this.arrayShallowEqual(node.where_clause ?? null, kindMeta.whereClause)) {
				node.where_clause = kindMeta.whereClause;
				changed = true;
			}
			const nextVariants = this.extractVariants(kindMeta.variantIds);
			if (
				!this.arrayShallowEqual(
					node.variants ?? null,
					nextVariants,
					(a, b) =>
						a.name === b.name &&
						this.arrayShallowEqual(
							a.fields,
							b.fields,
							(x, y) =>
								x.name === y.name && x.type_name === y.type_name && x.visibility === y.visibility,
						),
				)
			) {
				node.variants = nextVariants;
				changed = true;
			}
		}

		if (changed) this.updatedNodes.add(node.id);
		return true;
	}

	private shouldRetainReferencedItem(item: Item): boolean {
		const inner = item.inner;
		return 'variant' in inner || 'struct_field' in inner;
	}

	private shouldDeferNodeMetadata(inner: ItemEnum): boolean {
		return (
			'module' in inner ||
			'extern_crate' in inner ||
			'use' in inner ||
			'struct' in inner ||
			'union' in inner ||
			'enum' in inner ||
			'function' in inner ||
			'trait' in inner ||
			'trait_alias' in inner ||
			'type_alias' in inner ||
			'constant' in inner ||
			'static' in inner ||
			'macro' in inner ||
			'proc_macro' in inner ||
			'primitive' in inner ||
			'assoc_const' in inner ||
			'assoc_type' in inner
		);
	}

	private toDeferredNodeMetadata(item: Item): DeferredNodeMetadata {
		const inner = item.inner;
		const visibility = this.mapVisibility(item.visibility);
		const span = item.span ? this.mapSpan(item.span) : null;
		const attrs = this.formatAttributes(item.attrs);
		const docs = item.docs ?? null;
		const links = item.links ?? {};

		if ('function' in inner) {
			const sig = inner.function.sig;
			const header = inner.function.header;
			return {
				visibility,
				span,
				attrs,
				docs,
				links,
				kindMeta: {
					kind: 'function',
					signature: {
						inputs: sig.inputs.map(([name, ty]) => ({ name, type_name: this.formatType(ty) })),
						output: sig.output ? this.formatType(sig.output) : null,
						is_async: header.is_async,
						is_unsafe: header.is_unsafe,
						is_const: header.is_const,
					},
					generics: this.extractGenerics(inner.function.generics),
					whereClause: this.extractWhereClause(inner.function.generics),
				},
			};
		}

		if ('struct' in inner) {
			return {
				visibility,
				span,
				attrs,
				docs,
				links,
				kindMeta: {
					kind: 'struct',
					generics: this.extractGenerics(inner.struct.generics),
					whereClause: this.extractWhereClause(inner.struct.generics),
					structKind: inner.struct.kind,
				},
			};
		}

		if ('union' in inner) {
			return {
				visibility,
				span,
				attrs,
				docs,
				links,
				kindMeta: {
					kind: 'union',
					generics: this.extractGenerics(inner.union.generics),
					whereClause: this.extractWhereClause(inner.union.generics),
					fieldIds: inner.union.fields,
				},
			};
		}

		if ('enum' in inner) {
			return {
				visibility,
				span,
				attrs,
				docs,
				links,
				kindMeta: {
					kind: 'enum',
					generics: this.extractGenerics(inner.enum.generics),
					whereClause: this.extractWhereClause(inner.enum.generics),
					variantIds: inner.enum.variants,
				},
			};
		}

		return {
			visibility,
			span,
			attrs,
			docs,
			links,
			kindMeta: { kind: 'none' },
		};
	}

	private extractStructFields(kind: StructKind): FieldInfo[] | null {
		if (kind === 'unit') return null;
		if ('plain' in kind) return this.extractFieldList(kind.plain.fields);
		if ('tuple' in kind) {
			const fields: FieldInfo[] = [];
			for (let i = 0; i < kind.tuple.length; i++) {
				const id = kind.tuple[i];
				if (id == null) continue;
				const field = this.extractField(id, `${i}`);
				if (field) fields.push(field);
			}
			return fields.length > 0 ? fields : null;
		}
		return null;
	}

	private extractFieldList(ids: Id[]): FieldInfo[] | null {
		const fields: FieldInfo[] = [];
		for (let i = 0; i < ids.length; i++) {
			const field = this.extractField(ids[i], `field${i}`);
			if (field) fields.push(field);
		}
		return fields.length > 0 ? fields : null;
	}

	private extractField(id: Id, fallbackName: string): FieldInfo | null {
		const item = this.itemIndex.get(id);
		if (!item) return null;
		const inner = item.inner;
		if (!('struct_field' in inner)) return null;
		return {
			name: item.name ?? fallbackName,
			type_name: this.formatType(inner.struct_field),
			visibility: this.mapVisibility(item.visibility),
		};
	}

	private extractVariants(ids: Id[]): VariantInfo[] | null {
		const variants: VariantInfo[] = [];
		for (const id of ids) {
			const item = this.itemIndex.get(id);
			if (!item || !('variant' in item.inner)) continue;
			const variant = item.inner.variant;
			const fields: FieldInfo[] = [];
			const kind = variant.kind;
			if (typeof kind === 'object' && kind !== null && 'tuple' in kind) {
				for (let i = 0; i < kind.tuple.length; i++) {
					const fieldId = kind.tuple[i];
					if (fieldId == null) continue;
					const field = this.extractField(fieldId, `${i}`);
					if (field) fields.push(field);
				}
			} else if (typeof kind === 'object' && kind !== null && 'struct' in kind) {
				const extracted = this.extractFieldList(kind.struct.fields);
				if (extracted) fields.push(...extracted);
			}
			variants.push({
				name: item.name ?? `Variant${id}`,
				fields,
			});
		}
		return variants.length > 0 ? variants : null;
	}

	private arrayShallowEqual<T>(
		a: T[] | null,
		b: T[] | null,
		equals: (x: T, y: T) => boolean = (x, y) => x === y,
	): boolean {
		if (a === b) return true;
		if (!a || !b) return false;
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (!equals(a[i], b[i])) return false;
		}
		return true;
	}

	private recordShallowEqual(a: Record<string, string>, b: Record<string, string>): boolean {
		const aKeys = Object.keys(a);
		const bKeys = Object.keys(b);
		if (aKeys.length !== bKeys.length) return false;
		for (const key of aKeys) {
			if (a[key] !== b[key]) return false;
		}
		return true;
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
				case 'non_exhaustive':
					return '#[non_exhaustive]';
				case 'automatically_derived':
					return '#[automatically_derived]';
				case 'macro_export':
					return '#[macro_export]';
				case 'no_mangle':
					return '#[no_mangle]';
				default:
					return attr;
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
 * @param options - Build options including batch callbacks and progressive storage
 * @returns The builder instance (call createParseCallbacks() to get callbacks for parser)
 */
export function createStreamingGraphBuilder(
	crateName: string,
	options?: {
		batchSize?: number;
		skipExternalNodes?: boolean;
		retainItemIndex?: boolean;
		dedupeEdgesInMemory?: boolean;
		batchCallbacks?: BatchCallbacks;
		/** Progressive storage callbacks - when set, nodes/edges stored directly to DB */
		storageCallbacks?: ProgressiveStorageCallbacks;
	},
): StreamingGraphBuilder {
	return new StreamingGraphBuilder(crateName, options);
}
