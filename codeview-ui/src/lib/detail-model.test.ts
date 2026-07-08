import { describe, expect, it } from 'vitest';
import type { DetailDocModel, Node, NodeDetail, NodeKind } from '$lib/schema';
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
	});

	it('rebuilds optional trait impl groups when materializing older doc models', () => {
		const selected = node('demo::Widget', 'Widget', 'Struct');
		const traitImpl = node('demo::Widget::impl-Display', 'impl Display for Widget', 'Impl', {
			impl_type: 'Trait',
			impl_category: 'Trait',
			impl_trait: 'core::fmt::Display',
		});
		const traitMethod = node('demo::Widget::impl-Display::fmt', 'fmt', 'Function', {
			parent_impl: traitImpl.id,
		});
		const detail: NodeDetail = {
			node: selected,
			relatedNodes: [traitImpl, traitMethod],
			edges: [
				{ from: selected.id, to: traitImpl.id, kind: 'Defines', confidence: 'Static' },
				{ from: traitImpl.id, to: traitMethod.id, kind: 'Defines', confidence: 'Static' },
			],
		};
		const model = buildDetailDocModel(detail);
		const olderModel = { ...model, traitImplGroups: undefined } satisfies DetailDocModel;

		const materialized = materializeDetailDocModel(olderModel, detail);

		expect(materialized.traitImplGroups).toHaveLength(1);
		expect(materialized.traitImplGroups[0].impl.id).toBe(traitImpl.id);
		expect(materialized.traitImplGroups[0].methods.map((method) => method.id)).toEqual([
			traitMethod.id,
		]);
	});
});
