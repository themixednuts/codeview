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
export function formatSignature(
	node: Pick<Node, 'name' | 'signature'>,
): FormattedSignature {
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
		case 'Union': {
			const kw = node.kind === 'Struct' ? 'struct' : 'union';
			const head = `${pub}${kw} ${node.name}${params}`;
			const body = whereSuffix ? `${whereSuffix} {}` : ' {}';
			return { inline: `${head}${body}`, multiline: `${head}${body}` };
		}
		case 'Enum': {
			const head = `${pub}enum ${node.name}${params}`;
			const body = whereSuffix ? `${whereSuffix} {}` : ' {}';
			return { inline: `${head}${body}`, multiline: `${head}${body}` };
		}
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
