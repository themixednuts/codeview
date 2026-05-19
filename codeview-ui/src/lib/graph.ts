import type {
	ArgumentInfo,
	Confidence,
	CrateGraph,
	Deprecation,
	Edge,
	EdgeKind,
	ExternalCrate,
	FieldInfo,
	FunctionSignature,
	ImplCategory,
	ImplType,
	Node,
	NodeKind,
	Span,
	VariantInfo,
	Visibility,
	Workspace,
} from '$lib/schema';

export type {
	ArgumentInfo,
	Confidence,
	CrateGraph,
	Deprecation,
	Edge,
	EdgeKind,
	ExternalCrate,
	FieldInfo,
	FunctionSignature,
	ImplCategory,
	ImplType,
	Node,
	NodeKind,
	Span,
	VariantInfo,
	Visibility,
	Workspace,
};

/** Lightweight graph shape used for tree/detail display */
export interface Graph {
	nodes: Node[];
	edges: Edge[];
}
