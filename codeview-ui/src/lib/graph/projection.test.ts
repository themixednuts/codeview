import { describe, expect, it } from 'vite-plus/test';
import type { Edge, Graph, Node } from '$lib/graph';
import { isSyntheticProjectionNodeId, projectGraphForRendering } from './projection';

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

function project(
	graph: Graph,
	selected: Node,
	overrides?: Partial<Parameters<typeof projectGraphForRendering>[2]>,
) {
	return projectGraphForRendering(graph, selected, {
		showStructural: true,
		showSemantic: true,
		layoutMode: 'ego',
		...overrides,
	});
}

describe('projectGraphForRendering', () => {
	it('excludes trait/internal-only nodes and keeps trait metadata on visible nodes', () => {
		const selected = makeNode('crate::TypeA', 'TypeA', 'Struct');
		const trait = makeNode('crate::SomeTrait', 'SomeTrait', 'Trait');
		const implNode = makeNode('crate::impl-TypeA', 'impl TypeA', 'Impl');
		const field = makeNode('crate::TypeA::field', 'field', 'StructField');
		const variant = makeNode('crate::TypeA::Variant', 'Variant', 'Variant');
		const dep = makeNode('crate::dep_fn', 'dep_fn', 'Function');

		const graph: Graph = {
			nodes: [selected, trait, implNode, field, variant, dep],
			edges: [
				makeEdge(selected.id, trait.id, 'Implements'),
				makeEdge(selected.id, implNode.id, 'Defines'),
				makeEdge(selected.id, field.id, 'Contains'),
				makeEdge(selected.id, variant.id, 'Contains'),
				makeEdge(selected.id, dep.id, 'UsesType'),
			],
		};

		const result = project(graph, selected);
		const kinds = result.graph.nodes.map((node) => node.kind);

		expect(kinds).not.toContain('Trait');
		expect(kinds).not.toContain('Impl');
		expect(kinds).not.toContain('StructField');
		expect(kinds).not.toContain('Variant');

		const meta = result.traitMetadataByNodeId.get(selected.id);
		expect(meta?.traitCount).toBe(1);
		expect(meta?.traitIds).toContain(trait.id);
		expect(meta?.traitNames).toContain(trait.name);

		for (const edge of result.graph.edges) {
			expect(edge.from).not.toBe(trait.id);
			expect(edge.to).not.toBe(trait.id);
		}
	});

	it('caps dense neighborhoods and inserts synthetic overflow nodes', () => {
		const selected = makeNode('crate::Center', 'Center', 'Struct');
		const neighbors = Array.from({ length: 240 }, (_, i) =>
			makeNode(`crate::dep_${i}`, `dep_${i}`, 'Function'),
		);
		const graph: Graph = {
			nodes: [selected, ...neighbors],
			edges: neighbors.map((node) => makeEdge(selected.id, node.id, 'UsesType')),
		};

		const result = project(graph, selected, { maxNodes: 30, maxEdges: 80 });

		expect(result.graph.nodes.length).toBeLessThanOrEqual(30);
		expect(result.graph.edges.length).toBeLessThanOrEqual(80);
		expect(result.graph.nodes.some((node) => node.id === selected.id)).toBe(true);

		const syntheticNodes = result.graph.nodes.filter((node) =>
			isSyntheticProjectionNodeId(node.id),
		);
		expect(syntheticNodes.length).toBeGreaterThan(0);
		expect(syntheticNodes.some((node) => node.name.startsWith('+'))).toBe(true);
	});

	it('caps edge count and preserves selected node visibility', () => {
		const selected = makeNode('crate::Center', 'Center', 'Struct');
		const neighbors = Array.from({ length: 40 }, (_, i) =>
			makeNode(`crate::n_${i}`, `n_${i}`, 'Function'),
		);
		const edges: Edge[] = [];
		for (const node of neighbors) {
			edges.push(makeEdge(selected.id, node.id, 'UsesType'));
			edges.push(makeEdge(node.id, selected.id, 'CallsRuntime'));
		}

		const result = project(
			{
				nodes: [selected, ...neighbors],
				edges,
			},
			selected,
			{ maxNodes: 100, maxEdges: 24 },
		);

		expect(result.graph.edges.length).toBeLessThanOrEqual(24);
		expect(result.graph.nodes.some((node) => node.id === selected.id)).toBe(true);
		expect(result.graph.nodes.some((node) => isSyntheticProjectionNodeId(node.id))).toBe(true);
	});

	it('keeps selected nodes even when selected kind is normally excluded', () => {
		const selectedTrait = makeNode('crate::TraitA', 'TraitA', 'Trait');
		const dep = makeNode('crate::TypeA', 'TypeA', 'Struct');

		const result = project(
			{
				nodes: [selectedTrait, dep],
				edges: [makeEdge(dep.id, selectedTrait.id, 'Implements')],
			},
			selectedTrait,
		);

		expect(result.graph.nodes.some((node) => node.id === selectedTrait.id)).toBe(true);
	});
});
