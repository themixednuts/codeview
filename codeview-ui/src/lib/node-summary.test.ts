import { describe, expect, it } from 'vitest';
import type { CrateGraph, Node } from '$lib/schema';
import { buildCrateTree } from './node-summary';

const publicVisibility = { kind: 'Public' } as const;

function node(id: string, name: string, kind: Node['kind'], isExternal = false): Node {
	return {
		id,
		name,
		kind,
		visibility: publicVisibility,
		attrs: [],
		...(isExternal ? { is_external: true } : {}),
	};
}

describe('buildCrateTree', () => {
	it('keeps internal nodes and structural edges only', () => {
		const graph: CrateGraph = {
			id: 'demo',
			name: 'demo',
			version: '1.0.0',
			nodes: [
				node('demo', 'demo', 'Crate'),
				node('demo::map', 'map', 'Module'),
				node('demo::map::Drain', 'Drain', 'Struct'),
				node('alloc::Allocator', 'Allocator', 'Trait', true),
			],
			edges: [
				{ from: 'demo', to: 'demo::map', kind: 'Contains', confidence: 'Static' },
				{ from: 'demo::map', to: 'demo::map::Drain', kind: 'Defines', confidence: 'Static' },
				{
					from: 'demo::map::Drain',
					to: 'alloc::Allocator',
					kind: 'UsesType',
					confidence: 'Static',
				},
			],
		};

		const tree = buildCrateTree(graph);

		expect(tree.nodes.map((entry) => entry.id)).toEqual([
			'demo',
			'demo::map',
			'demo::map::Drain',
		]);
		expect(tree.edges.map((entry) => [entry.from, entry.to, entry.kind])).toEqual([
			['demo', 'demo::map', 'Contains'],
			['demo::map', 'demo::map::Drain', 'Defines'],
		]);
	});
});
