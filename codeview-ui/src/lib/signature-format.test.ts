import { describe, expect, it } from 'vite-plus/test';
import type { Node, TypeRef } from '$lib/schema';
import { formatSignature } from './signature-format';

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
