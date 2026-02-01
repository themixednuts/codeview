import { describe, it, expect } from 'vitest';
import {
  buildScene,
  buildBaseScene,
  buildNodeMap,
  computeSceneLabels,
  computeEdgeSimilarityGroups,
  filterEdges,
  structuralEdgeKinds,
  semanticEdgeKinds,
} from './graph';
import type { Graph, Node, Edge } from '$lib/graph';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeNode(id: string, name: string, kind: Node['kind'] = 'Function'): Node {
  return {
    id,
    name,
    kind,
    visibility: 'Public',
  } as Node;
}

function makeEdge(from: string, to: string, kind: Edge['kind'] = 'UsesType'): Edge {
  return { from, to, kind, confidence: 'Static' };
}

function makeGraph(nodes: Node[], edges: Edge[]): Graph {
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

describe('edge kind constants', () => {
  it('structuralEdgeKinds contains Contains and Defines', () => {
    expect(structuralEdgeKinds).toContain('Contains');
    expect(structuralEdgeKinds).toContain('Defines');
  });

  it('semanticEdgeKinds contains semantic edge kinds', () => {
    expect(semanticEdgeKinds).toContain('UsesType');
    expect(semanticEdgeKinds).toContain('Implements');
    expect(semanticEdgeKinds).toContain('CallsStatic');
    expect(semanticEdgeKinds).toContain('CallsRuntime');
    expect(semanticEdgeKinds).toContain('Derives');
  });

  it('constants are readonly (no overlap)', () => {
    for (const kind of structuralEdgeKinds) {
      expect(semanticEdgeKinds).not.toContain(kind);
    }
  });
});

// ---------------------------------------------------------------------------
// filterEdges
// ---------------------------------------------------------------------------

describe('filterEdges', () => {
  const edges: Edge[] = [
    makeEdge('a', 'b', 'UsesType'),
    makeEdge('a', 'c', 'Contains'),
    makeEdge('a', 'd', 'Defines'),
    makeEdge('a', 'e', 'Implements'),
  ];

  it('keeps all edges when both flags are true', () => {
    const result = filterEdges(edges, { showStructural: true, showSemantic: true });
    expect(result).toHaveLength(4);
  });

  it('filters out structural edges', () => {
    const result = filterEdges(edges, { showStructural: false, showSemantic: true });
    const kinds = result.map(e => e.kind);
    expect(kinds).not.toContain('Contains');
    expect(kinds).not.toContain('Defines');
    expect(kinds).toContain('UsesType');
    expect(kinds).toContain('Implements');
  });

  it('filters out semantic edges', () => {
    const result = filterEdges(edges, { showStructural: true, showSemantic: false });
    const kinds = result.map(e => e.kind);
    expect(kinds).toContain('Contains');
    expect(kinds).toContain('Defines');
    expect(kinds).not.toContain('UsesType');
    expect(kinds).not.toContain('Implements');
  });

  it('filters out both', () => {
    const result = filterEdges(edges, { showStructural: false, showSemantic: false });
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildNodeMap
// ---------------------------------------------------------------------------

describe('buildNodeMap', () => {
  it('builds a map from node id to VisNode', () => {
    const center = makeNode('a', 'A');
    const graph = makeGraph([center, makeNode('b', 'B')], [makeEdge('a', 'b')]);
    const base = buildBaseScene(graph, center, 'ego', { showStructural: true, showSemantic: true });
    const map = buildNodeMap(base.nodes);
    expect(map.size).toBe(base.nodes.length);
    for (const node of base.nodes) {
      expect(map.get(node.node.id)).toBe(node);
    }
  });
});

// ---------------------------------------------------------------------------
// computeEdgeSimilarityGroups
// ---------------------------------------------------------------------------

describe('computeEdgeSimilarityGroups', () => {
  it('returns empty map for no edges', () => {
    const result = computeEdgeSimilarityGroups([], new Map());
    expect(result.size).toBe(0);
  });

  it('assigns every edge to a group', () => {
    const center = makeNode('a', 'A');
    const graph = makeGraph(
      [center, makeNode('b', 'B'), makeNode('c', 'C')],
      [makeEdge('a', 'b'), makeEdge('a', 'c')]
    );
    const base = buildBaseScene(graph, center, 'ego', { showStructural: true, showSemantic: true });
    const nodeMap = buildNodeMap(base.nodes);
    const groups = computeEdgeSimilarityGroups(base.edges, nodeMap);
    for (let i = 0; i < base.edges.length; i++) {
      expect(groups.has(i)).toBe(true);
      const info = groups.get(i)!;
      expect(info.group).toContain(i);
      expect(typeof info.indexOf).toBe('number');
    }
  });
});

// ---------------------------------------------------------------------------
// buildBaseScene (Stage 1)
// ---------------------------------------------------------------------------

describe('buildBaseScene', () => {
  const center = makeNode('my_crate::Foo', 'Foo', 'Struct');
  const dep = makeNode('my_crate::Bar', 'Bar', 'Function');

  it('returns nodes, edges, groups, similarityGroups, and mode', () => {
    const graph = makeGraph(
      [center, dep],
      [makeEdge('my_crate::Foo', 'my_crate::Bar', 'UsesType')]
    );
    const base = buildBaseScene(graph, center, 'ego', { showStructural: true, showSemantic: true });

    expect(base.mode).toBe('ego');
    expect(base.nodes.length).toBeGreaterThanOrEqual(1);
    expect(base.edges.length).toBeGreaterThanOrEqual(0);
    expect(base.groups.length).toBeGreaterThan(0);
    expect(base.similarityGroups).toBeInstanceOf(Map);
  });

  it('does not include labels', () => {
    const graph = makeGraph(
      [center, dep],
      [makeEdge('my_crate::Foo', 'my_crate::Bar', 'UsesType')]
    );
    const base = buildBaseScene(graph, center, 'ego', { showStructural: true, showSemantic: true });
    expect(base).not.toHaveProperty('labels');
  });

  it('filters edges according to opts', () => {
    const child = makeNode('my_crate::Baz', 'Baz', 'Enum');
    const graph = makeGraph(
      [center, dep, child],
      [
        makeEdge('my_crate::Foo', 'my_crate::Bar', 'UsesType'),
        makeEdge('my_crate::Foo', 'my_crate::Baz', 'Contains'),
      ]
    );
    const base = buildBaseScene(graph, center, 'ego', { showStructural: false, showSemantic: true });
    const edgeKinds = base.edges.map(e => e.kind);
    expect(edgeKinds).not.toContain('Contains');
  });
});

// ---------------------------------------------------------------------------
// computeSceneLabels (Stage 2)
// ---------------------------------------------------------------------------

describe('computeSceneLabels', () => {
  const center = makeNode('my_crate::Foo', 'Foo', 'Struct');
  const dep = makeNode('my_crate::Bar', 'Bar', 'Function');

  it('returns one label per edge', () => {
    const graph = makeGraph(
      [center, dep],
      [makeEdge('my_crate::Foo', 'my_crate::Bar', 'UsesType')]
    );
    const base = buildBaseScene(graph, center, 'ego', { showStructural: true, showSemantic: true });
    const nodeMap = buildNodeMap(base.nodes);
    const labels = computeSceneLabels(base, nodeMap);

    expect(labels).toHaveLength(base.edges.length);
    for (const label of labels) {
      expect(label).toHaveProperty('x');
      expect(label).toHaveProperty('y');
      expect(label).toHaveProperty('anchor');
    }
  });

  it('returns empty array for no edges', () => {
    const graph = makeGraph([center], []);
    const base = buildBaseScene(graph, center, 'ego', { showStructural: true, showSemantic: true });
    const nodeMap = buildNodeMap(base.nodes);
    const labels = computeSceneLabels(base, nodeMap);
    expect(labels).toHaveLength(0);
  });

  it('accepts custom getMetrics', () => {
    const graph = makeGraph(
      [center, dep],
      [makeEdge('my_crate::Foo', 'my_crate::Bar', 'UsesType')]
    );
    const base = buildBaseScene(graph, center, 'ego', { showStructural: true, showSemantic: true });
    const nodeMap = buildNodeMap(base.nodes);
    const labels = computeSceneLabels(base, nodeMap, () => ({ width: 100 }));
    expect(labels).toHaveLength(base.edges.length);
  });

  it('calls SceneHook.adjustLabels when provided', () => {
    const graph = makeGraph(
      [center, dep],
      [makeEdge('my_crate::Foo', 'my_crate::Bar', 'UsesType')]
    );
    const base = buildBaseScene(graph, center, 'ego', { showStructural: true, showSemantic: true });
    const nodeMap = buildNodeMap(base.nodes);
    let hookCalled = false;
    const labels = computeSceneLabels(base, nodeMap, undefined, {
      adjustLabels(positions, ctx) {
        hookCalled = true;
        expect(ctx.baseScene).toBe(base);
        expect(ctx.positionedNodeMap).toBe(nodeMap);
        // Shift all labels by 10px
        for (const pos of positions) {
          pos.x += 10;
        }
      }
    });
    expect(hookCalled).toBe(true);
    expect(labels).toHaveLength(base.edges.length);
  });
});

// ---------------------------------------------------------------------------
// buildScene (composed)
// ---------------------------------------------------------------------------

describe('buildScene', () => {
  const center = makeNode('my_crate::Foo', 'Foo', 'Struct');
  const dep = makeNode('my_crate::Bar', 'Bar', 'Function');
  const child = makeNode('my_crate::Baz', 'Baz', 'Enum');

  it('returns a scene with nodes, edges, labels, groups, and mode', () => {
    const graph = makeGraph(
      [center, dep],
      [makeEdge('my_crate::Foo', 'my_crate::Bar', 'UsesType')]
    );

    const scene = buildScene(graph, center, 'ego', {
      showStructural: true,
      showSemantic: true,
    });

    expect(scene.mode).toBe('ego');
    expect(scene.nodes.length).toBeGreaterThanOrEqual(1);
    expect(scene.edges).toHaveLength(scene.labels.length);
    expect(scene.groups.length).toBeGreaterThan(0);
  });

  it('filters out structural edges when showStructural is false', () => {
    const graph = makeGraph(
      [center, dep, child],
      [
        makeEdge('my_crate::Foo', 'my_crate::Bar', 'UsesType'),
        makeEdge('my_crate::Foo', 'my_crate::Baz', 'Contains'),
      ]
    );

    const scene = buildScene(graph, center, 'ego', {
      showStructural: false,
      showSemantic: true,
    });

    const edgeKinds = scene.edges.map((e) => e.kind);
    expect(edgeKinds).not.toContain('Contains');
  });

  it('filters out semantic edges when showSemantic is false', () => {
    const graph = makeGraph(
      [center, dep, child],
      [
        makeEdge('my_crate::Foo', 'my_crate::Bar', 'UsesType'),
        makeEdge('my_crate::Foo', 'my_crate::Baz', 'Contains'),
      ]
    );

    const scene = buildScene(graph, center, 'ego', {
      showStructural: true,
      showSemantic: false,
    });

    const edgeKinds = scene.edges.map((e) => e.kind);
    expect(edgeKinds).not.toContain('UsesType');
  });

  it('produces a label for each edge', () => {
    const graph = makeGraph(
      [center, dep],
      [makeEdge('my_crate::Foo', 'my_crate::Bar', 'UsesType')]
    );

    const scene = buildScene(graph, center, 'ego', {
      showStructural: true,
      showSemantic: true,
    });

    expect(scene.labels).toHaveLength(scene.edges.length);
    for (const label of scene.labels) {
      expect(label).toHaveProperty('x');
      expect(label).toHaveProperty('y');
      expect(label).toHaveProperty('anchor');
    }
  });

  it('works with an empty graph (center only, no edges)', () => {
    const graph = makeGraph([center], []);
    const scene = buildScene(graph, center, 'ego', {
      showStructural: true,
      showSemantic: true,
    });

    expect(scene.nodes).toHaveLength(1);
    expect(scene.edges).toHaveLength(0);
    expect(scene.labels).toHaveLength(0);
  });

  it('works with different layout modes', () => {
    const graph = makeGraph(
      [center, dep],
      [makeEdge('my_crate::Foo', 'my_crate::Bar', 'UsesType')]
    );

    for (const mode of ['ego', 'force', 'hierarchical', 'radial'] as const) {
      const scene = buildScene(graph, center, mode, {
        showStructural: true,
        showSemantic: true,
      });
      expect(scene.mode).toBe(mode);
      expect(scene.nodes.length).toBeGreaterThanOrEqual(1);
    }
  });

  describe('groups', () => {
    it('creates one node group per node', () => {
      const graph = makeGraph(
        [center, dep],
        [makeEdge('my_crate::Foo', 'my_crate::Bar', 'UsesType')]
      );

      const scene = buildScene(graph, center, 'ego', {
        showStructural: true,
        showSemantic: true,
      });

      const nodeGroups = scene.groups.filter((g) => g.type === 'node');
      expect(nodeGroups).toHaveLength(scene.nodes.length);
      for (const g of nodeGroups) {
        if (g.type !== 'node') continue;
        expect(typeof g.nodeIndex).toBe('number');
        expect(g.id).toMatch(/^node:/);
      }
    });

    it('creates one edge group per edge with matching label index', () => {
      const graph = makeGraph(
        [center, dep],
        [makeEdge('my_crate::Foo', 'my_crate::Bar', 'UsesType')]
      );

      const scene = buildScene(graph, center, 'ego', {
        showStructural: true,
        showSemantic: true,
      });

      const edgeGroups = scene.groups.filter((g) => g.type === 'edge');
      expect(edgeGroups).toHaveLength(scene.edges.length);
      for (const g of edgeGroups) {
        if (g.type !== 'edge') continue;
        expect(typeof g.edgeIndex).toBe('number');
        expect(g.labelIndex).toBeDefined();
        expect(g.id).toMatch(/^edge:/);
      }
    });

    it('produces no edge groups when there are no edges', () => {
      const graph = makeGraph([center], []);
      const scene = buildScene(graph, center, 'ego', {
        showStructural: true,
        showSemantic: true,
      });

      const edgeGroups = scene.groups.filter((g) => g.type === 'edge');
      expect(edgeGroups).toHaveLength(0);
    });

    it('group IDs are stable for the same input', () => {
      const graph = makeGraph(
        [center, dep],
        [makeEdge('my_crate::Foo', 'my_crate::Bar', 'UsesType')]
      );

      const a = buildScene(graph, center, 'ego', { showStructural: true, showSemantic: true });
      const b = buildScene(graph, center, 'ego', { showStructural: true, showSemantic: true });

      expect(a.groups.map((g) => g.id)).toEqual(b.groups.map((g) => g.id));
    });
  });
});
