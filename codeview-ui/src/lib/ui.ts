import type { Edge, EdgeKind, NodeKind } from './graph';

export type GraphStats = {
  nodeCount: number;
  edgeCount: number;
  kindCounts: { kind: NodeKind; count: number }[];
  edgeCounts: { kind: EdgeKind; count: number }[];
};

export type SelectedEdges = {
  incoming: Edge[];
  outgoing: Edge[];
};
