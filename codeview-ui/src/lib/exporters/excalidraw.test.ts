import { describe, it, expect } from 'vitest';
import {
  nodeToExcalidraw,
  edgeToExcalidraw,
  labelToExcalidraw,
  excalidrawRenderer,
  renderExcalidraw,
  nodeShapeId,
  edgeArrowId,
  edgeLabelId,
  arrowheadForEdgeKind,
} from './excalidraw';
import type { VisNode, VisEdge } from '$lib/graph-layout';
import type { Node } from '$lib/graph';
import type { GraphScene, SceneGroup } from '$lib/renderers/graph';
import type { LabelPosition } from '$lib/labels';
import type {
  ExcalidrawTextElement,
  ExcalidrawArrowElement,
} from '@excalidraw/excalidraw/element/types';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeRawNode(id: string, name: string, kind: Node['kind'] = 'Function'): Node {
  return { id, name, kind, visibility: 'Public' } as Node;
}

function makeVisNode(
  id: string,
  name: string,
  kind: Node['kind'],
  opts: Partial<VisNode> = {}
): VisNode {
  return {
    node: makeRawNode(id, name, kind),
    x: 350,
    y: 250,
    baseX: 350,
    baseY: 250,
    angle: 0,
    isCenter: false,
    edgeKind: '',
    direction: 'out',
    layer: 0,
    indexInLayer: 0,
    totalInLayer: 1,
    layoutRadius: 0,
    ...opts,
  };
}

function makeVisEdge(from: VisNode, to: VisNode, kind: string = 'UsesType', direction: 'in' | 'out' = 'out'): VisEdge {
  return { from, to, kind, direction };
}

// ---------------------------------------------------------------------------
// nodeToExcalidraw
// ---------------------------------------------------------------------------

describe('nodeToExcalidraw', () => {
  it('returns a shape + text element for a rect node (Struct)', () => {
    const vis = makeVisNode('crate::MyStruct', 'MyStruct', 'Struct', { isCenter: true });
    const elements = nodeToExcalidraw(vis);

    expect(elements).toHaveLength(2);
    const [shape, text] = elements;

    expect(shape.type).toBe('rectangle');
    expect(shape.fillStyle).toBe('solid');
    expect(shape.backgroundColor).not.toBe('transparent');
    expect(shape.strokeWidth).toBe(3); // center node
    expect(shape.roundness).toEqual({ type: 3, value: 2 });

    expect(text.type).toBe('text');
    const txt = text as ExcalidrawTextElement;
    expect(txt.text).toBe('MyStruct');
    expect(txt.containerId).toBe(shape.id);
  });

  it('returns a pill (rectangle) for a Function node', () => {
    const vis = makeVisNode('crate::do_thing', 'do_thing', 'Function');
    const elements = nodeToExcalidraw(vis);

    const [shape] = elements;
    expect(shape.type).toBe('rectangle');
    expect(shape.strokeWidth).toBe(2); // non-center
    expect(shape.roundness).toEqual({ type: 3, value: 22 });
  });

  it('binds the text element back to the shape', () => {
    const vis = makeVisNode('crate::X', 'X', 'Enum');
    const [shape, text] = nodeToExcalidraw(vis);

    expect(shape.boundElements).toContainEqual({ id: text.id, type: 'text' });
    expect((text as ExcalidrawTextElement).containerId).toBe(shape.id);
  });

  it('produces deterministic IDs from node identity', () => {
    const vis = makeVisNode('crate::Foo', 'Foo', 'Struct');
    const a = nodeToExcalidraw(vis);
    const b = nodeToExcalidraw(vis);
    expect(a[0].id).toBe(b[0].id);
    expect(a[1].id).toBe(b[1].id);
  });

  it('propagates groupIds to both shape and text', () => {
    const vis = makeVisNode('crate::A', 'A', 'Struct');
    const gids = ['group_1', 'group_2'];
    const [shape, text] = nodeToExcalidraw(vis, gids);

    expect(shape.groupIds).toEqual(gids);
    expect(text.groupIds).toEqual(gids);
  });

  it('defaults to empty groupIds when none provided', () => {
    const vis = makeVisNode('crate::A', 'A', 'Struct');
    const [shape, text] = nodeToExcalidraw(vis);
    expect(shape.groupIds).toEqual([]);
    expect(text.groupIds).toEqual([]);
  });

  it('returns a diamond for a Trait node', () => {
    const vis = makeVisNode('crate::T', 'T', 'Trait');
    const [shape] = nodeToExcalidraw(vis);
    expect(shape.type).toBe('diamond');
  });

  it('returns dashed strokeStyle for a Union node', () => {
    const vis = makeVisNode('crate::U', 'U', 'Union');
    const [shape] = nodeToExcalidraw(vis);
    expect((shape as Record<string, unknown>).strokeStyle).toBe('dashed');
  });

  it('returns solid strokeStyle for non-Union nodes', () => {
    const vis = makeVisNode('crate::S', 'S', 'Struct');
    const [shape] = nodeToExcalidraw(vis);
    expect((shape as Record<string, unknown>).strokeStyle).toBe('solid');
  });

  it('includes customData on shape element', () => {
    const vis = makeVisNode('crate::MyStruct', 'MyStruct', 'Struct');
    const [shape] = nodeToExcalidraw(vis);
    const cd = (shape as Record<string, unknown>).customData as Record<string, unknown>;
    expect(cd).toMatchObject({
      nodeId: 'crate::MyStruct',
      kind: 'Struct',
      visibility: 'Public',
    });
  });

  it('includes customData on text element', () => {
    const vis = makeVisNode('crate::MyStruct', 'MyStruct', 'Struct');
    const [, text] = nodeToExcalidraw(vis);
    const cd = (text as Record<string, unknown>).customData as Record<string, unknown>;
    expect(cd).toMatchObject({
      nodeId: 'crate::MyStruct',
      elementRole: 'label',
    });
  });

  it('sets link when baseUrl option is provided', () => {
    const vis = makeVisNode('crate::MyStruct', 'MyStruct', 'Struct');
    const [shape] = nodeToExcalidraw(vis, [], {
      baseUrl: 'https://codeview.codes',
      crateVersions: { crate: '0.1.0' },
    });
    expect(shape.link).toBe('https://codeview.codes/crate/0.1.0/MyStruct');
  });

  it('sets link to null when no options provided', () => {
    const vis = makeVisNode('crate::MyStruct', 'MyStruct', 'Struct');
    const [shape] = nodeToExcalidraw(vis);
    expect(shape.link).toBeNull();
  });

  it('text element has correct text fields', () => {
    const vis = makeVisNode('crate::Foo', 'Foo', 'Struct');
    const [, text] = nodeToExcalidraw(vis);
    const txt = text as ExcalidrawTextElement;
    expect(txt.originalText).toBe(txt.text);
    expect((txt as Record<string, unknown>).autoResize).toBe(true);
    expect(txt.lineHeight).toBe(1.25);
  });
});

// ---------------------------------------------------------------------------
// edgeToExcalidraw
// ---------------------------------------------------------------------------

describe('edgeToExcalidraw', () => {
  const from = makeVisNode('crate::A', 'A', 'Struct', { x: 200, y: 250, isCenter: true });
  const to = makeVisNode('crate::B', 'B', 'Function', { x: 500, y: 250 });
  const nodeMap = new Map<string, VisNode>([
    ['crate::A', from],
    ['crate::B', to],
  ]);

  it('produces an arrow element', () => {
    const edge = makeVisEdge(from, to, 'UsesType', 'out');
    const el = edgeToExcalidraw(edge, nodeMap) as ExcalidrawArrowElement;

    expect(el.type).toBe('arrow');
    expect(el.endArrowhead).toBe('arrow');
    expect(el.startArrowhead).toBeNull();
    expect(el.points).toHaveLength(2);
  });

  it('uses blue for outgoing edges, gray for incoming', () => {
    const outEdge = makeVisEdge(from, to, 'UsesType', 'out');
    const inEdge = makeVisEdge(to, from, 'UsesType', 'in');

    expect(edgeToExcalidraw(outEdge, nodeMap).strokeColor).toBe('#5b8abf');
    expect(edgeToExcalidraw(inEdge, nodeMap).strokeColor).toBe('#94a3b8');
  });

  it('has start/end bindings referencing source and target node shape IDs', () => {
    const edge = makeVisEdge(from, to, 'UsesType', 'out');
    const el = edgeToExcalidraw(edge, nodeMap) as ExcalidrawArrowElement;

    expect(el.startBinding?.elementId).toBe(nodeShapeId('crate::A'));
    expect(el.endBinding?.elementId).toBe(nodeShapeId('crate::B'));
  });

  it('propagates groupIds', () => {
    const edge = makeVisEdge(from, to, 'UsesType', 'out');
    const gids = ['edge_grp_1'];
    const el = edgeToExcalidraw(edge, nodeMap, gids);
    expect(el.groupIds).toEqual(gids);
  });

  it('includes customData on arrow element', () => {
    const edge = makeVisEdge(from, to, 'UsesType', 'out');
    const el = edgeToExcalidraw(edge, nodeMap);
    const cd = (el as Record<string, unknown>).customData as Record<string, unknown>;
    expect(cd).toMatchObject({
      fromId: 'crate::A',
      toId: 'crate::B',
      edgeKind: 'UsesType',
    });
  });

  it('pre-binds edge label in boundElements', () => {
    const edge = makeVisEdge(from, to, 'UsesType', 'out');
    const el = edgeToExcalidraw(edge, nodeMap);
    const lblId = edgeLabelId('crate::A', 'crate::B', 'UsesType');
    expect(el.boundElements).toContainEqual({ id: lblId, type: 'text' });
  });

  it('uses triangle arrowhead for Implements edge', () => {
    const edge = makeVisEdge(from, to, 'Implements', 'out');
    const el = edgeToExcalidraw(edge, nodeMap) as ExcalidrawArrowElement;
    expect(el.endArrowhead).toBe('triangle');
  });

  it('uses diamond arrowhead for Contains edge', () => {
    const edge = makeVisEdge(from, to, 'Contains', 'out');
    const el = edgeToExcalidraw(edge, nodeMap) as ExcalidrawArrowElement;
    expect(el.endArrowhead).toBe('diamond');
  });

  it('uses dot arrowhead for CallsRuntime edge', () => {
    const edge = makeVisEdge(from, to, 'CallsRuntime', 'out');
    const el = edgeToExcalidraw(edge, nodeMap) as ExcalidrawArrowElement;
    expect(el.endArrowhead).toBe('dot');
  });

  it('uses arrow arrowhead for UsesType edge (default)', () => {
    const edge = makeVisEdge(from, to, 'UsesType', 'out');
    const el = edgeToExcalidraw(edge, nodeMap) as ExcalidrawArrowElement;
    expect(el.endArrowhead).toBe('arrow');
  });
});

// ---------------------------------------------------------------------------
// arrowheadForEdgeKind
// ---------------------------------------------------------------------------

describe('arrowheadForEdgeKind', () => {
  it.each([
    ['Contains', 'diamond'],
    ['Defines', 'diamond_outline'],
    ['Implements', 'triangle'],
    ['Derives', 'triangle_outline'],
    ['UsesType', 'arrow'],
    ['CallsStatic', 'arrow'],
    ['CallsRuntime', 'dot'],
    ['ReExports', 'bar'],
    ['UnknownKind', 'arrow'],
  ] as const)('maps %s to %s', (kind, expected) => {
    expect(arrowheadForEdgeKind(kind)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// labelToExcalidraw
// ---------------------------------------------------------------------------

describe('labelToExcalidraw', () => {
  it('produces a text element at the label position', () => {
    const from = makeVisNode('crate::A', 'A', 'Struct');
    const to = makeVisNode('crate::B', 'B', 'Function');
    const edge = makeVisEdge(from, to, 'Implements', 'out');
    const label: LabelPosition = { x: 350, y: 250, anchor: 'middle' };

    const el = labelToExcalidraw(edge, label) as ExcalidrawTextElement;

    expect(el.type).toBe('text');
    expect(el.text).toBe('Implements');
    expect(el.fontSize).toBe(9);
    expect(el.strokeColor).toBe('#6b7280');
  });

  it('propagates groupIds', () => {
    const from = makeVisNode('crate::A', 'A', 'Struct');
    const to = makeVisNode('crate::B', 'B', 'Function');
    const edge = makeVisEdge(from, to, 'Implements', 'out');
    const label: LabelPosition = { x: 350, y: 250, anchor: 'middle' };
    const gids = ['grp_x'];

    const el = labelToExcalidraw(edge, label, gids);
    expect(el.groupIds).toEqual(gids);
  });

  it('includes customData on edge label', () => {
    const from = makeVisNode('crate::A', 'A', 'Struct');
    const to = makeVisNode('crate::B', 'B', 'Function');
    const edge = makeVisEdge(from, to, 'Implements', 'out');
    const label: LabelPosition = { x: 350, y: 250, anchor: 'middle' };

    const el = labelToExcalidraw(edge, label);
    const cd = (el as Record<string, unknown>).customData as Record<string, unknown>;
    expect(cd).toMatchObject({
      fromId: 'crate::A',
      toId: 'crate::B',
      edgeKind: 'Implements',
      elementRole: 'edgeLabel',
    });
  });

  it('has containerId pointing to the arrow', () => {
    const from = makeVisNode('crate::A', 'A', 'Struct');
    const to = makeVisNode('crate::B', 'B', 'Function');
    const edge = makeVisEdge(from, to, 'Implements', 'out');
    const label: LabelPosition = { x: 350, y: 250, anchor: 'middle' };

    const el = labelToExcalidraw(edge, label) as ExcalidrawTextElement;
    const arrowId = edgeArrowId('crate::A', 'crate::B', 'Implements');
    expect(el.containerId).toBe(arrowId);
  });
});

// ---------------------------------------------------------------------------
// renderExcalidraw (standalone)
// ---------------------------------------------------------------------------

describe('renderExcalidraw', () => {
  it('passes options through to generate links on node shapes', () => {
    const center = makeVisNode('crate::MyStruct', 'MyStruct', 'Struct', { isCenter: true });
    const scene: GraphScene = {
      nodes: [center],
      edges: [],
      labels: [],
      groups: [{ id: 'node:crate::MyStruct', type: 'node', nodeIndex: 0 }],
      mode: 'ego',
    };

    const file = renderExcalidraw(scene, {
      baseUrl: 'https://codeview.codes',
      crateVersions: { crate: '0.1.0' },
    });

    const shape = file.elements.find((e) => e.id === nodeShapeId('crate::MyStruct'))!;
    expect(shape.link).toBe('https://codeview.codes/crate/0.1.0/MyStruct');
  });

  it('does not set links when no options provided', () => {
    const center = makeVisNode('crate::MyStruct', 'MyStruct', 'Struct', { isCenter: true });
    const scene: GraphScene = {
      nodes: [center],
      edges: [],
      labels: [],
      groups: [{ id: 'node:crate::MyStruct', type: 'node', nodeIndex: 0 }],
      mode: 'ego',
    };

    const file = renderExcalidraw(scene);
    const shape = file.elements.find((e) => e.id === nodeShapeId('crate::MyStruct'))!;
    expect(shape.link).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// excalidrawRenderer.render()
// ---------------------------------------------------------------------------

describe('excalidrawRenderer', () => {
  it('has correct id and label', () => {
    expect(excalidrawRenderer.id).toBe('excalidraw');
    expect(excalidrawRenderer.label).toBe('Excalidraw');
  });

  function buildTestScene(): GraphScene {
    const center = makeVisNode('crate::Center', 'Center', 'Struct', { isCenter: true });
    const dep = makeVisNode('crate::Dep', 'Dep', 'Function', { x: 500, y: 250 });
    const edge = makeVisEdge(center, dep, 'UsesType', 'out');
    const label: LabelPosition = { x: 400, y: 250, anchor: 'middle' };

    const groups: SceneGroup[] = [
      { id: 'node:crate::Center', type: 'node', nodeIndex: 0 },
      { id: 'node:crate::Dep', type: 'node', nodeIndex: 1 },
      { id: 'edge:crate::Center:crate::Dep:UsesType', type: 'edge', edgeIndex: 0, labelIndex: 0 },
    ];

    return { nodes: [center, dep], edges: [edge], labels: [label], groups, mode: 'ego' };
  }

  it('produces a valid ExcalidrawFile from a scene', () => {
    const file = excalidrawRenderer.render(buildTestScene());

    expect(file.type).toBe('excalidraw');
    expect(file.version).toBe(2);
    expect(file.appState.viewBackgroundColor).toBe('#ffffff');
    expect(file.files).toEqual({});

    // 2 nodes × 2 elements each (shape + text) + 1 arrow + 1 edge label = 6
    expect(file.elements).toHaveLength(6);

    const types = file.elements.map((e) => e.type);
    expect(types.filter((t) => t === 'rectangle')).toHaveLength(2); // Struct + Function (pill)
    expect(types.filter((t) => t === 'text')).toHaveLength(3);     // 2 node labels + 1 edge label
    expect(types.filter((t) => t === 'arrow')).toHaveLength(1);
  });

  it('assigns groupIds from scene groups', () => {
    const file = excalidrawRenderer.render(buildTestScene());

    // Node elements (shape + text) should share a group
    const centerShapeId = nodeShapeId('crate::Center');
    const centerShape = file.elements.find((e) => e.id === centerShapeId)!;
    const centerText = file.elements.find((e) => e.type === 'text' && (e as ExcalidrawTextElement).containerId === centerShapeId)!;
    expect(centerShape.groupIds).toHaveLength(1);
    expect(centerShape.groupIds).toEqual(centerText.groupIds);

    // Edge arrow + label should share a group
    const arrowId = edgeArrowId('crate::Center', 'crate::Dep', 'UsesType');
    const arrow = file.elements.find((e) => e.id === arrowId)!;
    expect(arrow.groupIds).toHaveLength(1);

    // Edge label shares same group as arrow
    const edgeLabel = file.elements.find(
      (e) => e.type === 'text' && (e as ExcalidrawTextElement).text === 'UsesType'
    )!;
    expect(edgeLabel.groupIds).toEqual(arrow.groupIds);
  });

  it('registers arrows as boundElements on endpoint node shapes', () => {
    const file = excalidrawRenderer.render(buildTestScene());

    const centerShape = file.elements.find((e) => e.id === nodeShapeId('crate::Center'))!;
    const depShape = file.elements.find((e) => e.id === nodeShapeId('crate::Dep'))!;
    const arrowId = edgeArrowId('crate::Center', 'crate::Dep', 'UsesType');

    // Both shapes should list the arrow in their boundElements
    expect(centerShape.boundElements).toContainEqual({ id: arrowId, type: 'arrow' });
    expect(depShape.boundElements).toContainEqual({ id: arrowId, type: 'arrow' });

    // Shape should also have its text binding
    const centerTextId = file.elements.find((e) => e.type === 'text' && (e as ExcalidrawTextElement).containerId === centerShape.id)!.id;
    expect(centerShape.boundElements).toContainEqual({ id: centerTextId, type: 'text' });
  });

  it('produces no elements for an empty scene', () => {
    const center = makeVisNode('crate::Lone', 'Lone', 'Module', { isCenter: true });
    const scene: GraphScene = {
      nodes: [center],
      edges: [],
      labels: [],
      groups: [{ id: 'node:crate::Lone', type: 'node', nodeIndex: 0 }],
      mode: 'ego',
    };

    const file = excalidrawRenderer.render(scene);
    // 1 node = shape + text = 2 elements
    expect(file.elements).toHaveLength(2);
  });

  it('all elements have required fields', () => {
    const file = excalidrawRenderer.render(buildTestScene());

    for (const el of file.elements) {
      expect(el.id).toBeTruthy();
      expect(typeof el.x).toBe('number');
      expect(typeof el.y).toBe('number');
      expect(typeof el.width).toBe('number');
      expect(typeof el.height).toBe('number');
      expect(el.isDeleted).toBe(false);
      expect(el.locked).toBe(false);
      expect(Array.isArray(el.groupIds)).toBe(true);
    }
  });
});
