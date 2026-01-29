import type { Node, NodeKind } from '$lib/graph';

export const kindColors: Record<NodeKind, string> = {
	Crate: '#e85d04',
	Module: '#2d6a4f',
	Struct: '#9d4edd',
	Union: '#7b2cbf',
	Enum: '#3a86ff',
	Trait: '#06d6a0',
	TraitAlias: '#0db39e',
	Impl: '#8d99ae',
	Function: '#f72585',
	Method: '#b5179e',
	TypeAlias: '#ff6d00'
};

export const kindIcons: Record<NodeKind, string> = {
	Crate: '📦',
	Module: '📁',
	Struct: 'S',
	Union: 'U',
	Enum: 'E',
	Trait: 'T',
	TraitAlias: 'T',
	Impl: 'I',
	Function: 'fn',
	Method: 'fn',
	TypeAlias: '='
};

export const kindOrder: Record<NodeKind, number> = {
	Crate: 0,
	Module: 1,
	Trait: 2,
	Struct: 3,
	Enum: 4,
	Union: 5,
	TypeAlias: 6,
	Function: 7,
	Impl: 8,
	Method: 9,
	TraitAlias: 10
};

export interface TreeNode {
	node: Node;
	children: TreeNode[];
	selectable: boolean;
}

export function matchesFilter(node: Node, filter: string, kindFilter: Set<NodeKind>): boolean {
	if (kindFilter.size > 0 && !kindFilter.has(node.kind)) {
		return false;
	}
	if (!filter) return true;
	return node.name.toLowerCase().includes(filter) || node.id.toLowerCase().includes(filter);
}

export function hasMatchingDescendant(
	tree: TreeNode,
	filter: string,
	kindFilter: Set<NodeKind>
): boolean {
	if (matchesFilter(tree.node, filter, kindFilter)) return true;
	return tree.children.some((c) => hasMatchingDescendant(c, filter, kindFilter));
}
