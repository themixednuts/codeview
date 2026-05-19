import { describe, expect, it } from 'vite-plus/test';
import type { Edge, Graph, Node } from '$lib/graph';
import { buildCrateMapData } from './crate-map';

function node(id: string, kind: Node['kind'], name = id.split('::').pop() ?? id): Node {
	return {
		id,
		name,
		kind,
		visibility: { kind: 'Public' },
		attrs: [],
	};
}

function edge(from: string, to: string, kind: Edge['kind']): Edge {
	return {
		from,
		to,
		kind,
		confidence: 'Static',
	};
}

describe('buildCrateMapData', () => {
	it('aggregates node ownership and module-level semantic edges', () => {
		const graph: Graph = {
			nodes: [
				node('demo', 'Crate', 'demo'),
				node('demo::parser', 'Module', 'parser'),
				node('demo::render', 'Module', 'render'),
				node('demo::parser::ParseCtx', 'Struct', 'ParseCtx'),
				node('demo::render::paint', 'Function', 'paint'),
				node('demo::run', 'Function', 'run'),
			],
			edges: [
				edge('demo', 'demo::parser', 'Contains'),
				edge('demo', 'demo::render', 'Contains'),
				edge('demo::parser', 'demo::parser::ParseCtx', 'Contains'),
				edge('demo::render', 'demo::render::paint', 'Contains'),
				edge('demo', 'demo::run', 'Contains'),
				edge('demo::parser::ParseCtx', 'demo::render::paint', 'UsesType'),
				edge('demo::render::paint', 'demo::parser::ParseCtx', 'CallsStatic'),
			],
		};

		const result = buildCrateMapData(graph, 'demo', {
			maxHierarchyModules: 32,
			maxMatrixModules: 8,
		});

		expect(result.totalNodeCount).toBe(6);
		expect(result.moduleNodes.map((module) => module.id)).toEqual(
			expect.arrayContaining(['demo', 'demo::parser', 'demo::render']),
		);

		const parser = result.moduleNodes.find((module) => module.id === 'demo::parser');
		const render = result.moduleNodes.find((module) => module.id === 'demo::render');
		expect(parser?.directNodeCount).toBeGreaterThanOrEqual(2);
		expect(render?.directNodeCount).toBeGreaterThanOrEqual(2);

		const parserToRender = result.moduleEdges.find(
			(moduleEdge) => moduleEdge.from === 'demo::parser' && moduleEdge.to === 'demo::render',
		);
		expect(parserToRender?.total).toBe(1);
		expect(parserToRender?.kindCounts.UsesType).toBe(1);

		const renderToParser = result.moduleEdges.find(
			(moduleEdge) => moduleEdge.from === 'demo::render' && moduleEdge.to === 'demo::parser',
		);
		expect(renderToParser?.kindCounts.CallsStatic).toBe(1);
	});

	it('caps hierarchy and matrix module counts', () => {
		const nodes: Node[] = [node('demo', 'Crate', 'demo')];
		const edges: Edge[] = [];

		for (let i = 0; i < 10; i++) {
			const moduleId = `demo::m${i}`;
			const fnId = `${moduleId}::f`;
			nodes.push(node(moduleId, 'Module', `m${i}`));
			nodes.push(node(fnId, 'Function', `f${i}`));
			edges.push(edge('demo', moduleId, 'Contains'));
			edges.push(edge(moduleId, fnId, 'Contains'));
			if (i > 0) {
				edges.push(edge(fnId, `demo::m${i - 1}::f`, 'UsesType'));
			}
		}

		const result = buildCrateMapData(
			{
				nodes,
				edges,
			},
			'demo',
			{
				maxHierarchyModules: 5,
				maxMatrixModules: 4,
			},
		);

		expect(result.truncatedHierarchy).toBe(true);
		expect(result.hiddenHierarchyModules).toBeGreaterThan(0);
		expect(result.moduleNodes.length).toBeLessThan(11);
		expect(result.matrixModuleIds.length).toBeLessThanOrEqual(4);
		expect(result.matrixModuleIds[0]).toBe('demo');
	});

	it('handles cyclical module parent links without blowing up', () => {
		const graph: Graph = {
			nodes: [
				node('demo', 'Crate', 'demo'),
				node('demo::a', 'Module', 'a'),
				node('demo::b', 'Module', 'b'),
				node('demo::a::f', 'Function', 'f'),
			],
			edges: [
				edge('demo', 'demo::a', 'Contains'),
				edge('demo::a', 'demo::b', 'Contains'),
				edge('demo::b', 'demo::a', 'Contains'),
				edge('demo::a', 'demo::a', 'Defines'),
				edge('demo::a', 'demo::a::f', 'Contains'),
				edge('demo::a::f', 'demo::b', 'UsesType'),
			],
		};

		const result = buildCrateMapData(graph, 'demo', {
			maxHierarchyModules: 32,
			maxMatrixModules: 8,
		});

		expect(result.moduleNodes.length).toBeGreaterThan(0);
		expect(result.moduleNodes.map((module) => module.id)).toContain('demo');
		for (const module of result.moduleNodes) {
			expect(Number.isFinite(module.totalNodeCount)).toBe(true);
			expect(module.totalNodeCount).toBeGreaterThanOrEqual(module.directNodeCount);
		}
	});
});
