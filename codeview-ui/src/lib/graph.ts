import type * as v from 'valibot';
import type {
	NodeKindSchema,
	ImplTypeSchema,
	VisibilitySchema,
	EdgeKindSchema,
	ConfidenceSchema,
	SpanSchema,
	FieldInfoSchema,
	VariantInfoSchema,
	ArgumentInfoSchema,
	FunctionSignatureSchema,
	NodeSchema,
	EdgeSchema,
	CrateGraphSchema,
	ExternalCrateSchema,
	WorkspaceSchema
} from '$lib/schema';

export type NodeKind = v.InferOutput<typeof NodeKindSchema>;
export type ImplType = v.InferOutput<typeof ImplTypeSchema>;
export type Visibility = v.InferOutput<typeof VisibilitySchema>;
export type EdgeKind = v.InferOutput<typeof EdgeKindSchema>;
export type Confidence = v.InferOutput<typeof ConfidenceSchema>;
export type Span = v.InferOutput<typeof SpanSchema>;
export type FieldInfo = v.InferOutput<typeof FieldInfoSchema>;
export type VariantInfo = v.InferOutput<typeof VariantInfoSchema>;
export type ArgumentInfo = v.InferOutput<typeof ArgumentInfoSchema>;
export type FunctionSignature = v.InferOutput<typeof FunctionSignatureSchema>;
export type Node = v.InferOutput<typeof NodeSchema>;
export type Edge = v.InferOutput<typeof EdgeSchema>;
export type CrateGraph = v.InferOutput<typeof CrateGraphSchema>;
export type ExternalCrate = v.InferOutput<typeof ExternalCrateSchema>;
export type Workspace = v.InferOutput<typeof WorkspaceSchema>;

/** Lightweight graph shape used for tree/detail display */
export interface Graph {
	nodes: Node[];
	edges: Edge[];
}
