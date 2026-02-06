import type { Graph, Node } from '$lib/graph';
import type { VisNode, VisEdge } from './types';
import { CENTER_X, CENTER_Y, FLOW_COLUMN_GAP, FLOW_ROW_GAP, MAX_NODES_PER_COLUMN } from './types';
import { getNodeVisual } from '$lib/graph/visual/node-visual';

function formatEdgeKinds(kinds: string[]): string {
  return Array.from(new Set(kinds)).join(', ');
}

export function computeEgoLayout(graph: Graph, selected: Node): { nodes: VisNode[]; edges: VisEdge[] } {
  const nodeMap = new Map<string, Node>();
  for (const node of graph.nodes) {
    nodeMap.set(node.id, node);
  }

  const incoming = graph.edges.filter((e) => e.to === selected.id);
  const outgoing = graph.edges.filter((e) => e.from === selected.id);

  const incomingNodes = new Map<string, { node: Node; kinds: string[] }>();
  const outgoingNodes = new Map<string, { node: Node; kinds: string[] }>();

  for (const edge of incoming) {
    const node = nodeMap.get(edge.from);
    if (node && node.id !== selected.id) {
      if (!incomingNodes.has(node.id)) {
        incomingNodes.set(node.id, { node, kinds: [] });
      }
      incomingNodes.get(node.id)!.kinds.push(edge.kind);
    }
  }

  for (const edge of outgoing) {
    const node = nodeMap.get(edge.to);
    if (node && node.id !== selected.id) {
      if (!outgoingNodes.has(node.id)) {
        outgoingNodes.set(node.id, { node, kinds: [] });
      }
      outgoingNodes.get(node.id)!.kinds.push(edge.kind);
    }
  }

  const visNodes: VisNode[] = [];
  const visEdges: VisEdge[] = [];

  const centerNode: VisNode = {
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
    layoutRadius: 0
  };
  visNodes.push(centerNode);

  for (const id of outgoingNodes.keys()) {
    if (incomingNodes.has(id)) {
      const outEntry = outgoingNodes.get(id)!;
      const inEntry = incomingNodes.get(id)!;
      outEntry.kinds.push(...inEntry.kinds);
      incomingNodes.delete(id);
    }
  }

  const inArray = Array.from(incomingNodes.values()).slice(0, MAX_NODES_PER_COLUMN);
  const outArray = Array.from(outgoingNodes.values()).slice(0, MAX_NODES_PER_COLUMN);

  const centerDims = getNodeVisual(selected.kind, true);
  const incomingWidths = inArray.map((entry) => getNodeVisual(entry.node.kind, false).width);
  const outgoingWidths = outArray.map((entry) => getNodeVisual(entry.node.kind, false).width);
  const maxIncomingWidth = incomingWidths.length > 0 ? Math.max(...incomingWidths) : 0;
  const maxOutgoingWidth = outgoingWidths.length > 0 ? Math.max(...outgoingWidths) : 0;
  const leftX = CENTER_X - (centerDims.width / 2 + FLOW_COLUMN_GAP + maxIncomingWidth / 2);
  const rightX = CENTER_X + (centerDims.width / 2 + FLOW_COLUMN_GAP + maxOutgoingWidth / 2);

  function layoutColumn(
    entries: { node: Node; kinds: string[] }[],
    direction: 'in' | 'out',
    x: number
  ): VisNode[] {
    if (entries.length === 0) return [];
    const heights = entries.map((entry) => getNodeVisual(entry.node.kind, false).height);
    const totalHeight = heights.reduce((sum, height) => sum + height, 0)
      + Math.max(0, entries.length - 1) * FLOW_ROW_GAP;
    let cursorY = CENTER_Y - totalHeight / 2;

    return entries.map((entry, i) => {
      const height = heights[i];
      const y = cursorY + height / 2;
      cursorY += height + FLOW_ROW_GAP;
      return {
        node: entry.node,
        x,
        y,
        baseX: x,
        baseY: y,
        angle: 0,
        isCenter: false,
        edgeKind: formatEdgeKinds(entry.kinds),
        direction,
        layer: 1,
        indexInLayer: i,
        totalInLayer: entries.length,
        layoutRadius: 0
      };
    });
  }

  const inVisNodes = layoutColumn(inArray, 'in', leftX);
  const outVisNodes = layoutColumn(outArray, 'out', rightX);

  visNodes.push(...inVisNodes);
  visNodes.push(...outVisNodes);

  for (const visNode of inVisNodes) {
    const entry = incomingNodes.get(visNode.node.id)!;
    visEdges.push({
      from: visNode,
      to: centerNode,
      kind: formatEdgeKinds(entry.kinds),
      direction: 'in'
    });
  }

  for (const visNode of outVisNodes) {
    const entry = outgoingNodes.get(visNode.node.id)!;
    visEdges.push({
      from: centerNode,
      to: visNode,
      kind: formatEdgeKinds(entry.kinds),
      direction: 'out'
    });
  }

  return { nodes: visNodes, edges: visEdges };
}
