import type { Graph, Node } from "#lib/graph.js";
import type { LayoutMode, VisLayout } from "./types";
import { computeEgoLayout } from "./ego";
import { computeForceLayout } from "./force";
import { computeHierarchicalLayout } from "./hierarchical";
import { computeRadialLayout } from "./radial";
import { getPerfLogger } from "#lib/log.js";

export function computeLayout(graph: Graph, selected: Node, mode: LayoutMode): VisLayout {
  const t0 = performance.now();
  let result: VisLayout;
  switch (mode) {
    case "ego":
      result = computeEgoLayout(graph, selected);
      break;
    case "force":
      result = computeForceLayout(graph, selected);
      break;
    case "hierarchical":
      result = computeHierarchicalLayout(graph, selected);
      break;
    case "radial":
      result = computeRadialLayout(graph, selected);
      break;
    default:
      result = computeEgoLayout(graph, selected);
  }
  const dt = performance.now() - t0;
  getPerfLogger("layout")
    .debug`${mode} ${dt.toFixed(1)}ms (${String(graph.nodes.length)}n ${String(graph.edges.length)}e → ${String(result.nodes.length)}n ${String(result.edges.length)}e)`;
  return result;
}
