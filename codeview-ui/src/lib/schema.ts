import * as v from 'valibot';

/** Current graph schema version supported by this UI */
export const SCHEMA_VERSION = 1;

// --- Enums ---

export const NodeKindSchema = v.picklist([
	'Crate',
	'Module',
	'Struct',
	'Union',
	'Enum',
	'Trait',
	'TraitAlias',
	'Impl',
	'Function',
	'Method',
	'TypeAlias'
]);

export const ImplTypeSchema = v.picklist(['Trait', 'Inherent']);

export const VisibilitySchema = v.picklist([
	'Public',
	'Crate',
	'Restricted',
	'Inherited',
	'Unknown'
]);

export const EdgeKindSchema = v.picklist([
	'Contains',
	'Defines',
	'Implements',
	'UsesType',
	'CallsStatic',
	'CallsRuntime',
	'Derives',
	'ReExports'
]);

export const ConfidenceSchema = v.picklist(['Static', 'Runtime', 'Inferred']);

// --- Nested structures ---

export const SpanSchema = v.object({
	file: v.string(),
	line: v.number(),
	column: v.number(),
	end_line: v.optional(v.nullable(v.number())),
	end_column: v.optional(v.nullable(v.number()))
});

export const FieldInfoSchema = v.object({
	name: v.string(),
	type_name: v.string(),
	visibility: VisibilitySchema
});

export const VariantInfoSchema = v.object({
	name: v.string(),
	fields: v.array(FieldInfoSchema)
});

export const ArgumentInfoSchema = v.object({
	name: v.string(),
	type_name: v.string()
});

export const FunctionSignatureSchema = v.object({
	inputs: v.array(ArgumentInfoSchema),
	output: v.optional(v.nullable(v.string())),
	is_async: v.boolean(),
	is_unsafe: v.boolean(),
	is_const: v.boolean()
});

// --- Node & Edge ---

export const NodeSchema = v.object({
	id: v.string(),
	name: v.string(),
	kind: NodeKindSchema,
	visibility: VisibilitySchema,
	span: v.optional(v.nullable(SpanSchema)),
	attrs: v.optional(v.array(v.string())),
	is_external: v.optional(v.boolean()),
	fields: v.optional(v.nullable(v.array(FieldInfoSchema))),
	variants: v.optional(v.nullable(v.array(VariantInfoSchema))),
	signature: v.optional(v.nullable(FunctionSignatureSchema)),
	generics: v.optional(v.nullable(v.array(v.string()))),
	where_clause: v.optional(v.nullable(v.array(v.string()))),
	docs: v.optional(v.nullable(v.string())),
	doc_links: v.optional(v.record(v.string(), v.string())),
	bound_links: v.optional(v.record(v.string(), v.string())),
	impl_type: v.optional(v.nullable(ImplTypeSchema)),
	parent_impl: v.optional(v.nullable(v.string())),
	impl_trait: v.optional(v.nullable(v.string()))
});

export const EdgeSchema = v.object({
	from: v.string(),
	to: v.string(),
	kind: EdgeKindSchema,
	confidence: ConfidenceSchema
});

// --- Per-crate graph ---

export const CrateGraphSchema = v.object({
	id: v.string(),
	name: v.string(),
	version: v.string(),
	nodes: v.array(NodeSchema),
	edges: v.array(EdgeSchema)
});

export const ExternalCrateSchema = v.object({
	id: v.string(),
	name: v.string(),
	version: v.optional(v.nullable(v.string())),
	nodes: v.array(NodeSchema)
});

// --- Top-level Workspace ---

export const WorkspaceSchema = v.object({
	version: v.optional(v.number(), 1),
	crates: v.array(CrateGraphSchema),
	external_crates: v.array(ExternalCrateSchema),
	cross_crate_edges: v.array(EdgeSchema),
	repo: v.optional(v.nullable(v.string())),
	ref: v.optional(v.nullable(v.string()))
});

// --- Query input schemas ---

export const SearchNodesInputSchema = v.object({
	crate: v.optional(v.string()),
	version: v.optional(v.string()),
	q: v.string()
});

export const GetSourceInputSchema = v.object({
	file: v.string()
});

export const NodeIdSchema = v.string();
export const NodeIdsSchema = v.array(v.string());

export const CrateRefSchema = v.object({
	name: v.string(),
	version: v.optional(v.string())
});

export const NodeDetailInputSchema = v.object({
	nodeId: v.string(),
	version: v.optional(v.string()),
	refresh: v.optional(v.number())
});

export const ProcessingInputSchema = v.object({
	refresh: v.optional(v.number())
});

// --- Response schemas ---

/** Lightweight node summary for tree/list display */
export const NodeSummarySchema = v.object({
	id: v.string(),
	name: v.string(),
	kind: NodeKindSchema,
	visibility: VisibilitySchema,
	is_external: v.optional(v.boolean()),
	// Impl-specific fields (only populated for Impl nodes)
	impl_trait: v.optional(v.nullable(v.string())),
	generics: v.optional(v.nullable(v.array(v.string()))),
	where_clause: v.optional(v.nullable(v.array(v.string()))),
	bound_links: v.optional(v.record(v.string(), v.string()))
});

/** getCrates response item */
export const CrateSummarySchema = v.object({
	id: v.string(),
	name: v.string(),
	version: v.string()
});

/** Lightweight crate index entry (for hosted pseudo-workspace) */
export const CrateIndexEntrySchema = v.object({
	id: v.string(),
	name: v.string(),
	version: v.string(),
	is_external: v.optional(v.boolean())
});

/** Per-crate hosted index response */
export const CrateIndexSchema = v.object({
	name: v.string(),
	version: v.string(),
	crates: v.array(CrateIndexEntrySchema)
});

/** getCrateTree response */
export const CrateTreeSchema = v.object({
	nodes: v.array(NodeSummarySchema),
	edges: v.array(EdgeSchema)
});

/** getNodeDetail response */
export const NodeDetailSchema = v.object({
	node: NodeSchema,
	edges: v.array(EdgeSchema),
	relatedNodes: v.array(NodeSummarySchema)
});

/** getSource response */
export const SourceResultSchema = v.object({
	error: v.nullable(v.string()),
	content: v.nullable(v.string())
});

// --- Crate status (for cloud multi-crate mode) ---

export const CrateStatusValueSchema = v.picklist(['unknown', 'processing', 'ready', 'failed']);

export const CrateStatusSchema = v.object({
	status: CrateStatusValueSchema,
	error: v.optional(v.string()),
	step: v.optional(v.string()),
	action: v.optional(v.picklist(['install_std_docs'])),
	installedVersion: v.optional(v.string())
});

export const CrateSearchResultSchema = v.object({
	name: v.string(),
	version: v.string(),
	description: v.optional(v.string())
});

// --- Inferred types ---

export type WorkspaceOutput = v.InferOutput<typeof WorkspaceSchema>;
export type NodeSummary = v.InferOutput<typeof NodeSummarySchema>;
export type CrateSummary = v.InferOutput<typeof CrateSummarySchema>;
export type CrateIndexEntry = v.InferOutput<typeof CrateIndexEntrySchema>;
export type CrateIndex = v.InferOutput<typeof CrateIndexSchema>;
export type CrateTree = v.InferOutput<typeof CrateTreeSchema>;
export type NodeDetail = v.InferOutput<typeof NodeDetailSchema>;
export type SourceResult = v.InferOutput<typeof SourceResultSchema>;
export type CrateStatus = v.InferOutput<typeof CrateStatusSchema>;
export type CrateSearchResult = v.InferOutput<typeof CrateSearchResultSchema>;

/**
 * Parse and validate a raw JSON object as a Workspace.
 * Throws a ValiError if validation fails.
 */
export function parseWorkspace(data: unknown): WorkspaceOutput {
	return v.parse(WorkspaceSchema, data);
}
