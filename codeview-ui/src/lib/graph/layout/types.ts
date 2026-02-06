import type { Edge, Node } from '$lib/graph';

export type LayoutMode = 'ego' | 'force' | 'hierarchical' | 'radial';

export type VisNode = {
  node: Node;
  x: number;
  y: number;
  baseX: number;
  baseY: number;
  angle: number;
  isCenter: boolean;
  edgeKind: string;
  direction: 'in' | 'out' | 'center';
  layer: number;
  indexInLayer: number;
  totalInLayer: number;
  layoutRadius: number;
};

export type VisEdge = {
  from: VisNode;
  to: VisNode;
  kind: string;
  direction: 'in' | 'out';
};

export const LAYOUT_WIDTH = 700;
export const LAYOUT_HEIGHT = 500;
export const CENTER_X = LAYOUT_WIDTH / 2;
export const CENTER_Y = LAYOUT_HEIGHT / 2;
export const FLOW_COLUMN_GAP = 96;
export const FLOW_ROW_GAP = 18;
export const MAX_NODES_PER_COLUMN = 18;
export const FORCE_RADIUS = 180;
export const RADIAL_RADIUS = 180;
export const MIN_NODE_SPACING = 16;
export const LABEL_CHAR_WIDTH = 6.6;
export const ARROWHEAD_LENGTH = 12;

// Legacy layout types (from layout.ts)
export type LayoutNode = Node & {
  x?: number | null;
  y?: number | null;
};

export type LayoutLink = Edge & {
  source: LayoutNode | string | number;
  target: LayoutNode | string | number;
};

export type LayoutState = {
  nodes: LayoutNode[];
  links: LayoutLink[];
};
