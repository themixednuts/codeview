import type { Edge, EdgeKind, Graph, Node } from '$lib/graph';
import type { LayoutMode, VisEdge, VisNode } from '$lib/graph-layout';
import type { LabelPosition, SimilarityInfo } from '$lib/labels';
import { computeLayout } from '$lib/graph-layout';
import { getLabelProvider, computeAllLabelPositions } from '$lib/labels';

/**
 * A logical group of scene elements that belong together.
 * Renderers use this to express grouping (e.g. Excalidraw groupIds,
 * SVG data-group attributes) so that grouped elements move/select as one unit.
 */
export type SceneGroup =
  | {
      /** Stable identifier derived from the node identity. */
      id: string;
      type: 'node';
      /** Index into `scene.nodes`. */
      nodeIndex: number;
    }
  | {
      /** Stable identifier derived from the edge identity. */
      id: string;
      type: 'edge';
      /** Index into `scene.edges`. */
      edgeIndex: number;
      /** Index into `scene.labels` (always matches edgeIndex when label exists). */
      labelIndex: number | undefined;
    };

/** The positioned, ready-to-render scene produced by computeLayout + label positioning. */
export type GraphScene = {
  nodes: VisNode[];
  edges: VisEdge[];
  labels: LabelPosition[];
  groups: SceneGroup[];
  mode: LayoutMode;
};

/** What a renderer can do with a scene. */
export interface GraphRenderer<T> {
  readonly id: string;
  readonly label: string;
  render(scene: GraphScene): T;
}

// ---------------------------------------------------------------------------
// Edge kind constants (single source of truth)
// ---------------------------------------------------------------------------

export const structuralEdgeKinds: readonly EdgeKind[] = ['Contains', 'Defines'];
export const semanticEdgeKinds: readonly EdgeKind[] = ['UsesType', 'Implements', 'CallsStatic', 'CallsRuntime', 'Derives'];

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Filter edges by structural/semantic toggles. */
export function filterEdges(
  edges: Edge[],
  opts: { showStructural: boolean; showSemantic: boolean }
): Edge[] {
  return edges.filter((edge: Edge) => {
    if ((structuralEdgeKinds as readonly string[]).includes(edge.kind)) return opts.showStructural;
    if ((semanticEdgeKinds as readonly string[]).includes(edge.kind)) return opts.showSemantic;
    return true;
  });
}

/** Build a lookup map from node id → VisNode. */
export function buildNodeMap(nodes: VisNode[]): Map<string, VisNode> {
  const map = new Map<string, VisNode>();
  for (const node of nodes) {
    map.set(node.node.id, node);
  }
  return map;
}

/** Compute edge angle similarity groups for label layout. */
export function computeEdgeSimilarityGroups(
  edges: VisEdge[],
  nodeMap: Map<string, VisNode>
): Map<number, SimilarityInfo> {
  if (edges.length === 0) return new Map();

  type EdgeAngle = { index: number; angle: number; direction: string };
  const edgeAngles: EdgeAngle[] = edges.map((edge, i) => {
    const fromNode = nodeMap.get(edge.from.node.id) ?? edge.from;
    const toNode = nodeMap.get(edge.to.node.id) ?? edge.to;
    const dx = toNode.x - fromNode.x;
    const dy = toNode.y - fromNode.y;
    return { index: i, angle: Math.atan2(dy, dx), direction: edge.direction };
  });

  const sorted = [...edgeAngles].sort((a, b) => {
    if (a.direction !== b.direction) return a.direction < b.direction ? -1 : 1;
    return a.angle - b.angle;
  });

  const result = new Map<number, SimilarityInfo>();
  let groupStart = 0;
  while (groupStart < sorted.length) {
    const group: number[] = [sorted[groupStart].index];
    let groupEnd = groupStart + 1;
    while (
      groupEnd < sorted.length &&
      sorted[groupEnd].direction === sorted[groupStart].direction &&
      Math.abs(sorted[groupEnd].angle - sorted[groupStart].angle) < 0.35
    ) {
      group.push(sorted[groupEnd].index);
      groupEnd++;
    }
    for (let k = 0; k < group.length; k++) {
      result.set(group[k], { group, indexOf: k });
    }
    groupStart = groupEnd;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Stage 1: Base scene (layout + similarity groups). Expensive, cache behind KeyedMemo.
// ---------------------------------------------------------------------------

/** The layout-computed scene before label positioning. Immune to drag offsets. */
export type BaseScene = {
  nodes: VisNode[];
  edges: VisEdge[];
  groups: SceneGroup[];
  similarityGroups: Map<number, SimilarityInfo>;
  mode: LayoutMode;
};

/**
 * Build the base scene: filter edges, run layout, compute similarity groups and scene groups.
 * This is the expensive stage — cache it behind a KeyedMemo keyed on
 * (graph, selected.id, layoutMode, showStructural, showSemantic).
 */
export function buildBaseScene(
  graph: Graph,
  selected: Node,
  layoutMode: LayoutMode,
  opts: { showStructural: boolean; showSemantic: boolean }
): BaseScene {
  const filteredEdges = filterEdges(graph.edges, opts);
  const filteredGraph: Graph = { nodes: graph.nodes, edges: filteredEdges };

  const visData = computeLayout(filteredGraph, selected, layoutMode);

  const nodeMap = buildNodeMap(visData.nodes);
  const similarityGroups = computeEdgeSimilarityGroups(visData.edges, nodeMap);

  // Build groups — one per node, one per edge
  const groups: SceneGroup[] = [];

  for (let i = 0; i < visData.nodes.length; i++) {
    groups.push({
      id: `node:${visData.nodes[i].node.id}`,
      type: 'node',
      nodeIndex: i,
    });
  }

  for (let i = 0; i < visData.edges.length; i++) {
    const edge = visData.edges[i];
    groups.push({
      id: `edge:${edge.from.node.id}:${edge.to.node.id}:${edge.kind}`,
      type: 'edge',
      edgeIndex: i,
      // labelIndex will be filled in by buildScene; for BaseScene it's provisional
      labelIndex: i,
    });
  }

  return {
    nodes: visData.nodes,
    edges: visData.edges,
    groups,
    similarityGroups,
    mode: layoutMode,
  };
}

// ---------------------------------------------------------------------------
// Stage 2: Label positions. Cheap, recomputes with drag-aware positions.
// ---------------------------------------------------------------------------

/** Hook interface for renderer-specific adjustments. */
export interface SceneHook {
  adjustLabels?(positions: LabelPosition[], ctx: {
    baseScene: BaseScene;
    positionedNodeMap: Map<string, VisNode>;
  }): void;
  expandNeighbors?(hoveredNodeId: string, ctx: { baseScene: BaseScene }): Set<string>;
}

/**
 * Compute label positions from a base scene + drag-aware node positions.
 * This is cheap and recomputes each drag frame.
 */
export function computeSceneLabels(
  baseScene: BaseScene,
  positionedNodeMap: Map<string, VisNode>,
  getMetrics?: (kind: string) => { width: number },
  hook?: SceneHook
): LabelPosition[] {
  const defaultGetMetrics = (kind: string) => {
    const fontSize = 9;
    const paddingX = 6;
    const textWidth = kind.length * fontSize * 0.6;
    return { width: Math.max(28, textWidth + paddingX * 2) };
  };

  const provider = getLabelProvider(baseScene.mode);
  const labels = computeAllLabelPositions(
    provider,
    baseScene.edges,
    positionedNodeMap,
    baseScene.similarityGroups,
    getMetrics ?? defaultGetMetrics
  );

  hook?.adjustLabels?.(labels, { baseScene, positionedNodeMap });

  return labels;
}

// ---------------------------------------------------------------------------
// Composed buildScene — thin wrapper for exporters
// ---------------------------------------------------------------------------

/**
 * Build a complete GraphScene from raw graph data + current UI state.
 * Composes buildBaseScene + computeSceneLabels.
 * Exporters call this; the SVG component calls the stages separately for granular caching.
 */
export function buildScene(
  graph: Graph,
  selected: Node,
  layoutMode: LayoutMode,
  opts: { showStructural: boolean; showSemantic: boolean }
): GraphScene {
  const base = buildBaseScene(graph, selected, layoutMode, opts);
  const nodeMap = buildNodeMap(base.nodes);
  const labels = computeSceneLabels(base, nodeMap);

  return {
    nodes: base.nodes,
    edges: base.edges,
    labels,
    groups: base.groups,
    mode: base.mode,
  };
}
