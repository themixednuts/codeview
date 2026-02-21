import type { Graph, Node } from '$lib/graph';
import type { VisNode, VisEdge } from './types';
import { CENTER_X, CENTER_Y, RADIAL_RADIUS, MIN_NODE_SPACING, ARROWHEAD_LENGTH } from './types';
import { getNodeBoundingBox, resolveCollisions } from './collision';

export function computeRadialLayout(
	graph: Graph,
	selected: Node,
): { nodes: VisNode[]; edges: VisEdge[] } {
	const nodeMap = new Map<string, Node>();
	for (const node of graph.nodes) {
		nodeMap.set(node.id, node);
	}

	const connectedIds = new Set<string>();
	connectedIds.add(selected.id);

	for (const edge of graph.edges) {
		if (edge.from === selected.id) connectedIds.add(edge.to);
		if (edge.to === selected.id) connectedIds.add(edge.from);
	}

	const surroundingNodes = Array.from(connectedIds)
		.filter((id) => id !== selected.id)
		.map((id) => nodeMap.get(id))
		.filter((n): n is Node => n !== undefined);

	const visNodes: VisNode[] = [];
	const visNodeMap = new Map<string, VisNode>();

	const centerVisNode: VisNode = {
		node: selected,
		x: CENTER_X,
		y: CENTER_Y,
		baseX: CENTER_X,
		baseY: CENTER_Y,
		angle: 0,
		isCenter: true,
		edgeKind: '',
		direction: 'center',
		layer: 0,
		indexInLayer: 0,
		totalInLayer: 1,
		layoutRadius: 0,
	};
	visNodes.push(centerVisNode);
	visNodeMap.set(selected.id, centerVisNode);

	const centerBox = getNodeBoundingBox(selected, true);
	const centerRadius = Math.max(centerBox.width, centerBox.height) / 2;
	let totalArcLength = 0;
	for (const node of surroundingNodes) {
		const box = getNodeBoundingBox(node, false);
		totalArcLength += box.width + MIN_NODE_SPACING;
	}
	const minRadiusForSpacing = totalArcLength / (2 * Math.PI);
	const minRadiusFromCenter =
		centerRadius +
		MIN_NODE_SPACING +
		ARROWHEAD_LENGTH +
		(surroundingNodes.length > 0
			? Math.max(
					...surroundingNodes.map((n) => {
						const box = getNodeBoundingBox(n, false);
						return Math.max(box.width, box.height) / 2;
					}),
				)
			: 0);
	const radius = Math.max(RADIAL_RADIUS, minRadiusForSpacing, minRadiusFromCenter);

	surroundingNodes.forEach((node, i) => {
		const angle = (2 * Math.PI * i) / surroundingNodes.length - Math.PI / 2;
		const x = CENTER_X + radius * Math.cos(angle);
		const y = CENTER_Y + radius * Math.sin(angle);

		let direction: 'in' | 'out' = 'out';
		for (const edge of graph.edges) {
			if (edge.to === selected.id && edge.from === node.id) {
				direction = 'in';
				break;
			}
		}

		const visNode: VisNode = {
			node,
			x,
			y,
			baseX: x,
			baseY: y,
			angle,
			isCenter: false,
			edgeKind: '',
			direction,
			layer: 1,
			indexInLayer: i,
			totalInLayer: surroundingNodes.length,
			layoutRadius: radius,
		};
		visNodes.push(visNode);
		visNodeMap.set(node.id, visNode);
	});

	resolveCollisions(visNodes, selected.id);

	const visEdges: VisEdge[] = [];
	for (const edge of graph.edges) {
		const from = visNodeMap.get(edge.from);
		const to = visNodeMap.get(edge.to);
		if (from && to) {
			visEdges.push({
				from,
				to,
				kind: edge.kind,
				direction: edge.from === selected.id ? 'out' : 'in',
			});
		}
	}

	return { nodes: visNodes, edges: visEdges };
}
