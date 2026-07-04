import type { Edge as FlowEdge, Node as FlowNode } from '@xyflow/svelte';
import type { EdgeKind, Node } from '$lib/schema';
import type { DesignNode, DesignRelation } from '$lib/design/live-node';
import type { FocusDirection } from './focus-layout';

export type GraphNodePillFlowData = {
	node: DesignNode<Node>;
	color: string;
	isFocus: boolean;
	dim: boolean;
	active: boolean;
	href: string;
	width: number;
	height: number;
	inCount: number;
	outCount: number;
	onEscape?: () => void;
};

export type GraphNodePillFlowNode = FlowNode<GraphNodePillFlowData, 'graphNodePill'>;

export type RelationshipEdgeData = {
	kind: EdgeKind;
	relation: DesignRelation;
	direction: FocusDirection;
	color: string;
	path: string;
	arrowPath: string;
	dim: boolean;
	active: boolean;
};

export type RelationshipFlowEdge = FlowEdge<RelationshipEdgeData, 'relationship'>;
