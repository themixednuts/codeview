import type { Node, NodeKind } from "#lib/graph.js";
import type { Component } from "svelte";
import { kindVisuals } from "#lib/graph/visual/index.js";
import { compareNodeLike, kindOrder } from "#lib/node-order.js";
import Package from "@lucide/svelte/icons/package";
import FolderCode from "@lucide/svelte/icons/folder-code";
import Box from "@lucide/svelte/icons/box";
import Layers from "@lucide/svelte/icons/layers";
import List from "@lucide/svelte/icons/list";
import Shield from "@lucide/svelte/icons/shield";
import ShieldHalf from "@lucide/svelte/icons/shield-half";
import Puzzle from "@lucide/svelte/icons/puzzle";
import Braces from "@lucide/svelte/icons/braces";
import Equal from "@lucide/svelte/icons/equal";
import Hash from "@lucide/svelte/icons/hash";
import Database from "@lucide/svelte/icons/database";
import Wand2 from "@lucide/svelte/icons/wand-2";
import CircleDot from "@lucide/svelte/icons/circle-dot";
import PackageOpen from "@lucide/svelte/icons/package-open";
import Import from "@lucide/svelte/icons/import";
import Sparkles from "@lucide/svelte/icons/sparkles";

/** Node fill colors — derived from the canonical kindVisuals palette. */
export const kindColors = {
  Crate: kindVisuals.Crate.fill,
  Module: kindVisuals.Module.fill,
  Struct: kindVisuals.Struct.fill,
  StructField: kindVisuals.StructField.fill,
  Union: kindVisuals.Union.fill,
  Enum: kindVisuals.Enum.fill,
  Variant: kindVisuals.Variant.fill,
  Trait: kindVisuals.Trait.fill,
  TraitAlias: kindVisuals.TraitAlias.fill,
  Impl: kindVisuals.Impl.fill,
  Function: kindVisuals.Function.fill,
  TypeAlias: kindVisuals.TypeAlias.fill,
  AssocType: kindVisuals.AssocType.fill,
  Constant: kindVisuals.Constant.fill,
  AssocConst: kindVisuals.AssocConst.fill,
  Static: kindVisuals.Static.fill,
  Macro: kindVisuals.Macro.fill,
  Primitive: kindVisuals.Primitive.fill,
  ExternCrate: kindVisuals.ExternCrate.fill,
  Import: kindVisuals.Import.fill,
  ProcMacro: kindVisuals.ProcMacro.fill,
} satisfies Record<NodeKind, string>;

export const kindIcons = {
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
  ProcMacro: Sparkles,
} as const satisfies { [K in NodeKind]: Component };

export { kindOrder };

export interface TreeNode {
  node: Node;
  children: TreeNode[];
  selectable: boolean;
}

/** Compare TreeNodes by kindOrder then name. Used for lazy sorting. */
export function compareTreeNodes(a: TreeNode, b: TreeNode): number {
  return compareNodeLike(a.node, b.node);
}

/**
 * Sentinel: a frozen non-empty array signalling "this node has children that
 * haven't been resolved yet".  Consumers compare `=== CHILDREN_PLACEHOLDER`
 * and call a resolver when they need the real children.
 */
export const CHILDREN_PLACEHOLDER: TreeNode[] = [
  {
    node: {
      id: "",
      name: "",
      kind: "Module",
      visibility: { kind: "Public" },
      attrs: [],
    },
    children: [],
    selectable: false,
  },
];
Object.freeze(CHILDREN_PLACEHOLDER);

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
  kindFilter: Set<NodeKind>,
): boolean {
  if (matchesFilter(tree.node, filter, kindFilter)) return true;
  return tree.children.some((c) => hasMatchingDescendant(c, filter, kindFilter));
}
