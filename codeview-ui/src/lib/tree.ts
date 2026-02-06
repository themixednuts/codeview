import type { Node, NodeKind } from '$lib/graph';
import type { Component } from 'svelte';
import { kindVisuals } from '$lib/graph/visual';
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
import Hash from '@lucide/svelte/icons/hash';
import Database from '@lucide/svelte/icons/database';
import Wand2 from '@lucide/svelte/icons/wand-2';
import CircleDot from '@lucide/svelte/icons/circle-dot';
import PackageOpen from '@lucide/svelte/icons/package-open';
import Import from '@lucide/svelte/icons/import';
import Sparkles from '@lucide/svelte/icons/sparkles';

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
	StructField: Box,
	Union: Layers,
	Enum: List,
	Variant: List,
	Trait: Shield,
	TraitAlias: ShieldHalf,
	Impl: Puzzle,
	Function: Braces,
	TypeAlias: Equal,
	AssocType: Equal,
	Constant: Hash,
	AssocConst: Hash,
	Static: Database,
	Macro: Wand2,
	Primitive: CircleDot,
	ExternCrate: PackageOpen,
	Import: Import,
	ProcMacro: Sparkles
};

export const kindOrder: Record<NodeKind, number> = {
	Crate: 0,
	Module: 1,
	Trait: 2,
	Struct: 3,
	StructField: 4,
	Enum: 5,
	Variant: 6,
	Union: 7,
	TypeAlias: 8,
	AssocType: 9,
	Constant: 10,
	AssocConst: 11,
	Static: 12,
	Function: 13,
	Impl: 14,
	TraitAlias: 15,
	Macro: 16,
	ProcMacro: 17,
	Primitive: 18,
	ExternCrate: 19,
	Import: 20
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
