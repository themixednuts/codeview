import { describe, expect, it } from 'vitest';
import type { Node, NodeDetail, NodeKind } from '$lib/schema';
import { buildDetailDocModel, materializeDetailDocModel } from './detail-model';

const visibility = { kind: 'Public' } as const;

function node(id: string, name: string, kind: NodeKind, extra: Partial<Node> = {}): Node {
	return {
		id,
		name,
		kind,
		visibility,
		attrs: [],
		...extra,
	};
}

describe('detail doc model', () => {
	it('keeps source trait impl members separate from inherent methods and blanket impls', () => {
		const selected = node('demo::Widget', 'Widget', 'Struct');
		const inherentImpl = node('demo::Widget::impl-0', 'impl Widget', 'Impl', {
			impl_type: 'Inherent',
			impl_category: 'Inherent',
		});
		const inherentMethod = node('demo::Widget::new', 'new', 'Function', {
			parent_impl: inherentImpl.id,
		});
		const traitImpl = node('demo::Widget::impl-Display', 'impl Display for Widget', 'Impl', {
			impl_type: 'Trait',
			impl_category: 'Trait',
			impl_trait: 'core::fmt::Display',
		});
		const assocType = node('demo::Widget::impl-Display::Output', 'Output', 'AssocType', {
			parent_impl: traitImpl.id,
			type: { kind: 'Primitive', name: 'str' },
		});
		const traitMethod = node('demo::Widget::impl-Display::fmt', 'fmt', 'Function', {
			parent_impl: traitImpl.id,
			docs: 'Custom formatting docs.',
		});
		const blanketImpl = node('demo::Widget::impl-Any', 'impl Any for Widget', 'Impl', {
			impl_type: 'Trait',
			impl_category: 'Blanket',
			impl_trait: 'core::any::Any',
		});
		const caller = node('demo::make_widget', 'make_widget', 'Function');
		const dep = node('dep::Thing', 'Thing', 'Struct', { is_external: true });

		const detail: NodeDetail = {
			node: selected,
			relatedNodes: [
				inherentImpl,
				inherentMethod,
				traitImpl,
				assocType,
				traitMethod,
				blanketImpl,
				caller,
				dep,
			],
			edges: [
				{ from: selected.id, to: inherentImpl.id, kind: 'Defines', confidence: 'Static' },
				{ from: inherentImpl.id, to: inherentMethod.id, kind: 'Defines', confidence: 'Static' },
				{ from: selected.id, to: traitImpl.id, kind: 'Defines', confidence: 'Static' },
				{ from: traitImpl.id, to: traitMethod.id, kind: 'Defines', confidence: 'Static' },
				{ from: traitImpl.id, to: assocType.id, kind: 'Defines', confidence: 'Static' },
				{ from: selected.id, to: blanketImpl.id, kind: 'Defines', confidence: 'Static' },
				{ from: selected.id, to: dep.id, kind: 'UsesType', confidence: 'Static' },
				{ from: caller.id, to: selected.id, kind: 'CallsStatic', confidence: 'Static' },
			],
		};

		const model = buildDetailDocModel(detail);
		const materialized = materializeDetailDocModel(detail);

		expect(model.methodGroups).toEqual([
			{ implId: inherentImpl.id, methodIds: [inherentMethod.id] },
		]);
		expect(model.traitImplGroups).toEqual([
			{ implId: traitImpl.id, methodIds: [assocType.id, traitMethod.id] },
		]);
		expect(model.sourceImplIds).toEqual([traitImpl.id]);
		expect(model.blanketImplIds).toEqual([blanketImpl.id]);
		expect(model.tocEntries.find((entry) => entry.anchor === 'trait-impls')?.count).toBe(2);
		expect(model.tocEntries.some((entry) => entry.anchor === 'relationships')).toBe(false);
		expect(model.whereUsed).toEqual([{ id: caller.id, name: caller.name }]);
		expect(materialized.traitImplGroups[0].methods.map((method) => method.id)).toEqual([
			assocType.id,
			traitMethod.id,
		]);
	});

	it('lists required/provided methods and assoc items on trait definition pages', () => {
		const selected = node('demo::Display', 'Display', 'Trait', {
			required_trait_methods: ['fmt'],
			default_trait_methods: ['to_string'],
		});
		const required = node('demo::Display::fmt', 'fmt', 'Function', {
			docs: 'Formats the value.',
			signature: {
				inputs: [{ name: 'self', type: { kind: 'Generic', name: 'Self' } }],
				output: { kind: 'Primitive', name: '()' },
				is_async: false,
				is_const: false,
				is_unsafe: false,
			},
		});
		const provided = node('demo::Display::to_string', 'to_string', 'Function', {
			docs: 'Converts the value to a String.',
		});
		const assocType = node('demo::Display::Output', 'Output', 'AssocType', {
			type: { kind: 'Primitive', name: 'str' },
		});
		const detail: NodeDetail = {
			node: selected,
			relatedNodes: [required, provided, assocType],
			edges: [
				{ from: selected.id, to: required.id, kind: 'Defines', confidence: 'Static' },
				{ from: selected.id, to: provided.id, kind: 'Defines', confidence: 'Static' },
				{ from: selected.id, to: assocType.id, kind: 'Defines', confidence: 'Static' },
			],
		};

		const model = buildDetailDocModel(detail);
		const materialized = materializeDetailDocModel(detail);

		expect(model.requiredTraitMethodIds).toEqual([required.id]);
		expect(model.providedTraitMethodIds).toEqual([provided.id]);
		expect(model.traitAssocItemIds).toEqual([assocType.id]);
		expect(model.tocEntries.map((e) => e.anchor)).toEqual([
			'associated-items',
			'required-methods',
			'provided-methods',
		]);
		expect(materialized.requiredTraitMethods.map((m) => m.name)).toEqual(['fmt']);
		expect(materialized.providedTraitMethods.map((m) => m.name)).toEqual(['to_string']);
		expect(materialized.traitAssocItems.map((m) => m.name)).toEqual(['Output']);
	});

	it('materializes direct public crate items without internals or duplicate re-exports', () => {
		const selected = node('demo', 'demo', 'Crate', { docs: 'Demo crate.' });
		const module = node('demo::api', 'api', 'Module', { docs: 'Public API.' });
		const structure = node('demo::Widget', 'Widget', 'Struct');
		const privateFunction = node('demo::hidden', 'hidden', 'Function', {
			visibility: { kind: 'Inherited' },
		});
		const external = node('dep::Thing', 'Thing', 'Struct', { is_external: true });
		const duplicateRootModule = node('demo~module-0', 'demo', 'Module');
		const detail: NodeDetail = {
			node: selected,
			relatedNodes: [module, structure, privateFunction, external, duplicateRootModule],
			edges: [
				{ from: selected.id, to: module.id, kind: 'Contains', confidence: 'Static' },
				{ from: selected.id, to: structure.id, kind: 'Contains', confidence: 'Static' },
				{ from: selected.id, to: structure.id, kind: 'ReExports', confidence: 'Static' },
				{ from: selected.id, to: privateFunction.id, kind: 'Contains', confidence: 'Static' },
				{ from: selected.id, to: external.id, kind: 'ReExports', confidence: 'Static' },
				{ from: selected.id, to: duplicateRootModule.id, kind: 'Contains', confidence: 'Static' },
			],
		};

		const model = materializeDetailDocModel(detail);
		expect(model.crateItems.map((item) => item.id)).toEqual([module.id, structure.id]);
		expect(model.tocEntries).toContainEqual({
			anchor: 'crate-items',
			title: 'Crate items',
			count: 2,
		});
	});
});
