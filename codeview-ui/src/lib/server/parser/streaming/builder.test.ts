import { describe, expect, it } from 'vite-plus/test';
import type { Generics, Item, ItemSummary } from '../rustdoc.types';
import { createStreamingGraphBuilder } from './builder';

const EMPTY_GENERICS: Generics = {
	params: [],
	where_predicates: [],
};

function makeItem(id: number, name: string | null, inner: Item['inner']): Item {
	return {
		id,
		crate_id: 0,
		name,
		span: null,
		visibility: 'public',
		docs: null,
		links: {},
		attrs: [],
		deprecation: null,
		inner,
	};
}

function makePath(path: string[], kind: ItemSummary['kind']): ItemSummary {
	return {
		crate_id: 0,
		path,
		kind,
	};
}

describe('StreamingGraphBuilder deferred metadata', () => {
	it('hydrates enum variants when retainItemIndex is false', async () => {
		const builder = createStreamingGraphBuilder('crate', {
			retainItemIndex: false,
			skipExternalNodes: false,
		});
		const callbacks = builder.createParseCallbacks();

		callbacks.onItem(
			'2',
			makeItem(2, null, {
				struct_field: { primitive: 'usize' },
			}),
		);
		callbacks.onItem(
			'3',
			makeItem(3, null, {
				struct_field: { primitive: 'u8' },
			}),
		);
		callbacks.onItem(
			'4',
			makeItem(4, 'AllocError', {
				variant: {
					kind: { tuple: [2, 3] },
					discriminant: null,
				},
			}),
		);
		callbacks.onItem(
			'1',
			makeItem(1, 'TryReserveError', {
				enum: {
					generics: EMPTY_GENERICS,
					has_stripped_variants: false,
					variants: [4],
					impls: [],
				},
			}),
		);

		callbacks.onPath('1', makePath(['crate', 'TryReserveError'], 'enum'));
		callbacks.onComplete?.();

		const graph = await builder.finalize();
		const node = graph.nodes.find((candidate) => candidate.id === 'crate::TryReserveError');

		expect(node).toBeDefined();
		expect(node?.visibility).toEqual({ kind: 'Public' });
		expect(node?.variants).toEqual([
			{
				name: 'AllocError',
				fields: [
					{ name: '0', type_name: 'usize', visibility: { kind: 'Public' } },
					{ name: '1', type_name: 'u8', visibility: { kind: 'Public' } },
				],
			},
		]);
	});

	it('resolves deferred doc links during finalize', async () => {
		const builder = createStreamingGraphBuilder('crate', {
			retainItemIndex: false,
			skipExternalNodes: false,
		});
		const callbacks = builder.createParseCallbacks();

		const source = makeItem(10, 'source', {
			function: {
				sig: {
					inputs: [],
					output: { resolved_path: { id: 11, args: null, path: 'crate::Target' } },
					is_c_variadic: false,
				},
				generics: EMPTY_GENERICS,
				header: {
					is_const: false,
					is_unsafe: false,
					is_async: false,
					abi: 'Rust',
				},
				has_body: true,
			},
		});
		source.docs = 'See [`Target`] for details.';
		source.links = { Target: 11 };

		callbacks.onItem('10', source);
		callbacks.onItem(
			'11',
			makeItem(11, 'Target', {
				struct: {
					kind: 'unit',
					generics: EMPTY_GENERICS,
					impls: [],
				},
			}),
		);

		callbacks.onPath('10', makePath(['crate', 'source'], 'function'));
		callbacks.onPath('11', makePath(['crate', 'Target'], 'struct'));
		callbacks.onComplete?.();

		const graph = await builder.finalize();
		const sourceNode = graph.nodes.find((candidate) => candidate.id === 'crate::source');

		expect(sourceNode?.doc_links).toEqual({ Target: 'crate::Target' });
		expect(sourceNode?.signature?.output).toBe('Target');
	});
});
