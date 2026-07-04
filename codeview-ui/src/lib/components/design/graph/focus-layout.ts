import type { Edge, EdgeKind, Node } from '$lib/schema';
import type { DesignNode, DesignRelation } from '$lib/design/live-node';

export type FocusDirection = 'incoming' | 'outgoing';

export type FocusGraphItem = {
	node: DesignNode<Node>;
	edges: Edge[];
	rel: DesignRelation;
	color: string;
	direction: FocusDirection;
	inCount: number;
	outCount: number;
};

export type FocusGraphGroup = {
	rel: DesignRelation;
	verb: string;
	label: string;
	color: string;
	direction: FocusDirection;
	items: FocusGraphItem[];
};

export type FocusGraphModel = {
	focus: DesignNode<Node>;
	incoming: FocusGraphGroup[];
	outgoing: FocusGraphGroup[];
};

export type FocusGraphSize = {
	width: number;
	height: number;
	compact?: boolean;
};

export type FocusLayoutNode = {
	id: string;
	realId: string;
	node: DesignNode<Node>;
	x: number;
	y: number;
	width: number;
	height: number;
	color: string;
	direction: FocusDirection | 'focus';
	rel?: DesignRelation;
	isFocus: boolean;
	inCount: number;
	outCount: number;
};

export type FocusLayoutEdge = {
	id: string;
	source: string;
	target: string;
	kind: EdgeKind;
	direction: FocusDirection;
	rel: DesignRelation;
	color: string;
	path: string;
	arrowPath: string;
	activeNodeIds: [string, string];
};

export type FocusLayoutLabel = {
	id: string;
	x: number;
	y: number;
	width: number;
	text: string;
	count: number;
	color: string;
	rel: DesignRelation;
	direction: FocusDirection;
};

export type FocusGraphLayout = {
	width: number;
	height: number;
	top: number;
	margin: number;
	centerX: number;
	centerY: number;
	focusLeftEdge: number;
	focusRightEdge: number;
	nodes: FocusLayoutNode[];
	edges: FocusLayoutEdge[];
	labels: FocusLayoutLabel[];
	activeRelations: DesignRelation[];
};

type PositionedItem = FocusGraphItem & {
	y: number;
	width: number;
	height: number;
};

type PositionedGroup = Omit<FocusGraphGroup, 'items'> & {
	items: PositionedItem[];
	hubY: number;
	edgeCount: number;
};

const FOCUS_HEIGHT = 48;
const PILL_HEIGHT = 32;

export function measureFocusPill(node: DesignNode<Node>, isFocus = false): number {
	const label = node.label || node.id;
	return isFocus ? Math.max(160, 96 + label.length * 8.8) : Math.max(98, 52 + label.length * 7.2);
}

export function layoutFocusGraph(
	model: FocusGraphModel,
	size: FocusGraphSize,
): FocusGraphLayout {
	const width = Math.max(size.compact ? 560 : 720, Math.round(size.width || 0));
	const height = Math.max(size.compact ? 320 : 460, Math.round(size.height || 0));
	const margin = size.compact ? 22 : 30;
	const top = size.compact ? 30 : 40;
	const focusWidth = measureFocusPill(model.focus, true);
	const maxOut = maxItemWidth(model.outgoing);
	const maxIn = maxItemWidth(model.incoming);
	const rightX = model.outgoing.length ? width - margin - maxOut : width - margin;
	const leftX = model.incoming.length ? margin + maxIn : margin;
	const centerX = (leftX + rightX) / 2;
	const centerY = (height + top) / 2;
	const hubOutX = centerX + (rightX - centerX) * 0.42;
	const hubInX = centerX - (centerX - leftX) * 0.42;
	const maxRows = Math.max(rowsSide(model.outgoing), rowsSide(model.incoming), 1);
	const avail = height - top - (size.compact ? 42 : 54);
	const row = Math.min(size.compact ? 38 : 44, Math.max(size.compact ? 28 : 30, avail / maxRows));
	const gap = row * 0.6;
	const focusLeftEdge = centerX - focusWidth / 2;
	const focusRightEdge = centerX + focusWidth / 2;
	const incoming = layoutSide(model.incoming, centerY, row, gap);
	const outgoing = layoutSide(model.outgoing, centerY, row, gap);
	const nodes: FocusLayoutNode[] = [];
	const edges: FocusLayoutEdge[] = [];
	const labels: FocusLayoutLabel[] = [];

	for (const group of incoming) {
		labels.push(
			buildLabel(group, 'incoming', (focusLeftEdge + hubInX) / 2, (centerY + group.hubY) / 2),
		);
		for (const item of group.items) {
			const nodeX = leftX - item.width;
			nodes.push(buildLayoutNode(item, nodeX, item.y - PILL_HEIGHT / 2, group.color));
			for (const [index, edge] of item.edges.entries()) {
				const startX = leftX + 8;
				const startY = item.y;
				const endX = focusLeftEdge;
				const endY = centerY;
				edges.push({
					id: edgeId(edge, 'incoming', index),
					source: flowNodeId('incoming', item.node.id),
					target: focusFlowNodeId(model.focus.id),
					kind: edge.kind,
					direction: 'incoming',
					rel: group.rel,
					color: group.color,
					path: bundledPath(startX, startY, hubInX, group.hubY, endX, endY),
					arrowPath: incomingArrow(endX, endY),
					activeNodeIds: [flowNodeId('incoming', item.node.id), focusFlowNodeId(model.focus.id)],
				});
			}
		}
	}

	for (const group of outgoing) {
		labels.push(
			buildLabel(group, 'outgoing', (focusRightEdge + hubOutX) / 2, (centerY + group.hubY) / 2),
		);
		for (const item of group.items) {
			const nodeX = rightX;
			nodes.push(buildLayoutNode(item, nodeX, item.y - PILL_HEIGHT / 2, group.color));
			for (const [index, edge] of item.edges.entries()) {
				const startX = focusRightEdge;
				const startY = centerY;
				const endX = rightX - 8;
				const endY = item.y;
				edges.push({
					id: edgeId(edge, 'outgoing', index),
					source: focusFlowNodeId(model.focus.id),
					target: flowNodeId('outgoing', item.node.id),
					kind: edge.kind,
					direction: 'outgoing',
					rel: group.rel,
					color: group.color,
					path: bundledPath(startX, startY, hubOutX, group.hubY, endX, endY),
					arrowPath: outgoingArrow(endX, endY),
					activeNodeIds: [focusFlowNodeId(model.focus.id), flowNodeId('outgoing', item.node.id)],
				});
			}
		}
	}

	nodes.push({
		id: focusFlowNodeId(model.focus.id),
		realId: model.focus.id,
		node: model.focus,
		x: centerX - focusWidth / 2,
		y: centerY - FOCUS_HEIGHT / 2,
		width: focusWidth,
		height: FOCUS_HEIGHT,
		color: 'var(--accent)',
		direction: 'focus',
		isFocus: true,
		inCount: sumEdges(model.incoming),
		outCount: sumEdges(model.outgoing),
	});

	return {
		width,
		height,
		top,
		margin,
		centerX,
		centerY,
		focusLeftEdge,
		focusRightEdge,
		nodes,
		edges,
		labels,
		activeRelations: uniqueRelations([...incoming, ...outgoing]),
	};
}

function maxItemWidth(groups: FocusGraphGroup[]): number {
	return Math.max(
		0,
		...groups.flatMap((group) => group.items.map((item) => measureFocusPill(item.node))),
	);
}

function rowsSide(groups: FocusGraphGroup[]): number {
	return groups.reduce((sum, group) => sum + group.items.length, 0) + Math.max(0, groups.length - 1) * 0.6;
}

function layoutSide(groups: FocusGraphGroup[], centerY: number, row: number, gap: number): PositionedGroup[] {
	const total = groups.reduce((sum, group, index) => sum + group.items.length * row + (index ? gap : 0), 0);
	let y = centerY - total / 2 + row / 2;
	return groups.map((group) => {
		const ys: number[] = [];
		const items = group.items.map((item) => {
			const itemY = y;
			ys.push(itemY);
			y += row;
			return {
				...item,
				y: itemY,
				width: measureFocusPill(item.node),
				height: PILL_HEIGHT,
			};
		});
		const hubY = ys.length ? ys.reduce((sum, itemY) => sum + itemY, 0) / ys.length : centerY;
		y += gap;
		return {
			...group,
			items,
			hubY,
			edgeCount: items.reduce((sum, item) => sum + item.edges.length, 0),
		};
	});
}

function buildLayoutNode(item: PositionedItem, x: number, y: number, color: string): FocusLayoutNode {
	return {
		id: flowNodeId(item.direction, item.node.id),
		realId: item.node.id,
		node: item.node,
		x,
		y,
		width: item.width,
		height: item.height,
		color,
		direction: item.direction,
		rel: item.rel,
		isFocus: false,
		inCount: item.inCount,
		outCount: item.outCount,
	};
}

function flowNodeId(direction: FocusDirection, nodeId: string): string {
	return `${direction}:${nodeId}`;
}

function focusFlowNodeId(nodeId: string): string {
	return `focus:${nodeId}`;
}

function buildLabel(
	group: PositionedGroup,
	direction: FocusDirection,
	x: number,
	y: number,
): FocusLayoutLabel {
	const width = group.verb.length * 6.4 + 34;
	return {
		id: `${direction}:${group.rel}`,
		x,
		y,
		width,
		text: group.verb,
		count: group.edgeCount,
		color: group.color,
		rel: group.rel,
		direction,
	};
}

function edgeId(edge: Edge, direction: FocusDirection, index: number): string {
	return `${direction}:${edge.kind}:${edge.from}->${edge.to}:${index}`;
}

function bundledPath(
	startX: number,
	startY: number,
	hubX: number,
	hubY: number,
	endX: number,
	endY: number,
): string {
	const firstMid = (startX + hubX) / 2;
	const secondMid = (hubX + endX) / 2;
	return [
		`M ${startX} ${startY}`,
		`C ${firstMid} ${startY} ${firstMid} ${hubY} ${hubX} ${hubY}`,
		`C ${secondMid} ${hubY} ${secondMid} ${endY} ${endX} ${endY}`,
	].join(' ');
}

function incomingArrow(x: number, y: number): string {
	return `M ${x - 2} ${y - 4.5} L ${x + 6} ${y} L ${x - 2} ${y + 4.5} Z`;
}

function outgoingArrow(x: number, y: number): string {
	return `M ${x - 8} ${y - 4.5} L ${x} ${y} L ${x - 8} ${y + 4.5} Z`;
}

function sumEdges(groups: FocusGraphGroup[]): number {
	return groups.reduce((sum, group) => sum + group.items.reduce((inner, item) => inner + item.edges.length, 0), 0);
}

function uniqueRelations(groups: PositionedGroup[]): DesignRelation[] {
	const seen = new Set<DesignRelation>();
	const rels: DesignRelation[] = [];
	for (const group of groups) {
		if (seen.has(group.rel)) continue;
		seen.add(group.rel);
		rels.push(group.rel);
	}
	return rels;
}
