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
	ProcMacro: 'Proc macro',
};

/**
 * Render a Visibility as a Rust source-like label.
 *
 * The `Restricted` variant carries the actual restriction path so we can
 * show `pub(in crate::foo::bar)` instead of a generic "Restricted" badge.
 * Schema v3+; legacy artifacts pre-bump deserialised as the bare enum
 * value (no `kind`) and would land in the fallback.
 */
export function visibilityLabel(visibility: Visibility): string {
	switch (visibility.kind) {
		case 'Public':
			return 'Public';
		case 'Crate':
			return 'pub(crate)';
		case 'Restricted':
			return `pub(in ${visibility.path})`;
		case 'Inherited':
			return 'Inherited';
		case 'Unknown':
			return 'Unknown';
	}
}

/**
 * Convenience predicate for "is this item exposed publicly?".
 * Centralises the comparison so every consumer survives future
 * additions to the Visibility tagged union (e.g. a hypothetical
 * `PubSuper` variant) by failing closed.
 */
export function isPublic(visibility: Visibility): boolean {
	return visibility.kind === 'Public';
}

/**
 * Canonical string representation of a Visibility, suitable for
 * equality comparisons, Map/Set keys, and TEXT-column storage in the
 * local SQLite cache. The tagged-union shape means `a === b` checks
 * identity (always false for two freshly constructed `{ kind: 'Public' }`
 * objects), so consumers that need value equality compare
 * `visibilityKey(a) === visibilityKey(b)` instead.
 *
 * Format:
 *   "Public" | "Crate" | "Inherited" | "Unknown" | "Restricted:<path>"
 *
 * Round-trip safe with `parseVisibilityKey()` for all variants.
 */
export function visibilityKey(visibility: Visibility): string {
	return visibility.kind === 'Restricted'
		? `Restricted:${visibility.path}`
		: visibility.kind;
}

/**
 * Inverse of `visibilityKey` — reconstruct a typed Visibility from
 * its serialized string form. Used by the local SQLite cache when
 * reading visibility back out of the nodeIndex/crossNodes TEXT column.
 *
 * Unrecognised strings fall back to `{ kind: 'Unknown' }` — keeps
 * legacy v2 artifacts (which stored bare 'Public' etc.) readable
 * via this same path.
 */
export function parseVisibilityKey(key: string): Visibility {
	if (key === 'Public') return { kind: 'Public' };
	if (key === 'Crate') return { kind: 'Crate' };
	if (key === 'Inherited') return { kind: 'Inherited' };
	if (key.startsWith('Restricted:')) {
		return { kind: 'Restricted', path: key.slice('Restricted:'.length) };
	}
	return { kind: 'Unknown' };
}

export const edgeLabels: Record<EdgeKind, string> = {
	Contains: 'Contains',
	Defines: 'Defines',
	UsesType: 'Uses type',
	Implements: 'Implements',
	CallsStatic: 'Calls',
	CallsRuntime: 'Runtime calls',
	Derives: 'Derives',
	ReExports: 'Re-exports',
};

export const nodeKindOrder: NodeKind[] = [
	'Crate',
	'Module',
	'TypeAlias',
	'Struct',
	'StructField',
	'Enum',
	'Variant',
	'Union',
	'Function',
	'AssocType',
	'Constant',
	'AssocConst',
	'Static',
	'Macro',
	'ProcMacro',
	'Primitive',
	'ExternCrate',
	'Import',
	'Impl',
	'Trait',
	'TraitAlias',
];
