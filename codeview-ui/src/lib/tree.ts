import type { Node, NodeKind } from '$lib/graph';
import type { Component } from 'svelte';
import { kindVisuals } from '$lib/visual';
import Package from '@lucide/svelte/icons/package';
import FolderCode from '@lucide/svelte/icons/folder-code';
import Box from '@lucide/svelte/icons/box';
import Layers from '@lucide/svelte/icons/layers';
import List from '@lucide/svelte/icons/list';
import Shield from '@lucide/svelte/icons/shield';
import ShieldHalf from '@lucide/svelte/icons/shield-half';
import Puzzle from '@lucide/svelte/icons/puzzle';
import Braces from '@lucide/svelte/icons/braces';
import Equal from '@lucide/svelte/icons/equal';

/** Node fill colors — derived from the canonical kindVisuals palette. */
export const kindColors: Record<NodeKind, string> = Object.fromEntries(
	(Object.entries(kindVisuals) as [NodeKind, { fill: string; stroke: string }][]).map(
		([k, v]) => [k, v.fill]
	)
) as Record<NodeKind, string>;

export const kindIcons: Record<NodeKind, Component> = {
	Crate: Package,
	Module: FolderCode,
	Struct: Box,
	Union: Layers,
	Enum: List,
	Trait: Shield,
	TraitAlias: ShieldHalf,
	Impl: Puzzle,
	Function: Braces,
	Method: Braces,
	TypeAlias: Equal
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
