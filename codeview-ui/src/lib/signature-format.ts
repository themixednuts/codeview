import type { Node } from '$lib/graph';

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
	headerParts.push(node.name);
	const header = headerParts.join(' ');

	const args = (sig?.inputs ?? []).map((a) => `${a.name}: ${a.type_name}`);
	const ret = sig?.output ? ` -> ${sig.output}` : '';

	const inline = `${header}(${args.join(', ')})${ret}`;

	const multiline =
		args.length === 0
			? `${header}()${ret}`
			: `${header}(\n${args.map((a) => `${INDENT}${a}`).join(',\n')},\n)${ret}`;

	return { inline, multiline };
}
