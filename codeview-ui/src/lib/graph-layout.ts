import type { Graph, Node, NodeKind } from './graph';

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
export const CIRCLE_RADIUS = 24;
export const CENTER_CIRCLE_RADIUS = 34;
export const RECT_NODE_WIDTH = 132;
export const RECT_NODE_HEIGHT = 44;

export const RECT_NODE_KINDS = new Set<NodeKind>(['Struct', 'Enum', 'Union']);

export function getNodeDimensions(node: Node, isCenter: boolean): {
  width: number;
  height: number;
  isRect: boolean;
} {
  const isRect = RECT_NODE_KINDS.has(node.kind);
  if (isRect) {
    const scale = isCenter ? 1.12 : 1;
    return {
      width: RECT_NODE_WIDTH * scale,
      height: RECT_NODE_HEIGHT * scale,
      isRect
    };
  }
  const radius = isCenter ? CENTER_CIRCLE_RADIUS : CIRCLE_RADIUS;
  return {
    width: radius * 2,
    height: radius * 2,
    isRect
  };
}

export function getEdgeAnchor(fromNode: VisNode, toNode: VisNode): { x: number; y: number } {
  const dims = getNodeDimensions(fromNode.node, fromNode.isCenter);
  const dx = toNode.x - fromNode.x;
  const dy = toNode.y - fromNode.y;
  if (dx === 0 && dy === 0) {
    return { x: fromNode.x, y: fromNode.y };
  }
  if (dims.isRect) {
    const side = dx >= 0 ? 1 : -1;
    return {
      x: fromNode.x + (dims.width / 2) * side,
      y: fromNode.y
    };
  }
  const radius = dims.width / 2;
  const distance = Math.hypot(dx, dy) || 1;
  return {
    x: fromNode.x + (dx / distance) * radius,
    y: fromNode.y + (dy / distance) * radius
  };
}

export function computeLayout(graph: Graph, selected: Node, mode: LayoutMode): { nodes: VisNode[]; edges: VisEdge[] } {
  switch (mode) {
    case 'ego':
      return computeEgoLayout(graph, selected);
    case 'force':
      return computeForceLayout(graph, selected);
    case 'hierarchical':
      return computeHierarchicalLayout(graph, selected);
    case 'radial':
      return computeRadialLayout(graph, selected);
    default:
      return computeEgoLayout(graph, selected);
  }
}

function computeEgoLayout(graph: Graph, selected: Node): { nodes: VisNode[]; edges: VisEdge[] } {
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

  const centerDims = getNodeDimensions(selected, true);
  const incomingWidths = inArray.map((entry) => getNodeDimensions(entry.node, false).width);
  const outgoingWidths = outArray.map((entry) => getNodeDimensions(entry.node, false).width);
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
    const heights = entries.map((entry) => getNodeDimensions(entry.node, false).height);
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

function computeForceLayout(graph: Graph, selected: Node): { nodes: VisNode[]; edges: VisEdge[] } {
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
    .map(id => nodeMap.get(id))
    .filter((n): n is Node => n !== undefined);

  if (nodesToLayout.length === 0) {
    return { nodes: [], edges: [] };
  }

  const positions = new Map<string, { x: number; y: number }>();
  nodesToLayout.forEach((node, i) => {
    if (node.id === selected.id) {
      positions.set(node.id, { x: CENTER_X, y: CENTER_Y });
    } else {
      const angle = (2 * Math.PI * i) / nodesToLayout.length;
      positions.set(node.id, {
        x: CENTER_X + FORCE_RADIUS * Math.cos(angle),
        y: CENTER_Y + FORCE_RADIUS * Math.sin(angle)
      });
    }
  });

  const iterations = 50;
  const repulsion = 5000;
  const attraction = 0.05;
  const damping = 0.9;

  const velocities = new Map<string, { vx: number; vy: number }>();
  nodesToLayout.forEach(n => velocities.set(n.id, { vx: 0, vy: 0 }));

  for (let iter = 0; iter < iterations; iter++) {
    const forces = new Map<string, { fx: number; fy: number }>();
    nodesToLayout.forEach(n => forces.set(n.id, { fx: 0, fy: 0 }));

    for (let i = 0; i < nodesToLayout.length; i++) {
      for (let j = i + 1; j < nodesToLayout.length; j++) {
        const a = nodesToLayout[i];
        const b = nodesToLayout[j];
        const posA = positions.get(a.id)!;
        const posB = positions.get(b.id)!;
        const dx = posB.x - posA.x;
        const dy = posB.y - posA.y;
        const dist = Math.max(1, Math.hypot(dx, dy));
        const force = repulsion / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        forces.get(a.id)!.fx -= fx;
        forces.get(a.id)!.fy -= fy;
        forces.get(b.id)!.fx += fx;
        forces.get(b.id)!.fy += fy;
      }
    }

    for (const edge of graph.edges) {
      if (!connectedIds.has(edge.from) || !connectedIds.has(edge.to)) continue;
      const posA = positions.get(edge.from);
      const posB = positions.get(edge.to);
      if (!posA || !posB) continue;
      const dx = posB.x - posA.x;
      const dy = posB.y - posA.y;
      const fx = dx * attraction;
      const fy = dy * attraction;
      if (forces.has(edge.from)) {
        forces.get(edge.from)!.fx += fx;
        forces.get(edge.from)!.fy += fy;
      }
      if (forces.has(edge.to)) {
        forces.get(edge.to)!.fx -= fx;
        forces.get(edge.to)!.fy -= fy;
      }
    }

    for (const node of nodesToLayout) {
      if (node.id === selected.id) continue;
      const vel = velocities.get(node.id)!;
      const force = forces.get(node.id)!;
      vel.vx = (vel.vx + force.fx) * damping;
      vel.vy = (vel.vy + force.fy) * damping;
      const pos = positions.get(node.id)!;
      pos.x = Math.max(50, Math.min(LAYOUT_WIDTH - 50, pos.x + vel.vx));
      pos.y = Math.max(50, Math.min(LAYOUT_HEIGHT - 50, pos.y + vel.vy));
    }
  }

  const visNodes: VisNode[] = [];
  const visNodeMap = new Map<string, VisNode>();

  for (const node of nodesToLayout) {
    const pos = positions.get(node.id)!;
    const isCenter = node.id === selected.id;
    const visNode: VisNode = {
      node,
      x: pos.x,
      y: pos.y,
      baseX: pos.x,
      baseY: pos.y,
      angle: 0,
      isCenter,
      edgeKind: '',
      direction: isCenter ? 'center' : 'out',
      layer: 0,
      indexInLayer: 0,
      totalInLayer: 1,
      layoutRadius: 0
    };
    visNodes.push(visNode);
    visNodeMap.set(node.id, visNode);
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
        direction: edge.from === selected.id ? 'out' : 'in'
      });
    }
  }

  return { nodes: visNodes, edges: visEdges };
}

function computeHierarchicalLayout(graph: Graph, selected: Node): { nodes: VisNode[]; edges: VisEdge[] } {
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

  incomingNodes.forEach((node, i) => {
    const x = incomingNodes.length === 1
      ? CENTER_X
      : 100 + (LAYOUT_WIDTH - 200) * i / (incomingNodes.length - 1);
    const visNode: VisNode = {
      node,
      x,
      y: layerY[0],
      baseX: x,
      baseY: layerY[0],
      angle: 0,
      isCenter: false,
      edgeKind: '',
      direction: 'in',
      layer: 0,
      indexInLayer: i,
      totalInLayer: incomingNodes.length,
      layoutRadius: 0
    };
    visNodes.push(visNode);
    visNodeMap.set(node.id, visNode);
  });

  outgoingNodes.forEach((node, i) => {
    const x = outgoingNodes.length === 1
      ? CENTER_X
      : 100 + (LAYOUT_WIDTH - 200) * i / (outgoingNodes.length - 1);
    const visNode: VisNode = {
      node,
      x,
      y: layerY[2],
      baseX: x,
      baseY: layerY[2],
      angle: 0,
      isCenter: false,
      edgeKind: '',
      direction: 'out',
      layer: 2,
      indexInLayer: i,
      totalInLayer: outgoingNodes.length,
      layoutRadius: 0
    };
    visNodes.push(visNode);
    visNodeMap.set(node.id, visNode);
  });

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

function computeRadialLayout(graph: Graph, selected: Node): { nodes: VisNode[]; edges: VisEdge[] } {
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

  const surroundingNodes = Array.from(connectedIds)
    .filter(id => id !== selected.id)
    .map(id => nodeMap.get(id))
    .filter((n): n is Node => n !== undefined);

  const visNodes: VisNode[] = [];
  const visNodeMap = new Map<string, VisNode>();

  const centerVisNode: VisNode = {
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
  visNodes.push(centerVisNode);
  visNodeMap.set(selected.id, centerVisNode);

  const radius = RADIAL_RADIUS;
  surroundingNodes.forEach((node, i) => {
    const angle = (2 * Math.PI * i) / surroundingNodes.length - Math.PI / 2;
    const x = CENTER_X + radius * Math.cos(angle);
    const y = CENTER_Y + radius * Math.sin(angle);

    let direction: 'in' | 'out' = 'out';
    for (const edge of graph.edges) {
      if (edge.to === selected.id && edge.from === node.id) {
        direction = 'in';
        break;
      }
    }

    const visNode: VisNode = {
      node,
      x,
      y,
      baseX: x,
      baseY: y,
      angle,
      isCenter: false,
      edgeKind: '',
      direction,
      layer: 1,
      indexInLayer: i,
      totalInLayer: surroundingNodes.length,
      layoutRadius: radius
    };
    visNodes.push(visNode);
    visNodeMap.set(node.id, visNode);
  });

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

function formatEdgeKinds(kinds: string[]): string {
  return Array.from(new Set(kinds)).join(', ');
}
