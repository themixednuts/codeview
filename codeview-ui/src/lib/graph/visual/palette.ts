import type { NodeKind } from '$lib/graph';

/**
 * Node fill/stroke colors — Solarized accent palette mapped to kinds.
 *
 * Hex values are identical between light + dark UI modes (a Solarized property:
 * accent colors are designed to land at the same CIELAB lightness regardless of
 * background). Variants and field-style kinds use a slightly lighter family
 * tone so they read as "child of" the parent kind.
 */
export const kindVisuals: Record<NodeKind, { fill: string; stroke: string }> = {
	Crate: { fill: '#cb4b16', stroke: '#a23a0e' }, // solarized orange
	Module: { fill: '#859900', stroke: '#677500' }, // green
	Struct: { fill: '#6c71c4', stroke: '#5359a8' }, // violet
	StructField: { fill: '#9499d4', stroke: '#6c71c4' },
	Union: { fill: '#6c71c4', stroke: '#5359a8' },
	Enum: { fill: '#268bd2', stroke: '#1a6ea8' }, // blue
	Variant: { fill: '#5fa6db', stroke: '#268bd2' },
	Trait: { fill: '#2aa198', stroke: '#1f7a73' }, // cyan
	TraitAlias: { fill: '#2aa198', stroke: '#1f7a73' },
	Impl: { fill: '#93a1a1', stroke: '#73807f' }, // base1
	Function: { fill: '#d33682', stroke: '#a82864' }, // magenta
	TypeAlias: { fill: '#b58900', stroke: '#8a6900' }, // yellow
	AssocType: { fill: '#cba434', stroke: '#b58900' },
	Constant: { fill: '#586e75', stroke: '#3f5359' }, // base01
	AssocConst: { fill: '#788e95', stroke: '#586e75' },
	Static: { fill: '#586e75', stroke: '#3f5359' },
	Macro: { fill: '#dc322f', stroke: '#b02524' }, // red
	Primitive: { fill: '#2aa198', stroke: '#1f7a73' },
	ExternCrate: { fill: '#cb4b16', stroke: '#a23a0e' },
	Import: { fill: '#93a1a1', stroke: '#73807f' },
	ProcMacro: { fill: '#dc322f', stroke: '#b02524' },
};
