import { describe, expect, it } from 'vite-plus/test';
import type { Node, TypeRef, Visibility } from '$lib/schema';
import { formatItemDeclaration, formatSignature } from './signature-format';

type Sig = NonNullable<Node['signature']>;

function prim(name: string): TypeRef {
	return { kind: 'Primitive', name };
}

function fn(name: string, overrides: Partial<Sig> = {}): Pick<Node, 'name' | 'signature'> {
	return {
		name,
		signature: {
			inputs: [],
			is_async: false,
			is_const: false,
			is_unsafe: false,
			output: null,
			...overrides,
		},
	};
}

const pub: Visibility = { kind: 'Public' };
const crateVis: Visibility = { kind: 'Crate' };

describe('formatSignature', () => {
	it('joins args with comma+space in inline form', () => {
		const { inline } = formatSignature(
			fn('insert', {
				inputs: [
					{ name: 'index', type: prim('usize') },
					{ name: 'element', type: { kind: 'Generic', name: 'T' } },
				],
				output: prim('()'),
			}),
		);
		expect(inline).toBe('fn insert(index: usize, element: T) -> ()');
	});

	it('indents each arg 4 spaces with trailing comma in multiline form', () => {
		const { multiline } = formatSignature(
			fn('from_parts_in', {
				inputs: [
					{
						name: 'ptr',
						type: {
							kind: 'ResolvedPath',
							id: '0',
							path: 'NonNull',
							args: {
								kind: 'AngleBracketed',
								args: [{ kind: 'Type', value: { kind: 'Generic', name: 'T' } }],
								constraints: [],
							},
						},
					},
					{ name: 'length', type: prim('usize') },
					{ name: 'capacity', type: prim('usize') },
					{ name: 'alloc', type: { kind: 'Generic', name: 'A' } },
				],
				output: { kind: 'Generic', name: 'Self' },
				is_const: true,
				is_unsafe: true,
			}),
		);
		expect(multiline).toBe(
			[
				'const unsafe fn from_parts_in(',
				'    ptr: NonNull<T>,',
				'    length: usize,',
				'    capacity: usize,',
				'    alloc: A,',
				') -> Self',
			].join('\n'),
		);
	});

	it('keeps zero-arg function on one line in both forms', () => {
		const { inline, multiline } = formatSignature(fn('new'));
		expect(inline).toBe('fn new()');
		expect(multiline).toBe('fn new()');
	});

	it('emits modifiers in const → async → unsafe order', () => {
		const { inline } = formatSignature(
			fn('do_it', { is_const: true, is_async: true, is_unsafe: true }),
		);
		expect(inline).toBe('const async unsafe fn do_it()');
	});

	it('omits the `-> Return` clause when output is absent', () => {
		const { inline } = formatSignature(
			fn('do_it', { inputs: [{ name: 'self', type: { kind: 'Generic', name: 'Self' } }] }),
		);
		expect(inline).toBe('fn do_it(self: Self)');
	});

	it('handles a null signature (non-function node) with bare fn form', () => {
		const { inline, multiline } = formatSignature({ name: 'Foo', signature: null });
		expect(inline).toBe('fn Foo()');
		expect(multiline).toBe('fn Foo()');
	});

	it('renders borrowed-ref types structurally with lifetime + mut', () => {
		const { inline } = formatSignature(
			fn('push', {
				inputs: [
					{
						name: 'self',
						type: {
							kind: 'BorrowedRef',
							lifetime: null,
							mutable: true,
							inner: { kind: 'Generic', name: 'Self' },
						},
					},
					{
						name: 'value',
						type: {
							kind: 'BorrowedRef',
							lifetime: "'a",
							mutable: false,
							inner: prim('str'),
						},
					},
				],
				output: prim('()'),
			}),
		);
		expect(inline).toBe("fn push(self: &mut Self, value: &'a str) -> ()");
	});
});

describe('formatItemDeclaration', () => {
	function node(partial: Partial<Node> & { name: string; kind: Node['kind'] }): Node {
		return {
			...partial,
			id: partial.id ?? partial.name,
			attrs: partial.attrs ?? [],
			visibility: partial.visibility ?? pub,
		} as Node;
	}

	it('returns null for kinds without a declaration', () => {
		expect(formatItemDeclaration(node({ name: 'my_crate', kind: 'Crate' }))).toBeNull();
		expect(formatItemDeclaration(node({ name: 'foo', kind: 'Module' }))).toBeNull();
	});

	it('renders a pub struct declaration with generics + where', () => {
		const result = formatItemDeclaration(
			node({
				name: 'Vec',
				kind: 'Struct',
				visibility: pub,
				generics: {
					params: [{ name: 'T', kind: { kind: 'Type', bounds: [] } }],
					where_predicates: [],
				},
			}),
		);
		expect(result?.inline).toBe('pub struct Vec<T> {}');
	});

	it('renders a pub(crate) enum declaration', () => {
		const result = formatItemDeclaration(
			node({ name: 'Color', kind: 'Enum', visibility: crateVis }),
		);
		expect(result?.inline).toBe('pub(crate) enum Color {}');
	});

	it('renders an unsafe auto trait with supertrait bounds', () => {
		const result = formatItemDeclaration(
			node({
				name: 'Send',
				kind: 'Trait',
				is_unsafe: true,
				is_auto: true,
				bounds: [
					{ kind: 'Trait', trait: { kind: 'ResolvedPath', id: 'Sized', path: 'Sized' }, modifier: 'none' },
				],
			}),
		);
		expect(result?.inline).toBe('pub unsafe auto trait Send: Sized {}');
	});

	it('renders a type alias', () => {
		const result = formatItemDeclaration(
			node({
				name: 'Result',
				kind: 'TypeAlias',
				visibility: pub,
				generics: {
					params: [
						{ name: 'T', kind: { kind: 'Type', bounds: [] } },
						{ name: 'E', kind: { kind: 'Type', bounds: [] } },
					],
					where_predicates: [],
				},
				type: { kind: 'ResolvedPath', id: 'std::result::Result', path: 'Result' },
			}),
		);
		expect(result?.inline).toBe('pub type Result<T, E> = Result;');
	});

	it('renders a const', () => {
		const result = formatItemDeclaration(
			node({
				name: 'MAX',
				kind: 'Constant',
				visibility: pub,
				type: prim('usize'),
				const_value: '100',
			}),
		);
		expect(result?.inline).toBe('pub const MAX: usize = 100;');
	});

	it('renders a static mut', () => {
		const result = formatItemDeclaration(
			node({
				name: 'COUNTER',
				kind: 'Static',
				visibility: pub,
				is_mutable: true,
				type: prim('u64'),
			}),
		);
		expect(result?.inline).toBe('pub static mut COUNTER: u64;');
	});

	it('delegates to formatSignature for function nodes', () => {
		const result = formatItemDeclaration(
			node({
				name: 'push',
				kind: 'Function',
				visibility: pub,
				signature: {
					inputs: [],
					is_async: false,
					is_const: false,
					is_unsafe: false,
					output: null,
				},
			}),
		);
		expect(result?.inline).toBe('fn push()');
	});
});
