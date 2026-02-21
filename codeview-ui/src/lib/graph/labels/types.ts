import type { VisEdge, VisNode } from '$lib/graph/layout/types';

export type LabelPosition = { x: number; y: number; anchor: string };
export type SimilarityInfo = { group: number[]; indexOf: number };

export type LabelContext = {
	edge: VisEdge;
	fromNode: VisNode;
	toNode: VisNode;
	edgeIndex: number;
	labelWidth: number;
	similarity: SimilarityInfo | undefined;
};

export interface LabelPositionProvider {
	position(ctx: LabelContext): LabelPosition;
	/** Optional post-process pass over all computed positions (e.g. collision avoidance) */
	postProcess?(positions: LabelPosition[]): void;
}
