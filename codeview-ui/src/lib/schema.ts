import * as v from 'valibot';
import type {
	ArgumentInfo,
	AssocItemConstraint,
	Confidence,
	CrateGraph,
	Deprecation,
	Edge,
	EdgeKind,
	ExternalCrate,
	FieldInfo,
	FunctionPointerSig,
	FunctionSignature,
	GenericArg,
	GenericArgs,
	GenericBound,
	GenericParam,
	Generics,
	ImplCategory,
	ImplType,
	Node,
	NodeKind,
	PolyTrait,
	ProvidedDefaultUnstable,
	Span,
	StabilityInfo,
	Term,
	TypeRef,
	VariantInfo,
	VariantKind,
	Visibility,
	WherePredicate,
	Workspace,
} from './generated/codeview-schema';

/** Current graph schema version supported by this UI */
/**
 * Current graph schema version (mirrors `codeview-core::SCHEMA_VERSION`).
 *
 * **Pinned at 1 pre-release.** See the Rust constant's doc-comment for
 * the full rationale — during pre-release iteration `parserRevision`
 * (git SHA) carries the drift signal so this constant only bumps for
 * artifact-shape changes the worker has to adapt to.
 */
export const SCHEMA_VERSION = 1;

// --- Enums ---

export const NodeKindSchema = v.picklist([
	'Crate',
	'Module',
	'Struct',
	'StructField',
	'Union',
	'Enum',
	'Variant',
	'Trait',
	'TraitAlias',
	'Impl',
	'Function',
	'TypeAlias',
	'AssocType',
	'Constant',
	'AssocConst',
	'Static',
	'Macro',
	'Primitive',
	'ExternCrate',
	'Import',
	'ProcMacro',
]);

export const ImplTypeSchema = v.picklist(['Trait', 'Inherent']);

export const ImplCategorySchema = v.picklist([
	'Inherent',
	'Trait',
	'Blanket',
	'Negative',
	'Synthetic',
]);

/**
 * Visibility is a tagged union — the `Restricted` variant carries the
 * optional restriction `path` (e.g. `crate::foo::bar`).
 * Other variants are tag-only objects: `{ kind: 'Public' }` etc.
 *
 * Use the discriminated `v.variant` so each branch validates its own
 * shape and the inferred TS type lines up with the generated
 * `Visibility` from codeview-schema.d.ts (verified by the
 * `_VisibilitySchemaMatchesGenerated` Assert below).
 */
export const VisibilitySchema = v.variant('kind', [
	v.object({ kind: v.literal('Public') }),
	v.object({ kind: v.literal('Crate') }),
	v.object({ kind: v.literal('Restricted'), path: v.string() }),
	v.object({ kind: v.literal('Inherited') }),
	v.object({ kind: v.literal('Unknown') }),
]);

export const EdgeKindSchema = v.picklist([
	'Contains',
	'Defines',
	'Implements',
	'UsesType',
	'CallsStatic',
	'CallsRuntime',
	'Derives',
	'ReExports',
]);

export const ConfidenceSchema = v.picklist(['Static', 'Runtime', 'Inferred']);

// --- Nested structures ---

export const SpanSchema = v.object({
	file: v.string(),
	line: v.number(),
	column: v.number(),
	end_line: v.optional(v.nullable(v.number())),
	end_column: v.optional(v.nullable(v.number())),
});

// ─── Type AST (recursive) ────────────────────────────────────────────
//
// Mirrors codeview-core::TypeRef + Generics + GenericBound + …
// All tagged unions use `kind` discriminator. Recursion is fed through
// `v.lazy()` so the runtime resolves the back-references at first use.

const TraitBoundModifierSchema = v.picklist(['none', 'maybe', 'maybe_const']);

const PreciseCaptureSchema = v.variant('kind', [
	v.object({ kind: v.literal('Lifetime'), name: v.string() }),
	v.object({ kind: v.literal('Param'), name: v.string() }),
]);

export const TypeRefSchema: v.GenericSchema<TypeRef> = v.lazy(() =>
	v.variant('kind', [
		v.object({
			kind: v.literal('ResolvedPath'),
			id: v.string(),
			path: v.string(),
			args: v.optional(v.nullable(GenericArgsSchema)),
		}),
		v.object({
			kind: v.literal('DynTrait'),
			traits: v.array(PolyTraitSchema),
			lifetime: v.optional(v.nullable(v.string())),
		}),
		v.object({ kind: v.literal('Generic'), name: v.string() }),
		v.object({ kind: v.literal('Primitive'), name: v.string() }),
		v.object({
			kind: v.literal('BorrowedRef'),
			lifetime: v.optional(v.nullable(v.string())),
			mutable: v.boolean(),
			inner: TypeRefSchema,
		}),
		v.object({ kind: v.literal('Tuple'), elements: v.array(TypeRefSchema) }),
		v.object({ kind: v.literal('Slice'), element: TypeRefSchema }),
		v.object({ kind: v.literal('Array'), element: TypeRefSchema, len: v.string() }),
		v.object({
			kind: v.literal('ImplTrait'),
			bounds: v.array(GenericBoundSchema),
		}),
		v.object({
			kind: v.literal('RawPointer'),
			mutable: v.boolean(),
			inner: TypeRefSchema,
		}),
		v.object({
			kind: v.literal('QualifiedPath'),
			name: v.string(),
			args: v.optional(v.nullable(GenericArgsSchema)),
			self_type: TypeRefSchema,
			trait: v.optional(v.nullable(TypeRefSchema)),
		}),
		v.object({
			kind: v.literal('FunctionPointer'),
			sig: FunctionPointerSigSchema,
		}),
		v.object({ kind: v.literal('Infer') }),
		v.object({ kind: v.literal('Pat'), base: TypeRefSchema, pat: v.string() }),
	]),
);

const GenericArgsSchema: v.GenericSchema<GenericArgs> = v.lazy(() =>
	v.variant('kind', [
		v.object({
			kind: v.literal('AngleBracketed'),
			args: v.array(GenericArgSchema),
			constraints: v.optional(v.array(AssocItemConstraintSchema)),
		}),
		v.object({
			kind: v.literal('Parenthesized'),
			inputs: v.array(TypeRefSchema),
			output: v.optional(v.nullable(TypeRefSchema)),
		}),
		v.object({ kind: v.literal('ReturnTypeNotation') }),
	]),
);

const GenericArgSchema: v.GenericSchema<GenericArg> = v.lazy(() =>
	v.variant('kind', [
		v.object({ kind: v.literal('Lifetime'), name: v.string() }),
		v.object({ kind: v.literal('Type'), value: TypeRefSchema }),
		v.object({
			kind: v.literal('Const'),
			expr: v.string(),
			is_literal: v.boolean(),
		}),
		v.object({ kind: v.literal('Infer') }),
	]),
);

const TermSchema: v.GenericSchema<Term> = v.lazy(() =>
	v.variant('kind', [
		v.object({ kind: v.literal('Type'), value: TypeRefSchema }),
		v.object({
			kind: v.literal('Const'),
			expr: v.string(),
			is_literal: v.boolean(),
		}),
	]),
);

const AssocItemConstraintSchema: v.GenericSchema<AssocItemConstraint> = v.lazy(() =>
	v.object({
		name: v.string(),
		args: v.optional(v.nullable(GenericArgsSchema)),
		binding: v.variant('kind', [
			v.object({ kind: v.literal('Equality'), value: TermSchema }),
			v.object({
				kind: v.literal('Constraint'),
				bounds: v.array(GenericBoundSchema),
			}),
		]),
	}),
);

const PolyTraitSchema: v.GenericSchema<PolyTrait> = v.lazy(() =>
	v.object({
		trait: TypeRefSchema,
		hrtb_params: v.optional(v.array(GenericParamSchema)),
	}),
);

const FunctionPointerSigSchema: v.GenericSchema<FunctionPointerSig> = v.lazy(() =>
	v.object({
		inputs: v.array(
			v.object({ name: v.string(), type: TypeRefSchema }),
		),
		output: v.optional(v.nullable(TypeRefSchema)),
		is_unsafe: v.boolean(),
		is_const: v.boolean(),
		is_async: v.boolean(),
		abi: v.optional(v.nullable(v.string())),
		is_c_variadic: v.boolean(),
		hrtb_params: v.optional(v.array(GenericParamSchema)),
	}),
);

const GenericBoundSchema: v.GenericSchema<GenericBound> = v.lazy(() =>
	v.variant('kind', [
		v.object({
			kind: v.literal('Trait'),
			trait: TypeRefSchema,
			modifier: TraitBoundModifierSchema,
			hrtb_params: v.optional(v.array(GenericParamSchema)),
		}),
		v.object({ kind: v.literal('Outlives'), lifetime: v.string() }),
		v.object({
			kind: v.literal('Use'),
			captures: v.array(PreciseCaptureSchema),
		}),
	]),
);

const GenericParamSchema: v.GenericSchema<GenericParam> = v.lazy(() =>
	v.object({
		name: v.string(),
		kind: v.variant('kind', [
			v.object({
				kind: v.literal('Lifetime'),
				outlives: v.optional(v.array(v.string())),
			}),
			v.object({
				kind: v.literal('Type'),
				bounds: v.optional(v.array(GenericBoundSchema)),
				default: v.optional(v.nullable(TypeRefSchema)),
				synthetic: v.optional(v.boolean()),
			}),
			v.object({
				kind: v.literal('Const'),
				type: TypeRefSchema,
				default: v.optional(v.nullable(v.string())),
			}),
		]),
	}),
);

const WherePredicateSchema: v.GenericSchema<WherePredicate> = v.lazy(() =>
	v.variant('kind', [
		v.object({
			kind: v.literal('Bound'),
			type: TypeRefSchema,
			bounds: v.array(GenericBoundSchema),
			hrtb_params: v.optional(v.array(GenericParamSchema)),
		}),
		v.object({
			kind: v.literal('Lifetime'),
			lifetime: v.string(),
			outlives: v.array(v.string()),
		}),
		v.object({
			kind: v.literal('Eq'),
			lhs: TypeRefSchema,
			rhs: TermSchema,
		}),
	]),
);

export const GenericsSchema = v.object({
	params: v.optional(v.array(GenericParamSchema)),
	where_predicates: v.optional(v.array(WherePredicateSchema)),
});

export const FieldInfoSchema = v.object({
	name: v.string(),
	type: TypeRefSchema,
	visibility: VisibilitySchema,
});

export const VariantInfoSchema = v.object({
	name: v.string(),
	fields: v.array(FieldInfoSchema),
});

export const ArgumentInfoSchema = v.object({
	name: v.string(),
	type: TypeRefSchema,
});

export const FunctionSignatureSchema = v.object({
	inputs: v.array(ArgumentInfoSchema),
	output: v.optional(v.nullable(TypeRefSchema)),
	is_async: v.boolean(),
	is_unsafe: v.boolean(),
	is_const: v.boolean(),
	abi: v.optional(v.nullable(v.string())),
	is_c_variadic: v.optional(v.boolean()),
	generics: v.optional(GenericsSchema),
});

export const DeprecationSchema = v.object({
	since: v.optional(v.nullable(v.string())),
	note: v.optional(v.nullable(v.string())),
});

export const StabilityInfoSchema = v.intersect([
	v.object({
		feature: v.string(),
	}),
	v.variant('level', [
		v.object({
			level: v.literal('stable'),
			since: v.optional(v.nullable(v.string())),
		}),
		v.object({
			level: v.literal('unstable'),
		}),
	]),
]);

export const ProvidedDefaultUnstableSchema = v.object({
	feature: v.string(),
});

// --- Node & Edge ---

export const NodeSchema = v.object({
	id: v.string(),
	name: v.string(),
	kind: NodeKindSchema,
	visibility: VisibilitySchema,
	span: v.optional(v.nullable(SpanSchema)),
	line_count: v.optional(v.nullable(v.number())),
	attrs: v.array(v.string()),
	is_external: v.optional(v.boolean()),
	is_deprecated: v.optional(v.boolean()),
	is_unsafe: v.optional(v.boolean()),
	is_auto: v.optional(v.boolean()),
	is_mutable: v.optional(v.boolean()),
	is_stripped: v.optional(v.boolean()),
	has_stripped_fields: v.optional(v.boolean()),
	has_stripped_variants: v.optional(v.boolean()),
	is_dyn_compatible: v.optional(v.nullable(v.boolean())),
	deprecation: v.optional(v.nullable(DeprecationSchema)),
	stability: v.optional(v.nullable(StabilityInfoSchema)),
	const_stability: v.optional(v.nullable(StabilityInfoSchema)),
	default_unstable: v.optional(v.nullable(ProvidedDefaultUnstableSchema)),
	fields: v.optional(v.nullable(v.array(FieldInfoSchema))),
	variants: v.optional(v.nullable(v.array(VariantInfoSchema))),
	signature: v.optional(v.nullable(FunctionSignatureSchema)),
	// Structured generics (params + where-clause).
	generics: v.optional(GenericsSchema),
	docs: v.optional(v.nullable(v.string())),
	doc_links: v.optional(v.record(v.string(), v.string())),
	impl_type: v.optional(v.nullable(ImplTypeSchema)),
	impl_category: v.optional(v.nullable(ImplCategorySchema)),
	parent_impl: v.optional(v.nullable(v.string())),
	impl_trait: v.optional(v.nullable(v.string())),
	provided_trait_methods: v.optional(v.nullable(v.array(v.string()))),
	required_trait_methods: v.optional(v.nullable(v.array(v.string()))),
	default_trait_methods: v.optional(v.nullable(v.array(v.string()))),
	// StructField / AssocType / AssocConst / Constant / Static / TypeAlias: the type
	type: v.optional(v.nullable(TypeRefSchema)),
	// Variant: unit, tuple, or struct
	variant_kind: v.optional(v.nullable(v.picklist(['unit', 'tuple', 'struct']))),
	// Variant: discriminant value if specified
	discriminant: v.optional(v.nullable(v.string())),
	// AssocConst: the constant's value expression
	const_value: v.optional(v.nullable(v.string())),
	// Trait / TraitAlias / AssocType bounds (structured)
	bounds: v.optional(v.array(GenericBoundSchema)),
	// Import / extern crate / macro metadata preserved from rustdoc JSON
	import_source: v.optional(v.nullable(v.string())),
	import_name: v.optional(v.nullable(v.string())),
	is_glob: v.optional(v.boolean()),
	extern_crate_name: v.optional(v.nullable(v.string())),
	extern_crate_rename: v.optional(v.nullable(v.string())),
	macro_source: v.optional(v.nullable(v.string())),
	proc_macro_kind: v.optional(v.nullable(v.string())),
	proc_macro_helpers: v.optional(v.array(v.string())),
});

export const EdgeSchema = v.object({
	from: v.string(),
	to: v.string(),
	kind: EdgeKindSchema,
	confidence: ConfidenceSchema,
	occurrences: v.optional(v.array(SpanSchema)),
	is_glob: v.optional(v.boolean()),
});

// --- Per-crate graph ---

export const CrateGraphSchema = v.object({
	id: v.string(),
	name: v.string(),
	version: v.string(),
	nodes: v.array(NodeSchema),
	edges: v.array(EdgeSchema),
	// public_path → canonical_node_id; skipped in JSON when empty (matches
	// `#[serde(skip_serializing_if = "HashMap::is_empty")]` on the Rust side).
	aliases: v.optional(v.record(v.string(), v.string())),
});

export const ExternalCrateSchema = v.object({
	id: v.string(),
	name: v.string(),
	version: v.optional(v.nullable(v.string())),
	nodes: v.array(NodeSchema),
});

// --- Top-level Workspace ---

export const WorkspaceSchema = v.object({
	version: v.optional(v.number()),
	crates: v.array(CrateGraphSchema),
	external_crates: v.array(ExternalCrateSchema),
	cross_crate_edges: v.array(EdgeSchema),
	repo: v.optional(v.nullable(v.string())),
	ref: v.optional(v.nullable(v.string())),
});

// --- Response schemas ---

/** Lightweight node summary for tree/list display */
export const NodeSummarySchema = v.object({
	id: v.string(),
	name: v.string(),
	kind: NodeKindSchema,
	visibility: VisibilitySchema,
	is_external: v.optional(v.boolean()),
	is_deprecated: v.optional(v.boolean()),
	// Impl-specific fields (only populated for Impl nodes)
	impl_trait: v.optional(v.nullable(v.string())),
	impl_category: v.optional(v.nullable(ImplCategorySchema)),
	generics: v.optional(GenericsSchema),
});

/** getCrates response item */
export const CrateSummarySchema = v.object({
	id: v.string(),
	name: v.string(),
	version: v.string(),
});

/** Lightweight crate index entry (for hosted pseudo-workspace) */
export const CrateIndexEntrySchema = v.object({
	id: v.string(),
	name: v.string(),
	version: v.string(),
	is_external: v.optional(v.boolean()),
});

/** Per-crate hosted index response */
export const CrateIndexSchema = v.object({
	name: v.string(),
	version: v.string(),
	crates: v.array(CrateIndexEntrySchema),
});

/** getCrateTree response */
export const CrateTreeSchema = v.object({
	nodes: v.array(NodeSummarySchema),
	edges: v.array(EdgeSchema),
});

/** getNodeDetail response */
export const NodeDetailSchema = v.object({
	node: NodeSchema,
	edges: v.array(EdgeSchema),
	relatedNodes: v.array(NodeSchema),
});

export const SelectedEdgesSchema = v.object({
	incoming: v.array(EdgeSchema),
	outgoing: v.array(EdgeSchema),
});

export const DetailMethodGroupSchema = v.object({
	implId: v.string(),
	methodIds: v.array(v.string()),
});

export const TocEntrySchema = v.object({
	anchor: v.string(),
	title: v.string(),
	count: v.nullable(v.number()),
});

export const WhereUsedRefSchema = v.object({
	id: v.string(),
	name: v.string(),
});

export const DetailDocModelSchema = v.object({
	selectedEdges: SelectedEdgesSchema,
	filteredEdges: SelectedEdgesSchema,
	relatedNodeIds: v.array(v.string()),
	implBlockIds: v.array(v.string()),
	sourceImplIds: v.array(v.string()),
	blanketImplIds: v.array(v.string()),
	methodGroups: v.array(DetailMethodGroupSchema),
	traitImplGroups: v.optional(v.array(DetailMethodGroupSchema)),
	methodCount: v.number(),
	totalImpls: v.number(),
	tocEntries: v.array(TocEntrySchema),
	whereUsed: v.array(WhereUsedRefSchema),
});

export const DesignRelationSchema = v.picklist([
	'contains',
	'reexports',
	'defines',
	'implements',
	'uses',
	'calls',
	'calls-runtime',
	'derives',
]);

export const RelationshipGroupItemSchema = v.object({
	node: NodeSummarySchema,
	count: v.number(),
});

export const RelationshipGroupSchema = v.object({
	rel: DesignRelationSchema,
	label: v.string(),
	color: v.string(),
	items: v.array(RelationshipGroupItemSchema),
});

export const RelationshipGroupsSchema = v.object({
	incoming: v.array(RelationshipGroupSchema),
	outgoing: v.array(RelationshipGroupSchema),
});

/** getSource response */
export const SourceResultSchema = v.object({
	error: v.nullable(v.string()),
	content: v.nullable(v.string()),
	absolutePath: v.nullable(v.string()),
	repoUrl: v.nullable(v.string()),
});

// --- Crate status (for cloud multi-crate mode) ---

export const CrateStatusValueSchema = v.picklist(['unknown', 'processing', 'ready', 'failed']);

export const CrateStatusSchema = v.object({
	status: CrateStatusValueSchema,
	error: v.optional(v.string()),
	step: v.optional(v.string()),
	action: v.optional(v.picklist(['install_std_docs', 'docs_unavailable'])),
	installedVersion: v.optional(v.string()),
});

export const CrateSearchResultSchema = v.object({
	id: v.optional(v.string()),
	name: v.string(),
	version: v.string(),
	description: v.optional(v.string()),
});

// --- Types ---

type IsEqual<Actual, Expected> =
	(<T>() => T extends Actual ? 1 : 2) extends <T>() => T extends Expected ? 1 : 2
		? (<T>() => T extends Expected ? 1 : 2) extends <T>() => T extends Actual ? 1 : 2
			? true
			: false
		: false;
type Assert<T extends true> = T;

type _ConfidenceSchemaMatchesGenerated = Assert<
	IsEqual<v.InferOutput<typeof ConfidenceSchema>, Confidence>
>;
type _CrateGraphSchemaMatchesGenerated = Assert<
	IsEqual<v.InferOutput<typeof CrateGraphSchema>, CrateGraph>
>;
type _DeprecationSchemaMatchesGenerated = Assert<
	IsEqual<v.InferOutput<typeof DeprecationSchema>, Deprecation>
>;
type _EdgeKindSchemaMatchesGenerated = Assert<
	IsEqual<v.InferOutput<typeof EdgeKindSchema>, EdgeKind>
>;
type _EdgeSchemaMatchesGenerated = Assert<IsEqual<v.InferOutput<typeof EdgeSchema>, Edge>>;
type _ExternalCrateSchemaMatchesGenerated = Assert<
	IsEqual<v.InferOutput<typeof ExternalCrateSchema>, ExternalCrate>
>;
type _FieldInfoSchemaMatchesGenerated = Assert<
	IsEqual<v.InferOutput<typeof FieldInfoSchema>, FieldInfo>
>;
type _FunctionSignatureSchemaMatchesGenerated = Assert<
	IsEqual<v.InferOutput<typeof FunctionSignatureSchema>, FunctionSignature>
>;
type _ImplCategorySchemaMatchesGenerated = Assert<
	IsEqual<v.InferOutput<typeof ImplCategorySchema>, ImplCategory>
>;
type _ImplTypeSchemaMatchesGenerated = Assert<
	IsEqual<v.InferOutput<typeof ImplTypeSchema>, ImplType>
>;
type _NodeKindSchemaMatchesGenerated = Assert<
	IsEqual<v.InferOutput<typeof NodeKindSchema>, NodeKind>
>;
type _NodeSchemaMatchesGenerated = Assert<IsEqual<v.InferOutput<typeof NodeSchema>, Node>>;
type _ProvidedDefaultUnstableSchemaMatchesGenerated = Assert<
	IsEqual<v.InferOutput<typeof ProvidedDefaultUnstableSchema>, ProvidedDefaultUnstable>
>;
type _SpanSchemaMatchesGenerated = Assert<IsEqual<v.InferOutput<typeof SpanSchema>, Span>>;
type _StabilityInfoSchemaMatchesGenerated = Assert<
	IsEqual<v.InferOutput<typeof StabilityInfoSchema>, StabilityInfo>
>;
type _VariantInfoSchemaMatchesGenerated = Assert<
	IsEqual<v.InferOutput<typeof VariantInfoSchema>, VariantInfo>
>;
type _VisibilitySchemaMatchesGenerated = Assert<
	IsEqual<v.InferOutput<typeof VisibilitySchema>, Visibility>
>;
type _WorkspaceSchemaMatchesGenerated = Assert<
	IsEqual<v.InferOutput<typeof WorkspaceSchema>, Workspace>
>;

export type {
	ArgumentInfo,
	AssocItemConstraint,
	Confidence,
	CrateGraph,
	Deprecation,
	Edge,
	EdgeKind,
	ExternalCrate,
	FieldInfo,
	FunctionPointerSig,
	FunctionSignature,
	GenericArg,
	GenericArgs,
	GenericBound,
	GenericParam,
	Generics,
	ImplCategory,
	ImplType,
	Node,
	NodeKind,
	PolyTrait,
	ProvidedDefaultUnstable,
	Span,
	StabilityInfo,
	Term,
	TypeRef,
	VariantInfo,
	VariantKind,
	Visibility,
	WherePredicate,
	Workspace,
};

export type WorkspaceOutput = Workspace;
export type NodeSummary = Pick<
	Node,
	| 'id'
	| 'name'
	| 'kind'
	| 'visibility'
	| 'is_external'
	| 'is_deprecated'
	| 'impl_trait'
	| 'impl_category'
	| 'generics'
>;
export type CrateSummary = v.InferOutput<typeof CrateSummarySchema>;
export type CrateIndexEntry = v.InferOutput<typeof CrateIndexEntrySchema>;
export type CrateIndex = v.InferOutput<typeof CrateIndexSchema>;
export type CrateTree = {
	nodes: NodeSummary[];
	edges: Edge[];
};
export type NodeDetail = {
	node: Node;
	edges: Edge[];
	relatedNodes: Node[];
};
export type SelectedEdges = v.InferOutput<typeof SelectedEdgesSchema>;
export type DetailMethodGroup = v.InferOutput<typeof DetailMethodGroupSchema>;
export type TocEntry = v.InferOutput<typeof TocEntrySchema>;
export type WhereUsedRef = v.InferOutput<typeof WhereUsedRefSchema>;
export type DetailDocModel = v.InferOutput<typeof DetailDocModelSchema>;
export type DesignRelation = v.InferOutput<typeof DesignRelationSchema>;
export type RelationshipGroupItem = v.InferOutput<typeof RelationshipGroupItemSchema>;
export type RelationshipGroup = v.InferOutput<typeof RelationshipGroupSchema>;
export type RelationshipGroups = v.InferOutput<typeof RelationshipGroupsSchema>;
export type SourceResult = v.InferOutput<typeof SourceResultSchema>;
export type CrateStatus = v.InferOutput<typeof CrateStatusSchema>;
export type CrateSearchResult = v.InferOutput<typeof CrateSearchResultSchema>;

/** Combined response from getCrateData (tree + index + versions in one call). */
export type CrateData = {
	tree: CrateTree;
	index: CrateIndex | null;
	versions: string[];
};

/** A tree node with a hasChildren flag — used by lazy tree endpoints. */
export const TreeNodeDTOSchema = v.object({
	node: NodeSummarySchema,
	hasChildren: v.boolean(),
});
export type TreeNodeDTO = v.InferOutput<typeof TreeNodeDTOSchema>;

export const STATIC_ARTIFACT_SCHEMA_VERSION = 1;

export const StaticCrateManifestSchema = v.object({
	schema_version: v.literal(STATIC_ARTIFACT_SCHEMA_VERSION),
	name: v.string(),
	version: v.string(),
	index: CrateIndexSchema,
	nodeCount: v.number(),
	edgeCount: v.number(),
	kindCounts: v.record(v.string(), v.number()),
	roots: v.array(TreeNodeDTOSchema),
	rootChildren: v.record(v.string(), v.array(TreeNodeDTOSchema)),
	/**
	 * Lists of populated shard buckets per kind (hex strings like `"00f"`).
	 * Worker reads these before issuing a shard GET to skip empty buckets.
	 */
	populatedShards: v.object({
		nodes: v.array(v.string()),
		nodeDetails: v.array(v.string()),
		treeChildren: v.array(v.string()),
	}),
});
export type StaticCrateManifest = v.InferOutput<typeof StaticCrateManifestSchema>;

export const StaticCrateCatalogEntrySchema = v.object({
	name: v.string(),
	version: v.string(),
	storageName: v.optional(v.string()),
	source: v.optional(v.picklist(['std', 'crates.io'])),
	description: v.optional(v.string()),
	nodeCount: v.optional(v.number()),
	edgeCount: v.optional(v.number()),
});
export type StaticCrateCatalogEntry = v.InferOutput<typeof StaticCrateCatalogEntrySchema>;

export const StaticCrateCatalogSchema = v.object({
	schema_version: v.literal(STATIC_ARTIFACT_SCHEMA_VERSION),
	generatedAt: v.optional(v.string()),
	crates: v.array(StaticCrateCatalogEntrySchema),
});
export type StaticCrateCatalog = v.InferOutput<typeof StaticCrateCatalogSchema>;

export const StaticTreeChildrenShardSchema = v.object({
	schema_version: v.literal(STATIC_ARTIFACT_SCHEMA_VERSION),
	name: v.string(),
	version: v.string(),
	bucket: v.string(),
	parents: v.record(
		v.string(),
		v.object({
			parent: NodeSummarySchema,
			children: v.array(TreeNodeDTOSchema),
		}),
	),
});
export type StaticTreeChildrenShard = v.InferOutput<typeof StaticTreeChildrenShardSchema>;

export const StaticSearchShardSchema = v.object({
	schema_version: v.literal(STATIC_ARTIFACT_SCHEMA_VERSION),
	name: v.string(),
	version: v.string(),
	prefix: v.string(),
	entries: v.array(NodeSummarySchema),
});
export type StaticSearchShard = v.InferOutput<typeof StaticSearchShardSchema>;

export const StaticSearchManifestSchema = v.object({
	schema_version: v.literal(STATIC_ARTIFACT_SCHEMA_VERSION),
	name: v.string(),
	version: v.string(),
	prefixes: v.array(v.string()),
});
export type StaticSearchManifest = v.InferOutput<typeof StaticSearchManifestSchema>;

/** Lightweight crate metadata: index + versions + kind counts (no tree nodes). */
export const KindFacetSchema = v.object({
	kind: NodeKindSchema,
	label: v.string(),
	count: v.number(),
});
export type KindFacet = v.InferOutput<typeof KindFacetSchema>;

export const CrateMetaSchema = v.object({
	index: v.nullable(CrateIndexSchema),
	versions: v.array(v.string()),
	kindCounts: v.record(NodeKindSchema, v.number()),
	kindFacets: v.array(KindFacetSchema),
});
export type CrateMeta = v.InferOutput<typeof CrateMetaSchema>;

/** Base per-node response as stored in hosted artifacts. */
export const NodeViewBaseSchema = v.object({
	detail: NodeDetailSchema,
	ancestors: v.array(NodeSummarySchema),
});
export type NodeViewBase = v.InferOutput<typeof NodeViewBaseSchema>;

/** Combined per-node response: detail + ancestors + server-composed render DTOs. */
export const NodeViewSchema = v.object({
	detail: NodeDetailSchema,
	ancestors: v.array(NodeSummarySchema),
	docModel: DetailDocModelSchema,
	relationshipGroups: RelationshipGroupsSchema,
});
export type NodeView = v.InferOutput<typeof NodeViewSchema>;

export const StaticNodeShardSchema = v.object({
	schema_version: v.literal(STATIC_ARTIFACT_SCHEMA_VERSION),
	name: v.string(),
	version: v.string(),
	bucket: v.string(),
	nodes: v.record(v.string(), NodeSchema),
});
export type StaticNodeShard = v.InferOutput<typeof StaticNodeShardSchema>;

export const StaticNodeDetailEntrySchema = v.object({
	nodeId: v.string(),
	edges: v.array(EdgeSchema),
	relatedIds: v.array(v.string()),
	ancestors: v.array(NodeSummarySchema),
});
export type StaticNodeDetailEntry = v.InferOutput<typeof StaticNodeDetailEntrySchema>;

export const StaticNodeDetailShardSchema = v.object({
	schema_version: v.literal(STATIC_ARTIFACT_SCHEMA_VERSION),
	name: v.string(),
	version: v.string(),
	bucket: v.string(),
	details: v.record(v.string(), StaticNodeDetailEntrySchema),
});
export type StaticNodeDetailShard = v.InferOutput<typeof StaticNodeDetailShardSchema>;

/**
 * Parse and validate a raw JSON object as a Workspace.
 * Throws a ValiError if validation fails.
 */
export function parseWorkspace(data: unknown): WorkspaceOutput {
	return v.parse(WorkspaceSchema, data);
}
