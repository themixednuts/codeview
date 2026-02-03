import type { GraphRenderer, GraphScene, SceneGroup } from '$lib/renderers/graph';
import type { VisNode, VisEdge } from '$lib/graph-layout';
import type { LabelPosition } from '$lib/labels';
import { getNodeVisual, getVisNodeEdgeAnchor } from '$lib/visual';
import type { NodeVisual } from '$lib/visual';
import { nodeUrl } from '$lib/url';

import type { ExcalidrawElement, Arrowhead } from '@excalidraw/excalidraw/element/types';

export type { ExcalidrawElement };

export type ExcalidrawExportOptions = {
  /** Base URL for node links, e.g. 'https://codeview.codes'. Omit to skip links. */
  baseUrl?: string;
  /** Crate→version map for URL generation. Falls back to 'latest'. */
  crateVersions?: Record<string, string>;
};

// Matches the .excalidraw JSON format. We keep this local since
// ExportedDataState's appState type is complex and we only need a subset.
export type ExcalidrawFile = {
  type: 'excalidraw';
  version: 2;
  source: string;
  elements: ExcalidrawElement[];
  appState: { viewBackgroundColor: string; gridSize: null };
  files: Record<string, never>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _seed = 1;
function nextSeed(): number {
  return _seed++;
}

function resetSeed(): void {
  _seed = 1;
}

/** Produce a stable element ID from a prefix + node/edge identity parts. */
export function deterministicId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${parts.join('_')}`.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Excalidraw element ID for a node shape. */
export function nodeShapeId(nodeId: string): string {
  return deterministicId('node', nodeId);
}

/** Excalidraw element ID for a node's text label. */
export function nodeLabelId(nodeId: string): string {
  return deterministicId('nodelbl', nodeId);
}

/** Excalidraw element ID for an edge arrow. */
export function edgeArrowId(fromId: string, toId: string, kind: string): string {
  return deterministicId('edge', fromId, toId, kind);
}

/** Excalidraw element ID for an edge label. */
export function edgeLabelId(fromId: string, toId: string, kind: string): string {
  return deterministicId('elbl', fromId, toId, kind);
}

/** Map edge kinds to distinct arrowhead styles. */
export function arrowheadForEdgeKind(kind: string): Arrowhead {
  switch (kind) {
    case 'Contains':
      return 'diamond';
    case 'Defines':
      return 'diamond_outline';
    case 'Implements':
      return 'triangle';
    case 'Derives':
      return 'triangle_outline';
    case 'CallsRuntime':
      return 'dot';
    case 'ReExports':
      return 'bar';
    case 'UsesType':
    case 'CallsStatic':
    default:
      return 'arrow';
  }
}

function baseElement(overrides: Record<string, unknown> & { id: string; type: string; x: number; y: number; width: number; height: number }): ExcalidrawElement {
  return {
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    roundness: null,
    index: null,
    groupIds: [],
    boundElements: null,
    seed: nextSeed(),
    version: 1,
    versionNonce: nextSeed(),
    isDeleted: false,
    frameId: null,
    link: null,
    updated: Date.now(),
    locked: false,
    ...overrides,
  } as ExcalidrawElement;
}

// ---------------------------------------------------------------------------
// Individual converters
// ---------------------------------------------------------------------------

/**
 * Convert a VisNode to its Excalidraw shape + text elements.
 * @param groupIds - Excalidraw group IDs this node belongs to
 */
/**
 * Map a NodeVisual shape to the best Excalidraw element type and roundness.
 */
function shapeToExcalidraw(visual: NodeVisual): {
  type: 'rectangle' | 'diamond' | 'ellipse';
  roundness: { type: number; value?: number } | null;
} {
  switch (visual.shape) {
    case 'diamond':
      return { type: 'diamond', roundness: null };
    case 'hexagon':
      // Excalidraw has no native hexagon — use ellipse as closest approximation
      return { type: 'ellipse', roundness: { type: 2 } };
    case 'pill':
      return { type: 'rectangle', roundness: { type: 3, value: visual.height / 2 } };
    case 'rounded-rect':
      return { type: 'rectangle', roundness: { type: 3, value: visual.cornerRadius } };
    case 'rect':
    case 'chamfered-rect':
      return {
        type: 'rectangle',
        roundness: visual.cornerRadius > 0 ? { type: 3, value: visual.cornerRadius } : null,
      };
    case 'parallelogram':
      // Approximate as rectangle
      return { type: 'rectangle', roundness: null };
  }
}

export function nodeToExcalidraw(node: VisNode, groupIds: string[] = [], opts?: ExcalidrawExportOptions): ExcalidrawElement[] {
  const visual = getNodeVisual(node.node.kind, node.isCenter);
  const id = nodeShapeId(node.node.id);
  const textId = nodeLabelId(node.node.id);
  const excaShape = shapeToExcalidraw(visual);

  const link = opts?.baseUrl
    ? opts.baseUrl + nodeUrl(node.node.id, opts.crateVersions ?? {})
    : null;

  const shapeEl = baseElement({
    id,
    type: excaShape.type,
    x: node.x - visual.width / 2,
    y: node.y - visual.height / 2,
    width: visual.width,
    height: visual.height,
    backgroundColor: visual.fill,
    strokeColor: node.isCenter ? '#3b82f6' : visual.stroke,
    strokeWidth: visual.strokeWidth,
    strokeStyle: visual.strokeDasharray ? 'dashed' : 'solid',
    fillStyle: 'solid',
    roundness: excaShape.roundness,
    groupIds,
    boundElements: [{ id: textId, type: 'text' }],
    link,
    customData: {
      nodeId: node.node.id,
      kind: node.node.kind,
      visibility: node.node.visibility,
      isExternal: node.node.is_external ?? false,
    },
  });

  const fontSize = visual.labelFontSize;
  const labelText = node.node.name;
  const textWidth = labelText.length * fontSize * 0.6;
  const textHeight = fontSize * 1.4;

  const textEl = baseElement({
    id: textId,
    type: 'text',
    x: node.x - textWidth / 2,
    y: node.y - textHeight / 2,
    width: textWidth,
    height: textHeight,
    text: labelText,
    originalText: labelText,
    autoResize: true,
    lineHeight: 1.25,
    fontSize,
    fontFamily: 1,
    textAlign: 'center',
    verticalAlign: 'middle',
    strokeColor: visual.labelColor,
    backgroundColor: 'transparent',
    groupIds,
    containerId: id,
    customData: {
      nodeId: node.node.id,
      elementRole: 'label',
    },
  });

  return [shapeEl, textEl];
}

/**
 * Convert a VisEdge to an Excalidraw arrow element.
 * @param groupIds - Excalidraw group IDs this edge belongs to
 */
export function edgeToExcalidraw(edge: VisEdge, nodeMap: Map<string, VisNode>, groupIds: string[] = []): ExcalidrawElement {
  const fromNode = nodeMap.get(edge.from.node.id) ?? edge.from;
  const toNode = nodeMap.get(edge.to.node.id) ?? edge.to;

  const startAnchor = getVisNodeEdgeAnchor(fromNode, toNode);
  const endAnchor = getVisNodeEdgeAnchor(toNode, fromNode);

  const relX = endAnchor.x - startAnchor.x;
  const relY = endAnchor.y - startAnchor.y;

  const edgeColor = edge.direction === 'out' ? '#5b8abf' : '#94a3b8';
  const fromShapeId = nodeShapeId(edge.from.node.id);
  const toShapeId = nodeShapeId(edge.to.node.id);
  const id = edgeArrowId(edge.from.node.id, edge.to.node.id, edge.kind);

  const labelId = edgeLabelId(edge.from.node.id, edge.to.node.id, edge.kind);

  return baseElement({
    id,
    type: 'arrow',
    x: startAnchor.x,
    y: startAnchor.y,
    width: relX,
    height: relY,
    strokeColor: edgeColor,
    groupIds,
    points: [
      [0, 0],
      [relX, relY],
    ],
    lastCommittedPoint: null,
    startBinding: { elementId: fromShapeId, focus: 0, gap: 4 },
    endBinding: { elementId: toShapeId, focus: 0, gap: 4 },
    startArrowhead: null,
    endArrowhead: arrowheadForEdgeKind(edge.kind),
    elbowed: false,
    boundElements: [{ id: labelId, type: 'text' }],
    customData: {
      fromId: edge.from.node.id,
      toId: edge.to.node.id,
      edgeKind: edge.kind,
      elementRole: 'arrow',
    },
  });
}

/**
 * Convert an edge label to an Excalidraw text element.
 * @param groupIds - Excalidraw group IDs this label belongs to
 */
export function labelToExcalidraw(edge: VisEdge, label: LabelPosition, groupIds: string[] = []): ExcalidrawElement {
  const fontSize = 9;
  const text = edge.kind;
  const textWidth = text.length * fontSize * 0.6;
  const textHeight = fontSize * 1.4;
  const id = edgeLabelId(edge.from.node.id, edge.to.node.id, edge.kind);
  const arrowId = edgeArrowId(edge.from.node.id, edge.to.node.id, edge.kind);

  return baseElement({
    id,
    type: 'text',
    x: label.x - textWidth / 2,
    y: label.y - textHeight / 2,
    width: textWidth,
    height: textHeight,
    text,
    originalText: text,
    autoResize: true,
    lineHeight: 1.25,
    fontSize,
    fontFamily: 1,
    textAlign: 'center',
    verticalAlign: 'middle',
    strokeColor: '#6b7280',
    backgroundColor: 'transparent',
    groupIds,
    containerId: arrowId,
    customData: {
      fromId: edge.from.node.id,
      toId: edge.to.node.id,
      edgeKind: edge.kind,
      elementRole: 'edgeLabel',
    },
  });
}

// ---------------------------------------------------------------------------
// Renderer implementation
// ---------------------------------------------------------------------------

/** Standalone render function that supports export options (links, etc.). */
export function renderExcalidraw(scene: GraphScene, opts?: ExcalidrawExportOptions): ExcalidrawFile {
  resetSeed();

  // Build node map for edge anchoring
  const nodeMap = new Map<string, VisNode>();
  for (const node of scene.nodes) {
    nodeMap.set(node.node.id, node);
  }

  // Pre-compute Excalidraw group IDs from scene groups.
  // groupId for a scene group = deterministicId('grp', group.id)
  const nodeGroupIds = new Map<number, string[]>();   // nodeIndex -> groupIds
  const edgeGroupIds = new Map<number, string[]>();   // edgeIndex -> groupIds

  for (const group of scene.groups) {
    const gid = deterministicId('grp', group.id);
    if (group.type === 'node') {
      const existing = nodeGroupIds.get(group.nodeIndex) ?? [];
      existing.push(gid);
      nodeGroupIds.set(group.nodeIndex, existing);
    } else if (group.type === 'edge') {
      const existing = edgeGroupIds.get(group.edgeIndex) ?? [];
      existing.push(gid);
      edgeGroupIds.set(group.edgeIndex, existing);
    }
  }

  // Element lookup by ID — used to append arrow bindings to node shapes
  const elementById = new Map<string, ExcalidrawElement>();
  const elements: ExcalidrawElement[] = [];

  function addElement(el: ExcalidrawElement) {
    elements.push(el);
    elementById.set(el.id, el);
  }

  // 1. Nodes (shapes + text labels)
  for (let i = 0; i < scene.nodes.length; i++) {
    const gids = nodeGroupIds.get(i) ?? [];
    for (const el of nodeToExcalidraw(scene.nodes[i], gids, opts)) {
      addElement(el);
    }
  }

  // 2. Edges (arrows) + labels
  for (let i = 0; i < scene.edges.length; i++) {
    const edge = scene.edges[i];
    const gids = edgeGroupIds.get(i) ?? [];

    const arrowEl = edgeToExcalidraw(edge, nodeMap, gids);
    addElement(arrowEl);

    // Register arrow as a bound element on both endpoint shapes.
    // We cast to mutable because we're building elements, not editing live state.
    const fromShape = elementById.get(nodeShapeId(edge.from.node.id)) as
      | (ExcalidrawElement & { boundElements: { id: string; type: 'arrow' | 'text' }[] | null })
      | undefined;
    const toShape = elementById.get(nodeShapeId(edge.to.node.id)) as
      | (ExcalidrawElement & { boundElements: { id: string; type: 'arrow' | 'text' }[] | null })
      | undefined;
    if (fromShape) {
      fromShape.boundElements = fromShape.boundElements ?? [];
      fromShape.boundElements.push({ id: arrowEl.id, type: 'arrow' });
    }
    if (toShape) {
      toShape.boundElements = toShape.boundElements ?? [];
      toShape.boundElements.push({ id: arrowEl.id, type: 'arrow' });
    }

    // Edge label (same group as arrow)
    const label = scene.labels[i];
    if (label) {
      addElement(labelToExcalidraw(edge, label, gids));
    }
  }

  return {
    type: 'excalidraw',
    version: 2,
    source: 'https://github.com/nicholasgasior/codeview',
    elements,
    appState: {
      viewBackgroundColor: '#ffffff',
      gridSize: null,
    },
    files: {},
  };
}

export const excalidrawRenderer: GraphRenderer<ExcalidrawFile> = {
  id: 'excalidraw',
  label: 'Excalidraw',

  render(scene: GraphScene): ExcalidrawFile {
    return renderExcalidraw(scene);
  },
};
