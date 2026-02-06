import type { Graph, Node } from '$lib/graph';
import type { VisNode, VisEdge } from './types';
import { CENTER_X, CENTER_Y, LAYOUT_WIDTH, LAYOUT_HEIGHT, FORCE_RADIUS, MIN_NODE_SPACING } from './types';
import { getNodeBoundingBox, resolveCollisions } from './collision';

export function computeForceLayout(graph: Graph, selected: Node): { nodes: VisNode[]; edges: VisEdge[] } {
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
  const baseRepulsion = 5000;
  const attraction = 0.05;
  const damping = 0.9;

  const nodeRadii = new Map<string, number>();
  for (const node of nodesToLayout) {
    const box = getNodeBoundingBox(node, node.id === selected.id);
    nodeRadii.set(node.id, Math.max(box.width, box.height) / 2);
  }

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

        const radiusA = nodeRadii.get(a.id) || 24;
        const radiusB = nodeRadii.get(b.id) || 24;
        const minDist = radiusA + radiusB + MIN_NODE_SPACING;
        const repulsionScale = Math.max(1, minDist / 40);
        const repulsion = baseRepulsion * repulsionScale;

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
