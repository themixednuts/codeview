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
	Union: Layers,
	Enum: List,
	Trait: Shield,
	TraitAlias: ShieldHalf,
	Impl: Puzzle,
	Function: Braces,
	TypeAlias: Equal,
	Constant: Hash,
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
	Enum: 4,
	Union: 5,
	TypeAlias: 6,
	Constant: 7,
	Static: 8,
	Function: 9,
	Impl: 10,
	TraitAlias: 11,
	Macro: 12,
	ProcMacro: 13,
	Primitive: 14,
	ExternCrate: 15,
	Import: 16
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
