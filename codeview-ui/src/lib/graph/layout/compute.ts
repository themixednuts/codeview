import type { Graph, Node } from '$lib/graph';
import type { LayoutMode, VisNode, VisEdge } from './types';
import { computeEgoLayout } from './ego';
import { computeForceLayout } from './force';
import { computeHierarchicalLayout } from './hierarchical';
import { computeRadialLayout } from './radial';
import { getPerfLogger } from '$lib/log';

export function computeLayout(graph: Graph, selected: Node, mode: LayoutMode): { nodes: VisNode[]; edges: VisEdge[] } {
  const t0 = performance.now();
  let result: { nodes: VisNode[]; edges: VisEdge[] };
  switch (mode) {
    case 'ego':
      result = computeEgoLayout(graph, selected);
      break;
    case 'force':
      result = computeForceLayout(graph, selected);
      break;
    case 'hierarchical':
      result = computeHierarchicalLayout(graph, selected);
      break;
    case 'radial':
      result = computeRadialLayout(graph, selected);
      break;
    default:
      result = computeEgoLayout(graph, selected);
  }
  const dt = performance.now() - t0;
  getPerfLogger('layout').debug`${mode} ${dt.toFixed(1)}ms (${String(graph.nodes.length)}n ${String(graph.edges.length)}e → ${String(result.nodes.length)}n ${String(result.edges.length)}e)`;
  return result;
}
