import { describe, expect, test } from 'vitest';
import type { Edge, Node, NodeViewBase } from '$lib/schema';
import { mergeTraitMemberDocumentation } from './trait-member-hydration';

function node(id: string, name: string, kind: Node['kind'], extra: Partial<Node> = {}): Node {
	return {
		id,
		name,
		kind,
		visibility: { kind: 'Public' },
		span: null,
		attrs: [],
		is_external: false,
		is_deprecated: false,
		is_unsafe: false,
		is_auto: false,
		is_mutable: false,
		is_stripped: false,
		has_stripped_fields: false,
		has_stripped_variants: false,
		generics: { params: [], where_predicates: [] },
		bounds: [],
		is_glob: false,
		proc_macro_helpers: [],
		...extra,
	};
}

function edge(from: string, to: string): Edge {
	return { from, to, kind: 'Defines', confidence: 'Static', occurrences: [], is_glob: false };
}

describe('trait member documentation hydration', () => {
	test('inherits docs and materializes provided default methods', () => {
		const implNode = node('demo::impl-1', 'impl Clone for Thing', 'Impl', {
			impl_trait: 'core::clone::Clone',
			impl_category: 'Trait',
			provided_trait_methods: ['clone_from'],
		});
		const clone = node('demo::impl-1::clone', 'clone', 'Function', {
			parent_impl: implNode.id,
		});
		const view: NodeViewBase = {
			detail: {
				node: node('demo::Thing', 'Thing', 'Struct'),
				edges: [edge('demo::Thing', implNode.id), edge(implNode.id, clone.id)],
				relatedNodes: [implNode, clone],
			},
			ancestors: [],
		};
		const traitClone = node('core::clone::Clone::clone', 'clone', 'Function', {
			docs: 'Returns a duplicate of the value.',
		});
		const cloneFrom = node('core::clone::Clone::clone_from', 'clone_from', 'Function', {
			docs: 'Performs copy-assignment from source.',
		});
		const traitView: NodeViewBase = {
			detail: {
				node: node('core::clone::Clone', 'Clone', 'Trait'),
				edges: [
					edge('core::clone::Clone', traitClone.id),
					edge('core::clone::Clone', cloneFrom.id),
				],
				relatedNodes: [traitClone, cloneFrom],
			},
			ancestors: [],
		};

		const hydrated = mergeTraitMemberDocumentation(
			view,
			new Map([['core::clone::Clone', traitView]]),
		);
		const members = hydrated.detail.relatedNodes.filter((item) => item.kind === 'Function');

		expect(members.find((item) => item.name === 'clone')?.docs).toBe(
			'Returns a duplicate of the value.',
		);
		expect(members.find((item) => item.name === 'clone_from')?.docs).toBe(
			'Performs copy-assignment from source.',
		);
		expect(
			hydrated.detail.edges.some(
				(item) => item.from === implNode.id && item.to === cloneFrom.id,
			),
		).toBe(true);
	});
});
