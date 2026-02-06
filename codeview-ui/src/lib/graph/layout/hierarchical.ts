import type { Graph, Node } from '$lib/graph';
import type { VisNode, VisEdge } from './types';
import { CENTER_X, CENTER_Y, LAYOUT_HEIGHT, MIN_NODE_SPACING } from './types';
import { getNodeVisual } from '$lib/graph/visual/node-visual';
import { resolveCollisions } from './collision';

export function computeHierarchicalLayout(graph: Graph, selected: Node): { nodes: VisNode[]; edges: VisEdge[] } {
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

  const incomingIds = new Set<string>();
  const outgoingIds = new Set<string>();

  for (const edge of graph.edges) {
    if (edge.to === selected.id && connectedIds.has(edge.from)) {
      incomingIds.add(edge.from);
    }
    if (edge.from === selected.id && connectedIds.has(edge.to)) {
      outgoingIds.add(edge.to);
    }
  }

  for (const id of outgoingIds) {
    incomingIds.delete(id);
  }

  const incomingNodes = Array.from(incomingIds).map(id => nodeMap.get(id)).filter((n): n is Node => n !== undefined);
  const outgoingNodes = Array.from(outgoingIds).map(id => nodeMap.get(id)).filter((n): n is Node => n !== undefined);

  const layerY = [LAYOUT_HEIGHT * 0.15, CENTER_Y, LAYOUT_HEIGHT * 0.85];

  const visNodes: VisNode[] = [];
  const visNodeMap = new Map<string, VisNode>();

  const centerVisNode: VisNode = {
    node: selected,
    x: CENTER_X,
    y: layerY[1],
    baseX: CENTER_X,
    baseY: layerY[1],
    angle: 0,
    isCenter: true,
    edgeKind: '',
    direction: 'center',
    layer: 1,
    indexInLayer: 0,
    totalInLayer: 1,
    layoutRadius: 0
  };
  visNodes.push(centerVisNode);
  visNodeMap.set(selected.id, centerVisNode);

  function layoutRow(nodes: Node[], y: number, direction: 'in' | 'out', layer: number): VisNode[] {
    if (nodes.length === 0) return [];
    if (nodes.length === 1) {
      const node = nodes[0];
      return [{
        node,
        x: CENTER_X,
        y,
        baseX: CENTER_X,
        baseY: y,
        angle: 0,
        isCenter: false,
        edgeKind: '',
        direction,
        layer,
        indexInLayer: 0,
        totalInLayer: 1,
        layoutRadius: 0
      }];
    }

    const widths = nodes.map(n => getNodeVisual(n.kind, false).width);
    const totalWidth = widths.reduce((sum, w) => sum + w, 0) + (nodes.length - 1) * MIN_NODE_SPACING;
    let cursor = CENTER_X - totalWidth / 2;

    return nodes.map((node, i) => {
      const x = cursor + widths[i] / 2;
      cursor += widths[i] + MIN_NODE_SPACING;
      return {
        node,
        x,
        y,
        baseX: x,
        baseY: y,
        angle: 0,
        isCenter: false,
        edgeKind: '',
        direction,
        layer,
        indexInLayer: i,
        totalInLayer: nodes.length,
        layoutRadius: 0
      };
    });
  }

  const inVisNodes = layoutRow(incomingNodes, layerY[0], 'in', 0);
  const outVisNodes = layoutRow(outgoingNodes, layerY[2], 'out', 2);

  for (const visNode of inVisNodes) {
    visNodes.push(visNode);
    visNodeMap.set(visNode.node.id, visNode);
  }

  for (const visNode of outVisNodes) {
    visNodes.push(visNode);
    visNodeMap.set(visNode.node.id, visNode);
  }

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
        direction: edge.from === selected.id ? 'out' : 'in'
      });
    }
  }

  return { nodes: visNodes, edges: visEdges };
}
