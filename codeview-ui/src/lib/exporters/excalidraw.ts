import type { GraphRenderer, GraphScene, SceneGroup } from "#lib/renderers/graph.js";
import type { VisNode, VisEdge } from "#lib/graph/layout/index.js";
import type { LabelPosition } from "#lib/graph/labels/index.js";
import { getNodeVisual, getVisNodeEdgeAnchor } from "#lib/graph/visual/index.js";
import type { NodeVisual } from "#lib/graph/visual/index.js";
import { nodeUrl } from "#lib/url.js";

import type { ExcalidrawElement, Arrowhead } from "@excalidraw/excalidraw/element/types";

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
  type: "excalidraw";
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
  return `${prefix}_${parts.join("_")}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Excalidraw element ID for a node glyph. */
export function nodeGlyphId(nodeId: string): string {
  return deterministicId("node", nodeId);
}

/** Excalidraw element ID for a node's text label. */
export function nodeLabelId(nodeId: string): string {
  return deterministicId("nodelbl", nodeId);
}

/** Excalidraw element ID for an edge arrow. */
export function edgeArrowId(fromId: string, toId: string, kind: string): string {
  return deterministicId("edge", fromId, toId, kind);
}

/** Excalidraw element ID for an edge label. */
export function edgeLabelId(fromId: string, toId: string, kind: string): string {
  return deterministicId("elbl", fromId, toId, kind);
}

/** Map edge kinds to distinct arrowhead styles. */
export function arrowheadForEdgeKind(kind: string): Arrowhead {
  switch (kind) {
    case "Contains":
      return "diamond";
    case "Defines":
      return "diamond_outline";
    case "Implements":
      return "triangle";
    case "Derives":
      return "triangle_outline";
    case "CallsRuntime":
      return "dot";
    case "ReExports":
      return "bar";
    case "UsesType":
    case "CallsStatic":
    default:
      return "arrow";
  }
}

type ExcalidrawCustomData = {
  nodeId?: string;
  kind?: string;
  visibility?: { kind: string };
  isExternal?: boolean;
  elementRole?: string;
  fromId?: string;
  toId?: string;
  edgeKind?: string;
};

type ExcalidrawElementOverrides = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  backgroundColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  strokeStyle?: "solid" | "dashed" | "dotted";
  fillStyle?: string;
  roundness?: { type: number; value?: number } | null;
  groupIds?: string[];
  boundElements?: Array<{ id: string; type: "text" | "arrow" }> | null;
  link?: string | null;
  customData?: ExcalidrawCustomData;
  text?: string;
  originalText?: string;
  autoResize?: boolean;
  lineHeight?: number;
  fontSize?: number;
  fontFamily?: number;
  textAlign?: string;
  verticalAlign?: string;
  containerId?: string | null;
  points?: Array<[number, number]>;
  lastCommittedPoint?: [number, number] | null;
  startBinding?: { elementId: string; focus: number; gap: number } | null;
  endBinding?: { elementId: string; focus: number; gap: number } | null;
  startArrowhead?: Arrowhead | null;
  endArrowhead?: Arrowhead | null;
  elbowed?: boolean;
};

function baseElement(overrides: ExcalidrawElementOverrides): ExcalidrawElement {
  // SAFETY: ExcalidrawElement is a large discriminated union; converters pass the matching `type` plus geometry and we fill the shared base fields here.
  return {
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
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
 * Convert a VisNode to its Excalidraw glyph + text elements.
 * @param groupIds - Excalidraw group IDs this node belongs to
 */
/**
 * Map a NodeVisual glyph to the best Excalidraw element type and roundness.
 */
type ExcalidrawGlyph = {
  type: "rectangle" | "diamond" | "ellipse";
  roundness: { type: number; value?: number } | null;
};

function glyphToExcalidraw(visual: NodeVisual): ExcalidrawGlyph {
  switch (visual.glyph) {
    case "diamond":
      return { type: "diamond", roundness: null };
    case "hexagon":
      // Excalidraw has no native hexagon — use ellipse as closest approximation
      return { type: "ellipse", roundness: { type: 2 } };
    case "pill":
      return { type: "rectangle", roundness: { type: 3, value: visual.height / 2 } };
    case "rounded-rect":
      return { type: "rectangle", roundness: { type: 3, value: visual.cornerRadius } };
    case "rect":
    case "chamfered-rect":
      return {
        type: "rectangle",
        roundness: visual.cornerRadius > 0 ? { type: 3, value: visual.cornerRadius } : null,
      };
    case "parallelogram":
      // Approximate as rectangle
      return { type: "rectangle", roundness: null };
  }
}

export function nodeToExcalidraw(
  node: VisNode,
  groupIds: string[] = [],
  opts?: ExcalidrawExportOptions,
): ExcalidrawElement[] {
  const visual = getNodeVisual(node.node.kind, node.isCenter);
  const id = nodeGlyphId(node.node.id);
  const textId = nodeLabelId(node.node.id);
  const excalidrawGlyph = glyphToExcalidraw(visual);

  const link = opts?.baseUrl
    ? opts.baseUrl + nodeUrl(node.node.id, opts.crateVersions ?? {})
    : null;

  const glyphEl = baseElement({
    id,
    type: excalidrawGlyph.type,
    x: node.x - visual.width / 2,
    y: node.y - visual.height / 2,
    width: visual.width,
    height: visual.height,
    backgroundColor: visual.fill,
    strokeColor: node.isCenter ? "#3b82f6" : visual.stroke,
    strokeWidth: visual.strokeWidth,
    strokeStyle: visual.strokeDasharray ? "dashed" : "solid",
    fillStyle: "solid",
    roundness: excalidrawGlyph.roundness,
    groupIds,
    boundElements: [{ id: textId, type: "text" }],
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
    type: "text",
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
    textAlign: "center",
    verticalAlign: "middle",
    strokeColor: visual.labelColor,
    backgroundColor: "transparent",
    groupIds,
    containerId: id,
    customData: {
      nodeId: node.node.id,
      elementRole: "label",
    },
  });

  return [glyphEl, textEl];
}

/**
 * Convert a VisEdge to an Excalidraw arrow element.
 * @param groupIds - Excalidraw group IDs this edge belongs to
 */
export function edgeToExcalidraw(
  edge: VisEdge,
  nodeMap: Map<string, VisNode>,
  groupIds: string[] = [],
): ExcalidrawElement {
  const fromNode = nodeMap.get(edge.from.node.id) ?? edge.from;
  const toNode = nodeMap.get(edge.to.node.id) ?? edge.to;

  const startAnchor = getVisNodeEdgeAnchor(fromNode, toNode);
  const endAnchor = getVisNodeEdgeAnchor(toNode, fromNode);

  const relX = endAnchor.x - startAnchor.x;
  const relY = endAnchor.y - startAnchor.y;

  const edgeColor = edge.direction === "out" ? "#5b8abf" : "#94a3b8";
  const fromGlyphId = nodeGlyphId(edge.from.node.id);
  const toGlyphId = nodeGlyphId(edge.to.node.id);
  const id = edgeArrowId(edge.from.node.id, edge.to.node.id, edge.kind);

  const labelId = edgeLabelId(edge.from.node.id, edge.to.node.id, edge.kind);

  return baseElement({
    id,
    type: "arrow",
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
    startBinding: { elementId: fromGlyphId, focus: 0, gap: 4 },
    endBinding: { elementId: toGlyphId, focus: 0, gap: 4 },
    startArrowhead: null,
    endArrowhead: arrowheadForEdgeKind(edge.kind),
    elbowed: false,
    boundElements: [{ id: labelId, type: "text" }],
    customData: {
      fromId: edge.from.node.id,
      toId: edge.to.node.id,
      edgeKind: edge.kind,
      elementRole: "arrow",
    },
  });
}

/**
 * Convert an edge label to an Excalidraw text element.
 * @param groupIds - Excalidraw group IDs this label belongs to
 */
export function labelToExcalidraw(
  edge: VisEdge,
  label: LabelPosition,
  groupIds: string[] = [],
): ExcalidrawElement {
  const fontSize = 9;
  const text = edge.kind;
  const textWidth = text.length * fontSize * 0.6;
  const textHeight = fontSize * 1.4;
  const id = edgeLabelId(edge.from.node.id, edge.to.node.id, edge.kind);
  const arrowId = edgeArrowId(edge.from.node.id, edge.to.node.id, edge.kind);

  return baseElement({
    id,
    type: "text",
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
    textAlign: "center",
    verticalAlign: "middle",
    strokeColor: "#6b7280",
    backgroundColor: "transparent",
    groupIds,
    containerId: arrowId,
    customData: {
      fromId: edge.from.node.id,
      toId: edge.to.node.id,
      edgeKind: edge.kind,
      elementRole: "edgeLabel",
    },
  });
}

// ---------------------------------------------------------------------------
// Renderer implementation
// ---------------------------------------------------------------------------

/** Standalone render function that supports export options (links, etc.). */
export function renderExcalidraw(
  scene: GraphScene,
  opts?: ExcalidrawExportOptions,
): ExcalidrawFile {
  resetSeed();

  // Build node map for edge anchoring
  const nodeMap = new Map<string, VisNode>();
  for (const node of scene.nodes) {
    nodeMap.set(node.node.id, node);
  }

  // Pre-compute Excalidraw group IDs from scene groups.
  // groupId for a scene group = deterministicId('grp', group.id)
  const nodeGroupIds = new Map<number, string[]>(); // nodeIndex -> groupIds
  const edgeGroupIds = new Map<number, string[]>(); // edgeIndex -> groupIds

  for (const group of scene.groups) {
    const gid = deterministicId("grp", group.id);
    if (group.type === "node") {
      const existing = nodeGroupIds.get(group.nodeIndex) ?? [];
      existing.push(gid);
      nodeGroupIds.set(group.nodeIndex, existing);
    } else if (group.type === "edge") {
      const existing = edgeGroupIds.get(group.edgeIndex) ?? [];
      existing.push(gid);
      edgeGroupIds.set(group.edgeIndex, existing);
    }
  }

  type BoundElement = { id: string; type: "arrow" | "text" };
  type MutableGlyph = ExcalidrawElement & { boundElements: BoundElement[] | null };

  // Element lookup by ID — used to append arrow bindings to node glyphs
  const elementById = new Map<string, MutableGlyph>();
  const elements: ExcalidrawElement[] = [];

  function addElement(el: ExcalidrawElement) {
    elements.push(el);
    // SAFETY: glyphs we just inserted are mutable builder objects; ExcalidrawElement types boundElements as readonly on live scene elements.
    elementById.set(el.id, el as MutableGlyph);
  }

  // 1. Nodes (glyphs + text labels)
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

    const fromGlyph = elementById.get(nodeGlyphId(edge.from.node.id));
    const toGlyph = elementById.get(nodeGlyphId(edge.to.node.id));
    if (fromGlyph) {
      fromGlyph.boundElements = fromGlyph.boundElements ?? [];
      fromGlyph.boundElements.push({ id: arrowEl.id, type: "arrow" });
    }
    if (toGlyph) {
      toGlyph.boundElements = toGlyph.boundElements ?? [];
      toGlyph.boundElements.push({ id: arrowEl.id, type: "arrow" });
    }

    // Edge label (same group as arrow)
    const label = scene.labels[i];
    if (label) {
      addElement(labelToExcalidraw(edge, label, gids));
    }
  }

  return {
    type: "excalidraw",
    version: 2,
    source: "https://github.com/themixednuts/codeview",
    elements,
    appState: {
      viewBackgroundColor: "#ffffff",
      gridSize: null,
    },
    files: {},
  };
}

export const excalidrawRenderer: GraphRenderer<ExcalidrawFile> = {
  id: "excalidraw",
  label: "Excalidraw",

  render(scene: GraphScene): ExcalidrawFile {
    return renderExcalidraw(scene);
  },
};
