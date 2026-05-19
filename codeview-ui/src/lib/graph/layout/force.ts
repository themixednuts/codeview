import {
	forceCenter,
	forceCollide,
	forceLink,
	forceManyBody,
	forceSimulation,
	forceX,
	forceY,
	type SimulationLinkDatum,
	type SimulationNodeDatum,
} from 'd3-force';
import type { Edge, Graph, Node } from '$lib/graph';
import type { VisNode, VisEdge } from './types';
import {
	CENTER_X,
	CENTER_Y,
	LAYOUT_WIDTH,
	LAYOUT_HEIGHT,
	FORCE_RADIUS,
	MIN_NODE_SPACING,
} from './types';
import { getNodeBoundingBox, resolveCollisions } from './collision';

type ForceDatum = SimulationNodeDatum & {
	id: string;
	node: Node;
	radius: number;
};

type ForceLink = SimulationLinkDatum<ForceDatum> & {
	edge: Edge;
};

const FORCE_TICKS = 90;
const VIEWPORT_MARGIN = 50;

export function computeForceLayout(
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

	const nodesToLayout = Array.from(connectedIds)
		.map((id) => nodeMap.get(id))
		.filter((n): n is Node => n !== undefined);

	if (nodesToLayout.length === 0) {
		return { nodes: [], edges: [] };
	}

	const orbitCount = Math.max(1, nodesToLayout.length - 1);
	let orbitIndex = 0;
	const layoutNodes: ForceDatum[] = nodesToLayout.map((node) => {
		const box = getNodeBoundingBox(node, node.id === selected.id);
		const radius = Math.max(box.width, box.height) / 2;
		if (node.id === selected.id) {
			return {
				id: node.id,
				node,
				radius,
				x: CENTER_X,
				y: CENTER_Y,
				fx: CENTER_X,
				fy: CENTER_Y,
			};
		}

		const angle = (2 * Math.PI * orbitIndex) / orbitCount - Math.PI / 2;
		orbitIndex += 1;
		return {
			id: node.id,
			node,
			radius,
			x: CENTER_X + FORCE_RADIUS * Math.cos(angle),
			y: CENTER_Y + FORCE_RADIUS * Math.sin(angle),
		};
	});

	const layoutNodeMap = new Map(layoutNodes.map((node) => [node.id, node]));
	const layoutLinks: ForceLink[] = graph.edges
		.filter((edge) => connectedIds.has(edge.from) && connectedIds.has(edge.to))
		.map((edge) => ({ source: edge.from, target: edge.to, edge }));
	const resolveLinkDatum = (endpoint: ForceLink['source']): ForceDatum | undefined =>
		typeof endpoint === 'object' ? endpoint : layoutNodeMap.get(String(endpoint));

	const simulation = forceSimulation(layoutNodes)
		.force(
			'link',
			forceLink<ForceDatum, ForceLink>(layoutLinks)
				.id((datum) => datum.id)
				.distance((link) => {
					const source = resolveLinkDatum(link.source);
					const target = resolveLinkDatum(link.target);
					return (source?.radius ?? 24) + (target?.radius ?? 24) + MIN_NODE_SPACING + 72;
				})
				.strength(0.24),
		)
		.force('charge', forceManyBody<ForceDatum>().strength(-650).distanceMax(FORCE_RADIUS * 2.4))
		.force(
			'collide',
			forceCollide<ForceDatum>()
				.radius((datum) => datum.radius + MIN_NODE_SPACING / 2)
				.iterations(2),
		)
		.force('center', forceCenter(CENTER_X, CENTER_Y))
		.force('x', forceX<ForceDatum>(CENTER_X).strength(0.025))
		.force('y', forceY<ForceDatum>(CENTER_Y).strength(0.025))
		.stop();

	for (let i = 0; i < FORCE_TICKS; i += 1) simulation.tick();
	simulation.stop();

	const visNodes: VisNode[] = [];
	const visNodeMap = new Map<string, VisNode>();

	for (const datum of layoutNodes) {
		const node = datum.node;
		const isCenter = node.id === selected.id;
		const x = isCenter
			? CENTER_X
			: Math.max(VIEWPORT_MARGIN, Math.min(LAYOUT_WIDTH - VIEWPORT_MARGIN, datum.x ?? CENTER_X));
		const y = isCenter
			? CENTER_Y
			: Math.max(VIEWPORT_MARGIN, Math.min(LAYOUT_HEIGHT - VIEWPORT_MARGIN, datum.y ?? CENTER_Y));
		const visNode: VisNode = {
			node,
			x,
			y,
			baseX: x,
			baseY: y,
			angle: 0,
			isCenter,
			edgeKind: '',
			direction: isCenter ? 'center' : 'out',
			layer: 0,
			indexInLayer: 0,
			totalInLayer: 1,
			layoutRadius: 0,
		};
		visNodes.push(visNode);
		visNodeMap.set(node.id, visNode);
	}

	resolveCollisions(visNodes, selected.id);
	for (const visNode of visNodes) {
		if (visNode.node.id === selected.id) {
			visNode.x = CENTER_X;
			visNode.y = CENTER_Y;
		} else {
			visNode.x = Math.max(VIEWPORT_MARGIN, Math.min(LAYOUT_WIDTH - VIEWPORT_MARGIN, visNode.x));
			visNode.y = Math.max(
				VIEWPORT_MARGIN,
				Math.min(LAYOUT_HEIGHT - VIEWPORT_MARGIN, visNode.y),
			);
		}
		visNode.baseX = visNode.x;
		visNode.baseY = visNode.y;
	}

	const visEdges: VisEdge[] = [];
	for (const edge of graph.edges) {
		const from = visNodeMap.get(edge.from);
		const to = visNodeMap.get(edge.to);
		if (from && to) {
			visEdges.push({
				from,
				to,
				kind: edge.kind,
				confidence: edge.confidence,
				is_glob: edge.is_glob,
				direction: edge.from === selected.id ? 'out' : 'in',
			});
		}
	}

	return { nodes: visNodes, edges: visEdges };
}
