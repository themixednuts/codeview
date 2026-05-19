import { describe, expect, it } from 'vite-plus/test';
import type { Edge, Graph, Node } from '$lib/graph';
import { CENTER_X, CENTER_Y, LAYOUT_HEIGHT, LAYOUT_WIDTH } from './types';
import { computeForceLayout } from './force';

function makeNode(id: string, name: string, kind: Node['kind'] = 'Function'): Node {
	return {
		id,
		name,
		kind,
		visibility: { kind: 'Public' },
		attrs: [],
	};
}

function makeEdge(from: string, to: string, kind: Edge['kind'] = 'UsesType'): Edge {
	return {
		from,
		to,
		kind,
		confidence: 'Static',
	};
}

function roundedPositions(graph: Graph, selected: Node): Array<[string, number, number]> {
	return computeForceLayout(graph, selected).nodes.map((node) => [
		node.node.id,
		Math.round(node.x),
		Math.round(node.y),
	]);
}

describe('computeForceLayout', () => {
	it('keeps the selected node fixed in the center', () => {
		const selected = makeNode('crate::Center', 'Center', 'Struct');
		const dep = makeNode('crate::Dep', 'Dep');
		const result = computeForceLayout(
			{ nodes: [selected, dep], edges: [makeEdge(selected.id, dep.id)] },
			selected,
		);

		const center = result.nodes.find((node) => node.node.id === selected.id);
		expect(center?.x).toBe(CENTER_X);
		expect(center?.y).toBe(CENTER_Y);
	});

	it('is deterministic for the same input graph', () => {
		const selected = makeNode('crate::Center', 'Center', 'Struct');
		const deps = Array.from({ length: 12 }, (_, index) =>
			makeNode(`crate::Dep${index}`, `Dep${index}`),
		);
		const graph = {
			nodes: [selected, ...deps],
			edges: deps.map((dep) => makeEdge(selected.id, dep.id)),
		};

		expect(roundedPositions(graph, selected)).toEqual(roundedPositions(graph, selected));
	});

	it('keeps laid out nodes inside the viewport margins', () => {
		const selected = makeNode('crate::Center', 'Center', 'Struct');
		const deps = Array.from({ length: 40 }, (_, index) =>
			makeNode(`crate::Dep${index}`, `Dependency${index}`),
		);
		const result = computeForceLayout(
			{
				nodes: [selected, ...deps],
				edges: deps.map((dep) => makeEdge(selected.id, dep.id)),
			},
			selected,
		);

		for (const node of result.nodes) {
			expect(node.x).toBeGreaterThanOrEqual(50);
			expect(node.x).toBeLessThanOrEqual(LAYOUT_WIDTH - 50);
			expect(node.y).toBeGreaterThanOrEqual(50);
			expect(node.y).toBeLessThanOrEqual(LAYOUT_HEIGHT - 50);
		}
	});
});
