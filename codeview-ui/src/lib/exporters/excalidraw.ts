import type { GraphRenderer, GraphScene, SceneGroup } from '$lib/renderers/graph';
import type { VisNode, VisEdge } from '$lib/graph-layout';
import type { LabelPosition } from '$lib/labels';
import { getNodeVisual, getVisNodeEdgeAnchor } from '$lib/visual';
import type { NodeVisual } from '$lib/visual';

// ---------------------------------------------------------------------------
// Excalidraw types (subset needed for export)
// ---------------------------------------------------------------------------

export type ExcalidrawElement = {
  id: string;
  type: 'rectangle' | 'ellipse' | 'arrow' | 'text';
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  strokeColor: string;
  backgroundColor: string;
  fillStyle: 'solid' | 'hachure' | 'cross-hatch';
  strokeWidth: number;
  roughness: number;
  opacity: number;
  roundness: { type: number; value?: number } | null;
  // Text-specific
  text?: string;
  fontSize?: number;
  fontFamily?: number;
  textAlign?: string;
  verticalAlign?: string;
  // Arrow-specific
  points?: [number, number][];
  startBinding?: { elementId: string; focus: number; gap: number } | null;
  endBinding?: { elementId: string; focus: number; gap: number } | null;
  startArrowhead?: string | null;
  endArrowhead?: string | null;
  // Grouping
  groupIds: string[];
  boundElements: { id: string; type: string }[] | null;
  containerId?: string | null;
  seed: number;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
  frameId: null;
  link: null;
  updated: number;
  locked: boolean;
};

export type ExcalidrawFile = {
  type: 'excalidraw';
  version: 2;
  source: string;
  elements: ExcalidrawElement[];
  appState: {
    viewBackgroundColor: string;
    gridSize: null;
  };
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

function baseElement(overrides: Partial<ExcalidrawElement> & Pick<ExcalidrawElement, 'id' | 'type' | 'x' | 'y' | 'width' | 'height'>): ExcalidrawElement {
  return {
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    roughness: 0,
    opacity: 100,
    roundness: null,
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
  };
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
  type: ExcalidrawElement['type'];
  roundness: ExcalidrawElement['roundness'];
} {
  switch (visual.shape) {
    case 'diamond':
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

export function nodeToExcalidraw(node: VisNode, groupIds: string[] = []): ExcalidrawElement[] {
  const visual = getNodeVisual(node.node.kind, node.isCenter);
  const id = nodeShapeId(node.node.id);
  const textId = nodeLabelId(node.node.id);
  const excaShape = shapeToExcalidraw(visual);

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
    fillStyle: 'solid',
    roundness: excaShape.roundness,
    groupIds,
    boundElements: [{ id: textId, type: 'text' }],
  });

  // Apply dashed stroke for Union nodes
  if (visual.strokeDasharray) {
    (shapeEl as any).strokeStyle = 'dashed';
  }

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
    fontSize,
    fontFamily: 1,
    textAlign: 'center',
    verticalAlign: 'middle',
    strokeColor: visual.labelColor,
    backgroundColor: 'transparent',
    groupIds,
    containerId: id,
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
    startBinding: { elementId: fromShapeId, focus: 0, gap: 4 },
    endBinding: { elementId: toShapeId, focus: 0, gap: 4 },
    startArrowhead: null,
    endArrowhead: 'arrow',
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

  return baseElement({
    id,
    type: 'text',
    x: label.x - textWidth / 2,
    y: label.y - textHeight / 2,
    width: textWidth,
    height: textHeight,
    text,
    fontSize,
    fontFamily: 1,
    textAlign: 'center',
    verticalAlign: 'middle',
    strokeColor: '#6b7280',
    backgroundColor: 'transparent',
    groupIds,
  });
}

// ---------------------------------------------------------------------------
// Renderer implementation
// ---------------------------------------------------------------------------

export const excalidrawRenderer: GraphRenderer<ExcalidrawFile> = {
  id: 'excalidraw',
  label: 'Excalidraw',

  render(scene: GraphScene): ExcalidrawFile {
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
      for (const el of nodeToExcalidraw(scene.nodes[i], gids)) {
        addElement(el);
      }
    }

    // 2. Edges (arrows) + labels
    for (let i = 0; i < scene.edges.length; i++) {
      const edge = scene.edges[i];
      const gids = edgeGroupIds.get(i) ?? [];

      const arrowEl = edgeToExcalidraw(edge, nodeMap, gids);
      addElement(arrowEl);

      // Register arrow as a bound element on both endpoint shapes
      const fromShape = elementById.get(nodeShapeId(edge.from.node.id));
      const toShape = elementById.get(nodeShapeId(edge.to.node.id));
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
  },
};
