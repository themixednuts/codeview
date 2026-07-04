import type { EdgeKind, Node, NodeKind, NodeSummary, Visibility } from '$lib/schema';
import { edgeLabels, isPublic, kindLabels } from '$lib/display-names';
import { formatSignature, type FormattedSignature } from '$lib/signature-format';
import { nodeUrl } from '$lib/url';

export type DesignKindToken =
	| 'crate'
	| 'module'
	| 'struct'
	| 'struct-field'
	| 'union'
	| 'enum'
	| 'variant'
	| 'trait'
	| 'trait-alias'
	| 'impl'
	| 'function'
	| 'typealias'
	| 'assoc-type'
	| 'constant'
	| 'assoc-const'
	| 'static'
	| 'macro'
	| 'primitive'
	| 'extern-crate'
	| 'import'
	| 'proc-macro';

export const NODE_KIND_TO_DESIGN_KIND = {
	Crate: 'crate',
	Module: 'module',
	Struct: 'struct',
	StructField: 'struct-field',
	Union: 'union',
	Enum: 'enum',
	Variant: 'variant',
	Trait: 'trait',
	TraitAlias: 'trait-alias',
	Impl: 'impl',
	Function: 'function',
	TypeAlias: 'typealias',
	AssocType: 'assoc-type',
	Constant: 'constant',
	AssocConst: 'assoc-const',
	Static: 'static',
	Macro: 'macro',
	Primitive: 'primitive',
	ExternCrate: 'extern-crate',
	Import: 'import',
	ProcMacro: 'proc-macro',
} as const satisfies Record<NodeKind, DesignKindToken>;

export const DESIGN_KIND_TO_NODE_KIND = {
	crate: 'Crate',
	module: 'Module',
	mod: 'Module',
	struct: 'Struct',
	'struct-field': 'StructField',
	field: 'StructField',
	union: 'Union',
	enum: 'Enum',
	variant: 'Variant',
	trait: 'Trait',
	'trait-alias': 'TraitAlias',
	impl: 'Impl',
	function: 'Function',
	fn: 'Function',
	method: 'Function',
	type: 'TypeAlias',
	typealias: 'TypeAlias',
	'assoc-type': 'AssocType',
	const: 'Constant',
	constant: 'Constant',
	'assoc-const': 'AssocConst',
	static: 'Static',
	macro: 'Macro',
	primitive: 'Primitive',
	'extern-crate': 'ExternCrate',
	import: 'Import',
	'proc-macro': 'ProcMacro',
} as const satisfies Record<string, NodeKind>;

export type DesignRelation =
	| 'contains'
	| 'reexports'
	| 'defines'
	| 'implements'
	| 'uses'
	| 'calls'
	| 'calls-runtime'
	| 'derives';

export const REL = {
	contains: {
		cssVar: '--edge-contains',
		color: 'var(--edge-contains)',
		label: 'Contains',
		out: 'contains',
		in: 'contained by',
	},
	reexports: {
		cssVar: '--edge-reexports',
		color: 'var(--edge-reexports)',
		label: 'Re-exports',
		out: 're-exports',
		in: 're-exported by',
	},
	defines: {
		cssVar: '--edge-defines',
		color: 'var(--edge-defines)',
		label: 'Defines',
		out: 'defines',
		in: 'defined in',
	},
	implements: {
		cssVar: '--edge-implements',
		color: 'var(--edge-implements)',
		label: 'Implements',
		out: 'implements',
		in: 'implemented by',
	},
	uses: {
		cssVar: '--edge-uses',
		color: 'var(--edge-uses)',
		label: 'Uses type',
		out: 'uses',
		in: 'used by',
	},
	calls: {
		cssVar: '--edge-calls',
		color: 'var(--edge-calls)',
		label: 'Calls',
		out: 'calls',
		in: 'called by',
	},
	'calls-runtime': {
		cssVar: '--edge-calls-runtime',
		color: 'var(--edge-calls-runtime)',
		label: 'Runtime calls',
		out: 'runtime calls',
		in: 'runtime called by',
	},
	derives: {
		cssVar: '--edge-derives',
		color: 'var(--edge-derives)',
		label: 'Derives',
		out: 'derives',
		in: 'derived by',
	},
} as const satisfies Record<
	DesignRelation,
	{ cssVar: string; color: string; label: string; out: string; in: string }
>;

export const REL_ORDER = [
	'contains',
	'reexports',
	'defines',
	'implements',
	'uses',
	'calls',
	'calls-runtime',
	'derives',
] as const satisfies readonly DesignRelation[];

export const EDGE_KIND_TO_RELATION = {
	Contains: 'contains',
	Defines: 'defines',
	Implements: 'implements',
	UsesType: 'uses',
	ReExports: 'reexports',
	CallsStatic: 'calls',
	CallsRuntime: 'calls-runtime',
	Derives: 'derives',
} as const satisfies Record<EdgeKind, DesignRelation>;

export interface DesignNodeContext {
	ancestors?: Pick<NodeSummary, 'id' | 'name'>[];
	blurb?: string;
	crateVersions?: Record<string, string>;
	getNodeUrl?: (nodeId: string) => string;
	href?: string;
	path?: string;
}

export interface DesignNode<TNode extends Node | NodeSummary = Node | NodeSummary> {
	id: string;
	kind: DesignKindToken;
	path: string;
	external: boolean;
	blurb?: string;
	sig?: FormattedSignature;
	href?: string;
	label: string;
	kindLabel: string;
	public: boolean;
	deprecated: boolean;
	visibility: Visibility;
	real: TNode;
}

export interface DesignRelationInfo {
	kind: EdgeKind;
	token: DesignRelation;
	cssVar: string;
	color: string;
	label: string;
	out: string;
	in: string;
}

export function nodeKindToDesignKind(kind: NodeKind): DesignKindToken {
	return NODE_KIND_TO_DESIGN_KIND[kind];
}

export function designKindToNodeKind(kind: string): NodeKind | undefined {
	if ((NODE_KIND_TO_DESIGN_KIND as Record<string, DesignKindToken | undefined>)[kind]) {
		return kind as NodeKind;
	}
	return (DESIGN_KIND_TO_NODE_KIND as Record<string, NodeKind | undefined>)[kind];
}

export function edgeKindToRelation(kind: EdgeKind): DesignRelationInfo {
	const token = EDGE_KIND_TO_RELATION[kind];
	const relation = REL[token];
	return {
		...relation,
		kind,
		token,
		label: edgeLabels[kind] ?? relation.label,
	};
}

export function toDesignNode<TNode extends Node | NodeSummary>(
	node: TNode,
	ctx: DesignNodeContext = {},
): DesignNode<TNode> {
	const sig = hasRealSignature(node) ? formatSignature(node) : undefined;
	const href = ctx.href ?? ctx.getNodeUrl?.(node.id) ?? buildNodeHref(node.id, ctx.crateVersions);
	const path = ctx.path ?? pathFromAncestors(node, ctx.ancestors) ?? node.id;
	const blurb = ctx.blurb ?? docsBlurb(node);

	return {
		id: node.id,
		kind: nodeKindToDesignKind(node.kind),
		path,
		external: Boolean(node.is_external),
		...(blurb ? { blurb } : {}),
		...(sig ? { sig } : {}),
		...(href ? { href } : {}),
		label: node.name,
		kindLabel: kindLabels[node.kind] ?? node.kind,
		public: isPublic(node.visibility),
		deprecated: Boolean(node.is_deprecated),
		visibility: node.visibility,
		real: node,
	};
}

function buildNodeHref(nodeId: string, crateVersions?: Record<string, string>): string | undefined {
	return crateVersions ? nodeUrl(nodeId, crateVersions) : undefined;
}

function pathFromAncestors(
	node: Node | NodeSummary,
	ancestors?: Pick<NodeSummary, 'id' | 'name'>[],
): string | undefined {
	if (!ancestors?.length) return undefined;
	return [...ancestors.map((ancestor) => ancestor.name), node.name].filter(Boolean).join('::');
}

function docsBlurb(node: Node | NodeSummary): string | undefined {
	if (!('docs' in node) || !node.docs) return undefined;
	const firstParagraph = node.docs
		.trim()
		.split(/\n\s*\n/, 1)[0]
		?.replace(/\s+/g, ' ')
		.trim();
	return firstParagraph || undefined;
}

function hasRealSignature(
	node: Node | NodeSummary,
): node is Node & Pick<Required<Node>, 'signature'> {
	return 'signature' in node && Boolean(node.signature);
}
