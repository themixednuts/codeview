import type { LayoutMode } from '$lib/graph/layout/types';
import type { VisEdge, VisNode } from '$lib/graph/layout/types';
import type { LabelPositionProvider, LabelPosition, LabelContext, SimilarityInfo } from './types';
import {
	egoLabelProvider,
	hierarchicalLabelProvider,
	radialLabelProvider,
	forceLabelProvider,
} from './providers';

export function getLabelProvider(mode: LayoutMode): LabelPositionProvider {
	switch (mode) {
		case 'ego':
			return egoLabelProvider;
		case 'hierarchical':
			return hierarchicalLabelProvider;
		case 'radial':
			return radialLabelProvider;
		case 'force':
			return forceLabelProvider;
		default:
			return egoLabelProvider;
	}
}

export function computeAllLabelPositions(
	provider: LabelPositionProvider,
	edges: VisEdge[],
	positionedNodeMap: Map<string, VisNode>,
	similarityGroups: Map<number, SimilarityInfo>,
	getMetrics: (kind: string) => { width: number },
): LabelPosition[] {
	const positions = edges.map((edge, i) => {
		const fromNode = positionedNodeMap.get(edge.from.node.id) ?? edge.from;
		const toNode = positionedNodeMap.get(edge.to.node.id) ?? edge.to;
		const metrics = getMetrics(edge.kind);
		const ctx: LabelContext = {
			edge,
			fromNode,
			toNode,
			edgeIndex: i,
			labelWidth: metrics.width,
			similarity: similarityGroups.get(i),
		};
		return provider.position(ctx);
	});

	provider.postProcess?.(positions);

	return positions;
}
