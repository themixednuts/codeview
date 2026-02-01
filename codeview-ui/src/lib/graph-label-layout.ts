import type { LayoutMode, VisEdge, VisNode } from './graph-layout';
import { getEdgeAnchor } from './graph-layout';

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

// ---------------------------------------------------------------------------
// Provider implementations
// ---------------------------------------------------------------------------

const EDGE_NODE_PADDING = 10;

const egoLabelProvider: LabelPositionProvider = {
  position(ctx) {
    const { fromNode, toNode, similarity } = ctx;
    const startAnchor = getEdgeAnchor(fromNode, toNode);
    const endAnchor = getEdgeAnchor(toNode, fromNode);
    const gapX = (startAnchor.x + endAnchor.x) / 2;
    const midY = (startAnchor.y + endAnchor.y) / 2;

    let yOffset = 0;
    if (similarity && similarity.group.length > 1) {
      yOffset = (similarity.indexOf - (similarity.group.length - 1) / 2) * 16;
    }

    return { x: gapX, y: midY + yOffset, anchor: 'middle' };
  }
};

const hierarchicalLabelProvider: LabelPositionProvider = {
  position(ctx) {
    const { fromNode, toNode, labelWidth, similarity } = ctx;
    const startAnchor = getEdgeAnchor(fromNode, toNode);
    const endAnchor = getEdgeAnchor(toNode, fromNode);
    const gapY = (startAnchor.y + endAnchor.y) / 2;
    const midX = (startAnchor.x + endAnchor.x) / 2;

    let xOffset = 0;
    if (similarity && similarity.group.length > 1) {
      xOffset = (similarity.indexOf - (similarity.group.length - 1) / 2) * (labelWidth + 8);
    }

    return { x: midX + xOffset, y: gapY, anchor: 'middle' };
  }
};

const radialLabelProvider: LabelPositionProvider = {
  position(ctx) {
    const { fromNode, toNode, similarity } = ctx;
    const startAnchor = getEdgeAnchor(fromNode, toNode);
    const endAnchor = getEdgeAnchor(toNode, fromNode);
    const midX = (startAnchor.x + endAnchor.x) / 2;
    const midY = (startAnchor.y + endAnchor.y) / 2;
    const edgeDx = endAnchor.x - startAnchor.x;
    const edgeDy = endAnchor.y - startAnchor.y;
    const len = Math.hypot(edgeDx, edgeDy) || 1;
    const perpX = -edgeDy / len;
    const perpY = edgeDx / len;

    let offset = 12;
    if (similarity && similarity.group.length > 1) {
      offset += (similarity.indexOf - (similarity.group.length - 1) / 2) * 14;
    }

    return {
      x: midX + perpX * offset,
      y: midY + perpY * offset,
      anchor: 'middle'
    };
  }
};

const forceLabelProvider: LabelPositionProvider = {
  position(ctx) {
    const { fromNode, toNode, labelWidth, similarity } = ctx;
    const startAnchor = getEdgeAnchor(fromNode, toNode);
    const endAnchor = getEdgeAnchor(toNode, fromNode);
    const edgeDx = endAnchor.x - startAnchor.x;
    const edgeDy = endAnchor.y - startAnchor.y;
    const len = Math.hypot(edgeDx, edgeDy);

    if (len === 0) {
      return { x: fromNode.x, y: fromNode.y, anchor: 'middle' };
    }

    const inset = Math.min(EDGE_NODE_PADDING, len * 0.35);
    const startX = startAnchor.x + (edgeDx / len) * inset;
    const startY = startAnchor.y + (edgeDy / len) * inset;
    const endX = endAnchor.x - (edgeDx / len) * inset;
    const endY = endAnchor.y - (edgeDy / len) * inset;

    let midX = (startX + endX) / 2;
    let midY = (startY + endY) / 2;

    const perpX = -edgeDy / len;
    const perpY = edgeDx / len;

    const lineGap = Math.hypot(endX - startX, endY - startY);
    const sizePenalty = Math.max(0, (labelWidth - lineGap) * 0.25);
    const baseOffset = 10 + sizePenalty;
    let crowdOffset = 0;
    if (similarity && similarity.group.length > 1) {
      crowdOffset = (similarity.indexOf - (similarity.group.length - 1) / 2) * 14;
    }

    midX += perpX * (baseOffset + crowdOffset);
    midY += perpY * (baseOffset + crowdOffset);

    return { x: midX, y: midY, anchor: 'middle' };
  },

  postProcess(positions) {
    if (positions.length <= 1) return;
    const LABEL_HEIGHT = 16;
    const sorted = positions.map((p, i) => ({ ...p, i })).sort((a, b) => a.y - b.y);
    for (let k = 1; k < sorted.length; k++) {
      const gap = sorted[k].y - sorted[k - 1].y;
      if (gap < LABEL_HEIGHT) {
        const push = (LABEL_HEIGHT - gap) / 2;
        sorted[k - 1].y -= push;
        sorted[k].y += push;
      }
    }
    for (const s of sorted) {
      positions[s.i] = { x: s.x, y: s.y, anchor: s.anchor };
    }
  }
};

// ---------------------------------------------------------------------------
// Factory & batch helper
// ---------------------------------------------------------------------------

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
  getMetrics: (kind: string) => { width: number }
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
      similarity: similarityGroups.get(i)
    };
    return provider.position(ctx);
  });

  provider.postProcess?.(positions);

  return positions;
}
