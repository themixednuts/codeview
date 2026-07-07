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
 * Schema v3+ values carry `kind`; bare enum values land in the fallback.
 */
export function visibilityLabel(visibility: Visibility): string {
	const parsed = visibilityParts(visibility);
	switch (parsed.kind) {
		case 'Public':
			return 'Public';
		case 'Crate':
			return 'pub(crate)';
		case 'Restricted':
			return `pub(in ${parsed.path ?? 'Unknown'})`;
		case 'Inherited':
			return 'Inherited';
		case 'Unknown':
			return 'Unknown';
		default:
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
	return visibilityParts(visibility).kind === 'Public';
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
	const parsed = visibilityParts(visibility);
	return parsed.kind === 'Restricted' ? `Restricted:${parsed.path ?? ''}` : parsed.kind;
}

function visibilityParts(visibility: Visibility): { kind: string; path?: string } {
	const raw = visibility as unknown;
	if (typeof raw === 'string') return normalizeVisibilityKind(raw);
	if (!raw || typeof raw !== 'object') return { kind: 'Unknown' };

	const record = raw as {
		kind?: unknown;
		path?: unknown;
		restricted?: { path?: unknown } | unknown;
	};

	if (record.restricted && typeof record.restricted === 'object') {
		return {
			kind: 'Restricted',
			path: primitiveText((record.restricted as { path?: unknown }).path),
		};
	}

	const kind = primitiveText(record.kind);
	return {
		...normalizeVisibilityKind(kind ?? 'Unknown'),
		path: primitiveText(record.path),
	};
}

function normalizeVisibilityKind(kind: string): { kind: string; path?: string } {
	switch (kind) {
		case 'Public':
		case 'public':
			return { kind: 'Public' };
		case 'Crate':
		case 'crate':
			return { kind: 'Crate' };
		case 'Restricted':
		case 'restricted':
			return { kind: 'Restricted' };
		case 'Inherited':
		case 'default':
			return { kind: 'Inherited' };
		case 'Unknown':
			return { kind: 'Unknown' };
		default:
			return { kind: 'Unknown' };
	}
}

function primitiveText(value: unknown): string | undefined {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
		return String(value);
	}
	if (typeof value === 'symbol') return value.description;
	return undefined;
}

/**
 * Inverse of `visibilityKey` — reconstruct a typed Visibility from
 * its serialized string form. Used by the local SQLite cache when
 * reading visibility back out of the nodeIndex/crossNodes TEXT column.
 *
 * Unrecognised strings fall back to `{ kind: 'Unknown' }`.
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
