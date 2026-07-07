import type { CrateGraph, CrateTree, Edge, Node, NodeSummary } from '$lib/schema';

export function summarizeNode(node: Node): NodeSummary {
	return {
		id: node.id,
		name: node.name,
		kind: node.kind,
		visibility: node.visibility,
		is_external: node.is_external,
		is_deprecated: node.is_deprecated,
		...(node.kind === 'Impl'
			? {
					impl_trait: node.impl_trait,
					impl_category: node.impl_category,
					generics: node.generics,
				}
			: {}),
	};
}

export function buildCrateTree(graph: Pick<CrateGraph, 'nodes' | 'edges'>): CrateTree {
	const internalNodes = graph.nodes.filter((node) => !node.is_external);
	const internalIds = new Set(internalNodes.map((node) => node.id));
	const structuralEdges = graph.edges.filter(
		(edge): edge is Edge =>
			(edge.kind === 'Contains' || edge.kind === 'Defines') &&
			internalIds.has(edge.from) &&
			internalIds.has(edge.to),
	);
	return {
		nodes: internalNodes.map(summarizeNode),
		edges: structuralEdges,
	};
}
