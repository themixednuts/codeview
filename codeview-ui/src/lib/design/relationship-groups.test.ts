import { describe, expect, it } from 'vitest';
import type { Node, NodeDetail, NodeKind } from '$lib/schema';
import { buildNodeRelationshipGroups } from './relationship-groups';

const visibility = { kind: 'Public' } as const;

function node(id: string, name: string, kind: NodeKind = 'Struct', docs?: string): Node {
	return {
		id,
		name,
		kind,
		visibility,
		attrs: [],
		...(docs ? { docs } : {}),
	};
}

describe('relationship groups', () => {
	it('preserves relation order, direction labels, item sorting, and counts', () => {
		const selected = node('demo::Selected', 'Selected');
		const alpha = node('demo::Alpha', 'Alpha', 'Function', 'full docs should not be duplicated');
		const beta = node('demo::Beta', 'Beta', 'Function');
		const impl = node('demo::impl-1', 'impl Selected', 'Impl');
		const detail: NodeDetail = {
			node: selected,
			relatedNodes: [beta, alpha, impl],
			edges: [
				{ from: selected.id, to: beta.id, kind: 'UsesType', confidence: 'Static' },
				{ from: selected.id, to: alpha.id, kind: 'UsesType', confidence: 'Static' },
				{ from: selected.id, to: alpha.id, kind: 'UsesType', confidence: 'Runtime' },
				{ from: selected.id, to: impl.id, kind: 'Defines', confidence: 'Static' },
				{ from: beta.id, to: selected.id, kind: 'CallsStatic', confidence: 'Static' },
			],
		};

		const groups = buildNodeRelationshipGroups(detail);

		expect(groups.outgoing.map((group) => group.rel)).toEqual(['defines', 'uses']);
		expect(groups.outgoing[0].label).toBe('defines');
		expect(groups.outgoing[1].label).toBe('uses');
		expect(groups.outgoing[1].items.map((item) => [item.node.name, item.count])).toEqual([
			['Alpha', 2],
			['Beta', 1],
		]);
		expect('docs' in groups.outgoing[1].items[0].node).toBe(false);

		expect(groups.incoming.map((group) => group.rel)).toEqual(['calls']);
		expect(groups.incoming[0].label).toBe('called by');
		expect(groups.incoming[0].items).toHaveLength(1);
		expect(groups.incoming[0].items[0].node.id).toBe(beta.id);
	});
});
