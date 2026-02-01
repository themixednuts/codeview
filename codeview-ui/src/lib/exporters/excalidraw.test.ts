import { describe, it, expect } from 'vitest';
import {
  nodeToExcalidraw,
  edgeToExcalidraw,
  labelToExcalidraw,
  excalidrawRenderer,
  nodeShapeId,
  edgeArrowId,
} from './excalidraw';
import type { VisNode, VisEdge } from '$lib/graph-layout';
import type { Node } from '$lib/graph';
import type { GraphScene, SceneGroup } from '$lib/renderers/graph';
import type { LabelPosition } from '$lib/graph-label-layout';

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
    expect(text.text).toBe('MyStruct');
    expect(text.containerId).toBe(shape.id);
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
    expect(text.containerId).toBe(shape.id);
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
    const el = edgeToExcalidraw(edge, nodeMap);

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
    const el = edgeToExcalidraw(edge, nodeMap);

    expect(el.startBinding?.elementId).toBe(nodeShapeId('crate::A'));
    expect(el.endBinding?.elementId).toBe(nodeShapeId('crate::B'));
  });

  it('propagates groupIds', () => {
    const edge = makeVisEdge(from, to, 'UsesType', 'out');
    const gids = ['edge_grp_1'];
    const el = edgeToExcalidraw(edge, nodeMap, gids);
    expect(el.groupIds).toEqual(gids);
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

    const el = labelToExcalidraw(edge, label);

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
    const centerText = file.elements.find((e) => e.containerId === centerShapeId)!;
    expect(centerShape.groupIds).toHaveLength(1);
    expect(centerShape.groupIds).toEqual(centerText.groupIds);

    // Edge arrow + label should share a group
    const arrowId = edgeArrowId('crate::Center', 'crate::Dep', 'UsesType');
    const arrow = file.elements.find((e) => e.id === arrowId)!;
    expect(arrow.groupIds).toHaveLength(1);

    // Edge label shares same group as arrow
    const edgeLabel = file.elements.find(
      (e) => e.type === 'text' && e.text === 'UsesType'
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
    const centerTextId = file.elements.find((e) => e.containerId === centerShape.id)!.id;
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
