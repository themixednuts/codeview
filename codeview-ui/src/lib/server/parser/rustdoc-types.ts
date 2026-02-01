/**
 * TypeScript types for the rustdoc JSON format (v35–v57+).
 *
 * Generated from the canonical rustdoc-types Rust crate:
 *   https://github.com/rust-lang/rust/blob/master/src/rustdoc-json-types/lib.rs
 *
 * These types use tagged-object discriminated unions matching the serde JSON
 * representation of Rust enums (e.g. `{"resolved_path": {...}}`).
 */

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export interface RustdocCrate {
	root: Id;
	crate_version: string | null;
	includes_private: boolean;
	index: Record<string, Item>;
	paths: Record<string, ItemSummary>;
	external_crates: Record<string, ExternalCrate>;
	format_version: number;
	// v44+
	target?: Target;
}

// Opaque identifier — only valid within a single JSON blob
export type Id = number;

export interface Target {
	triple: string;
	target_features: TargetFeature[];
}

export interface TargetFeature {
	name: string;
	implies_features: string[];
	unstable_feature_gate: string | null;
	globally_enabled: boolean;
}

export interface ExternalCrate {
	name: string;
	html_root_url: string | null;
	// v57+
	path?: string;
}

// ---------------------------------------------------------------------------
// Item
// ---------------------------------------------------------------------------

export interface Item {
	id: Id;
	crate_id: number;
	name: string | null;
	span: Span | null;
	visibility: Visibility;
	docs: string | null;
	links: Record<string, Id>;
	attrs: Attribute[];
	deprecation: Deprecation | null;
	inner: ItemEnum;
}

export interface Span {
	filename: string;
	begin: [number, number]; // [line, column] 1-indexed
	end: [number, number];
}

export interface Deprecation {
	since: string | null;
	note: string | null;
}

// ---------------------------------------------------------------------------
// Visibility (tagged enum)
// ---------------------------------------------------------------------------

export type Visibility =
	| 'public'
	| 'default'
	| 'crate'
	| { restricted: { parent: Id; path: string } };

// ---------------------------------------------------------------------------
// Attribute (tagged enum, v54+; pre-v54 uses plain strings)
// ---------------------------------------------------------------------------

export type Attribute =
	| 'non_exhaustive'
	| 'automatically_derived'
	| 'macro_export'
	| 'no_mangle'
	| { must_use: { reason: string | null } }
	| { export_name: string }
	| { link_section: string }
	| { repr: AttributeRepr }
	| { target_feature: { enable: string[] } }
	| { other: string }
	// Pre-v54: plain strings
	| string;

export interface AttributeRepr {
	kind: ReprKind;
	align: number | null;
	packed: number | null;
	int: string | null;
}

export type ReprKind = 'rust' | 'c' | 'transparent' | 'simd';

// ---------------------------------------------------------------------------
// ItemEnum (tagged object: {"struct": {...}}, {"function": {...}}, etc.)
// ---------------------------------------------------------------------------

export type ItemEnum =
	| { module: Module }
	| { extern_crate: { name: string; rename: string | null } }
	| { use: Use }
	| { struct: Struct }
	| { struct_field: Type }
	| { union: Union }
	| { enum: Enum }
	| { variant: Variant }
	| { function: FunctionItem }
	| { trait: Trait }
	| { trait_alias: TraitAlias }
	| { impl: Impl }
	| { type_alias: TypeAlias }
	| { constant: { type_: Type; const_: Constant } }
	| { static: Static }
	| { extern_type: Record<string, never> }
	| { macro: string }
	| { proc_macro: ProcMacro }
	| { primitive: Primitive }
	| { assoc_const: { type_: Type; value: string | null } }
	| { assoc_type: { generics: Generics; bounds: GenericBound[]; type_: Type | null } };

// ---------------------------------------------------------------------------
// ItemKind (string enum, used in paths)
// ---------------------------------------------------------------------------

export type ItemKind =
	| 'module'
	| 'extern_crate'
	| 'use'
	| 'struct'
	| 'struct_field'
	| 'union'
	| 'enum'
	| 'variant'
	| 'function'
	| 'type_alias'
	| 'constant'
	| 'trait'
	| 'trait_alias'
	| 'impl'
	| 'static'
	| 'extern_type'
	| 'macro'
	| 'proc_attribute'
	| 'proc_derive'
	| 'assoc_const'
	| 'assoc_type'
	| 'primitive'
	| 'keyword'
	| 'attribute';

export interface ItemSummary {
	crate_id: number;
	path: string[];
	kind: ItemKind;
}

// ---------------------------------------------------------------------------
// Module, Use
// ---------------------------------------------------------------------------

export interface Module {
	is_crate: boolean;
	items: Id[];
	is_stripped: boolean;
}

export interface Use {
	source: string;
	name: string;
	id: Id | null;
	is_glob: boolean;
}

// ---------------------------------------------------------------------------
// Structs, Enums, Unions
// ---------------------------------------------------------------------------

export interface Struct {
	kind: StructKind;
	generics: Generics;
	impls: Id[];
}

export type StructKind =
	| 'unit'
	| { tuple: (Id | null)[] }
	| { plain: { fields: Id[]; has_stripped_fields: boolean } };

export interface Union {
	generics: Generics;
	has_stripped_fields: boolean;
	fields: Id[];
	impls: Id[];
}

export interface Enum {
	generics: Generics;
	has_stripped_variants: boolean;
	variants: Id[];
	impls: Id[];
}

export interface Variant {
	kind: VariantKind;
	discriminant: Discriminant | null;
}

export type VariantKind =
	| 'plain'
	| { tuple: (Id | null)[] }
	| { struct: { fields: Id[]; has_stripped_fields: boolean } };

export interface Discriminant {
	expr: string;
	value: string;
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

export interface FunctionItem {
	sig: FunctionSignature;
	generics: Generics;
	header: FunctionHeader;
	has_body: boolean;
}

export interface FunctionSignature {
	inputs: [string, Type][];
	output: Type | null;
	is_c_variadic: boolean;
}

export interface FunctionHeader {
	is_const: boolean;
	is_unsafe: boolean;
	is_async: boolean;
	abi: string;
}

// ---------------------------------------------------------------------------
// Traits, Impls
// ---------------------------------------------------------------------------

export interface Trait {
	is_auto: boolean;
	is_unsafe: boolean;
	is_dyn_compatible: boolean;
	items: Id[];
	generics: Generics;
	bounds: GenericBound[];
	implementations: Id[];
}

export interface TraitAlias {
	generics: Generics;
	params: GenericBound[];
}

export interface Impl {
	is_unsafe: boolean;
	generics: Generics;
	provided_trait_methods: string[];
	trait_: Path | null;
	for_: Type;
	items: Id[];
	is_negative: boolean;
	is_synthetic: boolean;
	blanket_impl: Type | null;
}

// ---------------------------------------------------------------------------
// TypeAlias, Static, Constant
// ---------------------------------------------------------------------------

export interface TypeAlias {
	type_: Type;
	generics: Generics;
}

export interface Static {
	type_: Type;
	is_mutable: boolean;
	expr: string;
	is_unsafe: boolean;
}

export interface Constant {
	expr: string;
	value: string | null;
	is_literal: boolean;
}

// ---------------------------------------------------------------------------
// Proc macros, Primitives
// ---------------------------------------------------------------------------

export interface ProcMacro {
	kind: 'bang' | 'attr' | 'derive';
	helpers: string[];
}

export interface Primitive {
	name: string;
	impls: Id[];
}

// ---------------------------------------------------------------------------
// Type (tagged union: {"resolved_path": {...}}, {"generic": "T"}, etc.)
// ---------------------------------------------------------------------------

export type Type =
	| { resolved_path: Path }
	| { dyn_trait: DynTrait }
	| { generic: string }
	| { primitive: string }
	| { function_pointer: FunctionPointer }
	| { tuple: Type[] }
	| { slice: Type }
	| { array: { type_: Type; len: string } }
	| { pat: { type_: Type; __pat_unstable_do_not_use: string } }
	| { impl_trait: GenericBound[] }
	| 'infer'
	| { raw_pointer: { is_mutable: boolean; type_: Type } }
	| { borrowed_ref: { lifetime: string | null; is_mutable: boolean; type_: Type } }
	| { qualified_path: { name: string; args: GenericArgs | null; self_type: Type; trait_: Path | null } };

export interface Path {
	path: string;
	id: Id;
	args: GenericArgs | null;
}

export interface DynTrait {
	traits: PolyTrait[];
	lifetime: string | null;
}

export interface PolyTrait {
	trait_: Path;
	generic_params: GenericParamDef[];
}

export interface FunctionPointer {
	sig: FunctionSignature;
	generic_params: GenericParamDef[];
	header: FunctionHeader;
}

// ---------------------------------------------------------------------------
// Generics
// ---------------------------------------------------------------------------

export interface Generics {
	params: GenericParamDef[];
	where_predicates: WherePredicate[];
}

export interface GenericParamDef {
	name: string;
	kind: GenericParamDefKind;
}

export type GenericParamDefKind =
	| { lifetime: { outlives: string[] } }
	| { type: { bounds: GenericBound[]; default: Type | null; is_synthetic: boolean } }
	| { const: { type_: Type; default: string | null } };

export type WherePredicate =
	| { bound_predicate: { type_: Type; bounds: GenericBound[]; generic_params: GenericParamDef[] } }
	| { lifetime_predicate: { lifetime: string; outlives: string[] } }
	| { eq_predicate: { lhs: Type; rhs: Term } };

export type GenericBound =
	| { trait_bound: { trait_: Path; generic_params: GenericParamDef[]; modifier: TraitBoundModifier } }
	| { outlives: string }
	| { use: PreciseCapturingArg[] };

export type TraitBoundModifier = 'none' | 'maybe' | 'maybe_const';

export type PreciseCapturingArg =
	| { lifetime: string }
	| { param: string };

export type GenericArgs =
	| { angle_bracketed: { args: GenericArg[]; constraints: AssocItemConstraint[] } }
	| { parenthesized: { inputs: Type[]; output: Type | null } }
	| 'return_type_notation';

export type GenericArg =
	| { type: Type }
	| { lifetime: string }
	| { const: Constant }
	| 'infer';

export interface AssocItemConstraint {
	name: string;
	args: GenericArgs | null;
	binding: AssocItemConstraintKind;
}

export type AssocItemConstraintKind =
	| { equality: Term }
	| { constraint: GenericBound[] };

export type Term =
	| { type: Type }
	| { constant: Constant };

// ---------------------------------------------------------------------------
// Helpers for discriminated union access
// ---------------------------------------------------------------------------

/** Get the tag key of a tagged object union (the first own key). */
export function tagOf(obj: unknown): string | undefined {
	if (typeof obj === 'string') return obj;
	if (obj && typeof obj === 'object') {
		const keys = Object.keys(obj);
		return keys.length > 0 ? keys[0] : undefined;
	}
	return undefined;
}

/** Get the value of a tagged object union. */
export function valueOf<T>(obj: unknown): T {
	if (typeof obj === 'string') return obj as T;
	if (obj && typeof obj === 'object') {
		const keys = Object.keys(obj);
		return (obj as Record<string, T>)[keys[0]];
	}
	return obj as T;
}
