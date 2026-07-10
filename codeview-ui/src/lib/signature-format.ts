import type { Node, NodeKind, Visibility } from '$lib/graph';
import {
	renderGenericBound,
	renderGenericParams,
	renderTypeText,
	renderWhereClause,
} from './type-render';

/**
 * Two rendered forms of a Rust `fn` signature.
 *
 *  - `inline` — single-line form. Suitable when the available width can hold
 *    the whole signature.
 *  - `multiline` — rustfmt's "function over multiple lines" form. Header `(`
 *    on the first line, each argument indented 4 spaces on its own line with
 *    a trailing comma, closing `)` on its own line followed by `-> Return`.
 *    Matches what `cargo fmt` produces when forced to a narrower max_width.
 *
 * Callers pick which to render based on measured width (see SignatureBlock).
 */
export interface FormattedSignature {
	inline: string;
	multiline: string;
}

const INDENT = '    ';
type ItemField = NonNullable<Node['fields']>[number];
type ItemVariant = NonNullable<Node['variants']>[number];

/**
 * Format `node` as a Rust fn signature in both inline and multiline forms.
 *
 * Pure: depends only on `node.name` and `node.signature`. The returned
 * strings are valid Rust source the way `cargo fmt` would emit them —
 * a `<CodeBlock>` can pass either form straight to Shiki.
 *
 * Now consumes structured `TypeRef` argument/return types and structured
 * generics (params + where-clause) via `lib/type-render.ts`, so the
 * rendered output preserves lifetime names, mutability, generic args,
 * higher-rank bounds, etc.
 *
 * `node.signature` may be `null` (non-function nodes); in that case both
 * forms are the bare `fn <name>()` shape.
 */
export function formatSignature(node: Pick<Node, 'name' | 'signature'>): FormattedSignature {
	const sig = node.signature;
	const headerParts: string[] = [];
	if (sig?.is_const) headerParts.push('const');
	if (sig?.is_async) headerParts.push('async');
	if (sig?.is_unsafe) headerParts.push('unsafe');
	headerParts.push('fn');
	headerParts.push(node.name + renderGenericParams(sig?.generics));
	const header = headerParts.join(' ');

	const args = (sig?.inputs ?? []).map((a) => `${a.name}: ${renderTypeText(a.type)}`);
	const ret = sig?.output ? ` -> ${renderTypeText(sig.output)}` : '';
	const where = renderWhereClause(sig?.generics);
	const whereSuffix = where ? ` ${where}` : '';

	const inline = `${header}(${args.join(', ')})${ret}${whereSuffix}`;

	const multiline =
		args.length === 0
			? `${header}()${ret}${whereSuffix}`
			: `${header}(\n${args.map((a) => `${INDENT}${a}`).join(',\n')},\n)${ret}${whereSuffix}`;

	return { inline, multiline };
}

// ─── Item declarations (struct / enum / trait / type / const / …) ────────
//
// `formatSignature` covers `fn` items. `formatItemDeclaration` covers every
// other top-level item kind so the detail header can show a single canonical
// Rust declaration block (the docs.rs approach) instead of the badge-soup
// representation. Returns null for kinds with no meaningful declaration.

/** Render a `Visibility` as its source keyword, or '' when omitted. */
function visibilityPrefix(visibility: Visibility | undefined): string {
	if (!visibility) return '';
	const raw = visibility as { kind?: string; path?: string };
	switch (raw.kind) {
		case 'Public':
			return 'pub ';
		case 'Crate':
			return 'pub(crate) ';
		case 'Restricted':
			return `pub(in ${raw.path ?? 'crate'}) `;
		default:
			return '';
	}
}

function fieldDeclaration(field: ItemField, includeName: boolean): string {
	const name = includeName ? `${field.name}: ` : '';
	return `${visibilityPrefix(field.visibility)}${name}${renderTypeText(field.type)}`;
}

function isTupleFields(fields: readonly ItemField[]): boolean {
	return fields.length > 0 && fields.every((field) => /^\d+$/.test(field.name));
}

function variantDeclaration(variant: ItemVariant, multiline: boolean): string {
	if (variant.fields.length === 0) return variant.name;
	if (isTupleFields(variant.fields)) {
		return `${variant.name}(${variant.fields
			.map((field) => fieldDeclaration(field, false))
			.join(', ')})`;
	}
	if (!multiline) {
		return `${variant.name} { ${variant.fields
			.map((field) => fieldDeclaration(field, true))
			.join(', ')} }`;
	}
	return `${variant.name} {\n${variant.fields
		.map((field) => `${INDENT}${fieldDeclaration(field, true)},`)
		.join('\n')}\n}`;
}

function formatRecordDeclaration(node: Node, keyword: 'struct' | 'union'): FormattedSignature {
	const head = `${visibilityPrefix(node.visibility)}${keyword} ${node.name}${renderGenericParams(node.generics)}`;
	const where = renderWhereClause(node.generics);
	const whereBeforeBody = where ? ` ${where}` : '';
	const fields = node.fields ?? [];

	if (keyword === 'struct' && isTupleFields(fields)) {
		const inlineFields = fields.map((field) => fieldDeclaration(field, false)).join(', ');
		const multilineFields = fields
			.map((field) => `${INDENT}${fieldDeclaration(field, false)},`)
			.join('\n');
		return {
			inline: `${head}(${inlineFields})${whereBeforeBody};`,
			multiline: `${head}(\n${multilineFields}\n)${whereBeforeBody};`,
		};
	}

	const members = fields.map((field) => fieldDeclaration(field, true));
	if (node.has_stripped_fields) members.push('/* private fields */');
	if (members.length === 0) {
		return {
			inline: `${head}${whereBeforeBody} {}`,
			multiline: `${head}${whereBeforeBody} {}`,
		};
	}

	return {
		inline: `${head}${whereBeforeBody} { ${members.join(', ')} }`,
		multiline: `${head}${whereBeforeBody} {\n${members
			.map((member) => `${INDENT}${member}${member.startsWith('/*') ? '' : ','}`)
			.join('\n')}\n}`,
	};
}

function formatEnumDeclaration(node: Node): FormattedSignature {
	const head = `${visibilityPrefix(node.visibility)}enum ${node.name}${renderGenericParams(node.generics)}`;
	const where = renderWhereClause(node.generics);
	const whereBeforeBody = where ? ` ${where}` : '';
	const variants = node.variants ?? [];
	const inlineMembers = variants.map((variant) => variantDeclaration(variant, false));
	const multilineMembers = variants.map((variant) => variantDeclaration(variant, true));
	if (node.has_stripped_variants) {
		inlineMembers.push('/* private variants */');
		multilineMembers.push('/* private variants */');
	}
	if (inlineMembers.length === 0) {
		return {
			inline: `${head}${whereBeforeBody} {}`,
			multiline: `${head}${whereBeforeBody} {}`,
		};
	}

	return {
		inline: `${head}${whereBeforeBody} { ${inlineMembers.join(', ')} }`,
		multiline: `${head}${whereBeforeBody} {\n${multilineMembers
			.map(
				(member) =>
					member
						.split('\n')
						.map((line) => `${INDENT}${line}`)
						.join('\n') + (member.startsWith('/*') ? '' : ','),
			)
			.join('\n')}\n}`,
	};
}

/** Kinds that `formatItemDeclaration` knows how to render. */
const DECLARABLE_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
	'Struct',
	'Enum',
	'Union',
	'Trait',
	'TraitAlias',
	'TypeAlias',
	'Constant',
	'AssocConst',
	'Static',
	'AssocType',
	'Function',
]);

/**
 * Format `node` as a Rust item declaration in inline + multiline forms.
 *
 * For `Function`, delegates to `formatSignature`. For every other declarable
 * kind, produces the rustfmt-style header (`pub struct Foo<T> where …` etc.)
 * without the body — fields/variants live in their own dedicated sections.
 *
 * Returns `null` for kinds without a meaningful declaration (Crate, Module,
 * Impl, Import, …) so callers can skip rendering.
 */
export function formatItemDeclaration(node: Node): FormattedSignature | null {
	if (node.signature) return formatSignature(node);
	if (!DECLARABLE_KINDS.has(node.kind)) return null;

	const pub = visibilityPrefix(node.visibility);
	const generics = node.generics;
	const params = renderGenericParams(generics);
	const where = renderWhereClause(generics);
	const whereSuffix = where ? `\n${where}` : '';

	switch (node.kind) {
		case 'Struct':
			return formatRecordDeclaration(node, 'struct');
		case 'Union':
			return formatRecordDeclaration(node, 'union');
		case 'Enum':
			return formatEnumDeclaration(node);
		case 'Trait': {
			const bounds =
				node.bounds && node.bounds.length > 0
					? ': ' + node.bounds.map(renderGenericBound).join(' + ')
					: '';
			const auto = node.is_auto ? 'auto ' : '';
			const unsafe = node.is_unsafe ? 'unsafe ' : '';
			const head = `${pub}${unsafe}${auto}trait ${node.name}${params}${bounds}`;
			const body = whereSuffix ? `${whereSuffix} {}` : ' {}';
			return { inline: `${head}${body}`, multiline: `${head}${body}` };
		}
		case 'TraitAlias': {
			const bounds =
				node.bounds && node.bounds.length > 0
					? node.bounds.map(renderGenericBound).join(' + ')
					: '_';
			const head = `${pub}trait ${node.name}${params} = ${bounds}`;
			return { inline: head, multiline: head };
		}
		case 'TypeAlias': {
			const ty = node.type ? ` = ${renderTypeText(node.type)}` : '';
			const head = `${pub}type ${node.name}${params}${ty};`;
			return { inline: head, multiline: head };
		}
		case 'AssocType': {
			const bounds =
				node.bounds && node.bounds.length > 0
					? ': ' + node.bounds.map(renderGenericBound).join(' + ')
					: '';
			const ty = node.type ? ` = ${renderTypeText(node.type)}` : '';
			const head = `type ${node.name}${params}${bounds}${ty};`;
			return { inline: head, multiline: head };
		}
		case 'Constant':
		case 'AssocConst': {
			const ty = node.type ? renderTypeText(node.type) : '_';
			const val = node.const_value ? ` = ${node.const_value}` : '';
			const head = `${pub}const ${node.name}: ${ty}${val};`;
			return { inline: head, multiline: head };
		}
		case 'Static': {
			const mut = node.is_mutable ? 'mut ' : '';
			const ty = node.type ? renderTypeText(node.type) : '_';
			const val = node.const_value ? ` = ${node.const_value}` : '';
			const head = `${pub}static ${mut}${node.name}: ${ty}${val};`;
			return { inline: head, multiline: head };
		}
		default:
			return null;
	}
}
