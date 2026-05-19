import type { NodeKind } from '$lib/graph';

export const kindOrder: Record<NodeKind, number> = {
	Crate: 0,
	Module: 1,
	TypeAlias: 2,
	Struct: 3,
	StructField: 4,
	Enum: 5,
	Variant: 6,
	Union: 7,
	Function: 8,
	AssocType: 9,
	Constant: 10,
	AssocConst: 11,
	Static: 12,
	Macro: 13,
	ProcMacro: 14,
	Primitive: 15,
	ExternCrate: 16,
	Import: 17,
	Impl: 18,
	Trait: 19,
	TraitAlias: 20,
};

export type OrderedNodeLike = {
	id?: string;
	name: string;
	kind: NodeKind;
};

export function compareNodeLike(a: OrderedNodeLike, b: OrderedNodeLike): number {
	const kindDiff = (kindOrder[a.kind] ?? 99) - (kindOrder[b.kind] ?? 99);
	if (kindDiff !== 0) return kindDiff;
	if (a.name !== b.name) return a.name < b.name ? -1 : 1;
	const aId = a.id ?? '';
	const bId = b.id ?? '';
	return aId < bId ? -1 : aId > bId ? 1 : 0;
}
