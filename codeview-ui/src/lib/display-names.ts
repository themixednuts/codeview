import type { EdgeKind, NodeKind, Visibility } from '$lib/graph';

export const kindLabels: Record<NodeKind, string> = {
	Crate: 'Crate',
	Module: 'Module',
	Struct: 'Struct',
	StructField: 'Field',
	Union: 'Union',
	Enum: 'Enum',
	Variant: 'Variant',
	Trait: 'Trait',
	TraitAlias: 'Trait alias',
	Impl: 'Impl',
	Function: 'Function',
	TypeAlias: 'Type alias',
	AssocType: 'Assoc type',
	Constant: 'Constant',
	AssocConst: 'Assoc const',
	Static: 'Static',
	Macro: 'Macro',
	Primitive: 'Primitive',
	ExternCrate: 'Extern crate',
	Import: 'Import',
	ProcMacro: 'Proc macro'
};

export const visibilityLabels: Record<Visibility, string> = {
	Public: 'Public',
	Crate: 'Crate',
	Restricted: 'Restricted',
	Inherited: 'Inherited',
	Unknown: 'Unknown'
};

export const edgeLabels: Record<EdgeKind, string> = {
	Contains: 'Contains',
	Defines: 'Defines',
	UsesType: 'Uses type',
	Implements: 'Implements',
	CallsStatic: 'Calls',
	CallsRuntime: 'Runtime calls',
	Derives: 'Derives',
	ReExports: 'Re-exports'
};

export const nodeKindOrder: NodeKind[] = [
	'Crate',
	'Module',
	'Struct',
	'StructField',
	'Enum',
	'Variant',
	'Trait',
	'Impl',
	'Function',
	'TypeAlias',
	'AssocType',
	'Union',
	'TraitAlias',
	'Constant',
	'AssocConst',
	'Static',
	'Macro',
	'Primitive',
	'ExternCrate',
	'Import',
	'ProcMacro'
];
