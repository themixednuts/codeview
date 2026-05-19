/**
 * Render structured `TypeRef` / `Generics` / `GenericBound` trees back
 * to their canonical Rust source forms.
 *
 * Used wherever the UI needs to display a type expression — function
 * signatures, field types, where-clauses, trait bounds, etc. Mirrors the
 * shape the rustdoc-types `Type` enum would print to, with no string
 * stringification at the parser level (everything stays structured all
 * the way through the schema).
 *
 * Pure functions, no Svelte runtime — unit-testable in vitest.
 *
 * `renderTypeText` produces a plain string suitable for code blocks.
 * For HTML rendering with intra-doc links, see `renderTypeHtml` (TODO,
 * pending the URL-resolver shape).
 */

import type {
	AssocItemConstraint,
	FunctionPointerSig,
	GenericArg,
	GenericArgs,
	GenericBound,
	GenericParam,
	GenericParamKind,
	Generics,
	PolyTrait,
	Term,
	TraitBoundModifier,
	TypeRef,
	WherePredicate,
} from '$lib/generated/codeview-schema';

/** Render a `TypeRef` as the Rust source text it represents. */
export function renderTypeText(t: TypeRef): string {
	switch (t.kind) {
		case 'ResolvedPath': {
			const path = pathDisplay(t.path);
			const args = t.args ? renderGenericArgs(t.args) : '';
			return `${path}${args}`;
		}
		case 'DynTrait': {
			const traits = t.traits.map(renderPolyTrait).join(' + ');
			const lifetime = t.lifetime ? ` + ${t.lifetime}` : '';
			return `dyn ${traits}${lifetime}`;
		}
		case 'Generic':
			return t.name;
		case 'Primitive':
			return t.name;
		case 'BorrowedRef': {
			const lt = t.lifetime ? `${t.lifetime} ` : '';
			const mut = t.mutable ? 'mut ' : '';
			return `&${lt}${mut}${renderTypeText(t.inner)}`;
		}
		case 'Tuple': {
			if (t.elements.length === 1) return `(${renderTypeText(t.elements[0])},)`;
			return `(${t.elements.map(renderTypeText).join(', ')})`;
		}
		case 'Slice':
			return `[${renderTypeText(t.element)}]`;
		case 'Array':
			return `[${renderTypeText(t.element)}; ${t.len}]`;
		case 'ImplTrait':
			return `impl ${t.bounds.map(renderGenericBound).join(' + ')}`;
		case 'RawPointer': {
			const mut = t.mutable ? 'mut' : 'const';
			return `*${mut} ${renderTypeText(t.inner)}`;
		}
		case 'QualifiedPath': {
			const self = renderTypeText(t.self_type);
			const args = t.args ? renderGenericArgs(t.args) : '';
			if (t.trait) {
				return `<${self} as ${renderTypeText(t.trait)}>::${t.name}${args}`;
			}
			return `<${self}>::${t.name}${args}`;
		}
		case 'FunctionPointer':
			return renderFunctionPointer(t.sig);
		case 'Infer':
			return '_';
		case 'Pat':
			return `${renderTypeText(t.base)} is ${t.pat}`;
	}
}

/** Path display: prefer the rightmost segment ("Vec" over "std::vec::Vec"). */
function pathDisplay(path: string): string {
	// Keep multi-segment paths unless they're well-known prelude items.
	const segments = path.split('::');
	return segments[segments.length - 1] ?? path;
}

function renderPolyTrait(p: PolyTrait): string {
	const hrtb = p.hrtb_params && p.hrtb_params.length > 0
		? `for<${p.hrtb_params.map(renderGenericParam).join(', ')}> `
		: '';
	return `${hrtb}${renderTypeText(p.trait)}`;
}

export function renderGenericArgs(args: GenericArgs): string {
	switch (args.kind) {
		case 'AngleBracketed': {
			const parts: string[] = [];
			for (const a of args.args) parts.push(renderGenericArg(a));
			if (args.constraints) {
				for (const c of args.constraints) parts.push(renderAssocConstraint(c));
			}
			if (parts.length === 0) return '';
			return `<${parts.join(', ')}>`;
		}
		case 'Parenthesized': {
			const inputs = args.inputs.map(renderTypeText).join(', ');
			const output = args.output ? ` -> ${renderTypeText(args.output)}` : '';
			return `(${inputs})${output}`;
		}
		case 'ReturnTypeNotation':
			return '(..)';
	}
}

function renderGenericArg(arg: GenericArg): string {
	switch (arg.kind) {
		case 'Lifetime':
			return arg.name;
		case 'Type':
			return renderTypeText(arg.value);
		case 'Const':
			return arg.expr;
		case 'Infer':
			return '_';
	}
}

function renderAssocConstraint(c: AssocItemConstraint): string {
	const args = c.args ? renderGenericArgs(c.args) : '';
	if (c.binding.kind === 'Equality') {
		return `${c.name}${args} = ${renderTerm(c.binding.value)}`;
	}
	const bounds = c.binding.bounds.map(renderGenericBound).join(' + ');
	return bounds ? `${c.name}${args}: ${bounds}` : `${c.name}${args}`;
}

function renderTerm(term: Term): string {
	return term.kind === 'Type' ? renderTypeText(term.value) : term.expr;
}

function renderFunctionPointer(sig: FunctionPointerSig): string {
	const hrtb = sig.hrtb_params && sig.hrtb_params.length > 0
		? `for<${sig.hrtb_params.map(renderGenericParam).join(', ')}> `
		: '';
	const unsafe = sig.is_unsafe ? 'unsafe ' : '';
	const abi = sig.abi ? `extern "${sig.abi}" ` : '';
	const inputs = sig.inputs
		.map((i) => (i.name ? `${i.name}: ${renderTypeText(i.type)}` : renderTypeText(i.type)))
		.join(', ');
	const variadic = sig.is_c_variadic ? (sig.inputs.length ? ', ...' : '...') : '';
	const output = sig.output ? ` -> ${renderTypeText(sig.output)}` : '';
	return `${hrtb}${unsafe}${abi}fn(${inputs}${variadic})${output}`;
}

// ─── Bounds + Generics ────────────────────────────────────────────

export function renderGenericBound(bound: GenericBound): string {
	switch (bound.kind) {
		case 'Trait': {
			const mod = modifierPrefix(bound.modifier);
			const hrtb =
				bound.hrtb_params && bound.hrtb_params.length > 0
					? `for<${bound.hrtb_params.map(renderGenericParam).join(', ')}> `
					: '';
			return `${hrtb}${mod}${renderTypeText(bound.trait)}`;
		}
		case 'Outlives':
			return bound.lifetime;
		case 'Use':
			return `use<${bound.captures
				.map((c) => (c.kind === 'Lifetime' ? c.name : c.name))
				.join(', ')}>`;
	}
}

function modifierPrefix(m: TraitBoundModifier): string {
	switch (m) {
		case 'none':
			return '';
		case 'maybe':
			return '?';
		case 'maybe_const':
			return '~const ';
	}
}

export function renderGenericParam(param: GenericParam): string {
	const kind: GenericParamKind = param.kind;
	switch (kind.kind) {
		case 'Lifetime': {
			const outlives = kind.outlives && kind.outlives.length > 0 ? `: ${kind.outlives.join(' + ')}` : '';
			return `${param.name}${outlives}`;
		}
		case 'Type': {
			const bounds = kind.bounds && kind.bounds.length > 0
				? `: ${kind.bounds.map(renderGenericBound).join(' + ')}`
				: '';
			const def = kind.default ? ` = ${renderTypeText(kind.default)}` : '';
			return `${param.name}${bounds}${def}`;
		}
		case 'Const': {
			const def = kind.default ? ` = ${kind.default}` : '';
			return `const ${param.name}: ${renderTypeText(kind.type)}${def}`;
		}
	}
}

export function renderWherePredicate(pred: WherePredicate): string {
	switch (pred.kind) {
		case 'Bound': {
			const hrtb = pred.hrtb_params && pred.hrtb_params.length > 0
				? `for<${pred.hrtb_params.map(renderGenericParam).join(', ')}> `
				: '';
			return `${hrtb}${renderTypeText(pred.type)}: ${pred.bounds.map(renderGenericBound).join(' + ')}`;
		}
		case 'Lifetime':
			return `${pred.lifetime}: ${pred.outlives.join(' + ')}`;
		case 'Eq':
			return `${renderTypeText(pred.lhs)} = ${renderTerm(pred.rhs)}`;
	}
}

/**
 * Render the `<…>` portion of a generic-param list (item declaration).
 * Returns the empty string if no params.
 */
export function renderGenericParams(g: Generics | null | undefined): string {
	if (!g?.params || g.params.length === 0) return '';
	return `<${g.params.map(renderGenericParam).join(', ')}>`;
}

/**
 * Render the `where ...` clause for an item's generics. Returns the
 * empty string if no predicates. Caller decides how to space + line-wrap.
 */
export function renderWhereClause(g: Generics | null | undefined): string {
	if (!g?.where_predicates || g.where_predicates.length === 0) return '';
	return `where ${g.where_predicates.map(renderWherePredicate).join(', ')}`;
}

/**
 * Walk a `TypeRef` and collect the (display, id) pairs for every
 * `ResolvedPath`. Lets UI components produce link badges without having
 * to recurse manually. The display string is the path's rightmost
 * segment.
 */
export function collectResolvedRefs(t: TypeRef): Array<{ display: string; id: string }> {
	const out: Array<{ display: string; id: string }> = [];
	function walk(node: TypeRef): void {
		switch (node.kind) {
			case 'ResolvedPath':
				out.push({ display: pathDisplay(node.path), id: node.id });
				if (node.args) walkArgs(node.args);
				break;
			case 'DynTrait':
				for (const trait of node.traits) walk(trait.trait);
				break;
			case 'BorrowedRef':
			case 'RawPointer':
			case 'Slice':
				walk(node.kind === 'Slice' ? node.element : node.inner);
				break;
			case 'Tuple':
				for (const e of node.elements) walk(e);
				break;
			case 'Array':
				walk(node.element);
				break;
			case 'ImplTrait':
				for (const b of node.bounds) walkBound(b);
				break;
			case 'QualifiedPath':
				walk(node.self_type);
				if (node.trait) walk(node.trait);
				if (node.args) walkArgs(node.args);
				break;
			case 'FunctionPointer':
				for (const i of node.sig.inputs) walk(i.type);
				if (node.sig.output) walk(node.sig.output);
				break;
			case 'Pat':
				walk(node.base);
				break;
			case 'Generic':
			case 'Primitive':
			case 'Infer':
				break;
		}
	}
	function walkArgs(args: GenericArgs): void {
		if (args.kind === 'AngleBracketed') {
			for (const a of args.args) if (a.kind === 'Type') walk(a.value);
			if (args.constraints) {
				for (const c of args.constraints) {
					if (c.binding.kind === 'Equality') {
						if (c.binding.value.kind === 'Type') walk(c.binding.value.value);
					} else {
						for (const b of c.binding.bounds) walkBound(b);
					}
				}
			}
		} else if (args.kind === 'Parenthesized') {
			for (const i of args.inputs) walk(i);
			if (args.output) walk(args.output);
		}
	}
	function walkBound(b: GenericBound): void {
		if (b.kind === 'Trait') walk(b.trait);
	}
	walk(t);
	return out;
}
