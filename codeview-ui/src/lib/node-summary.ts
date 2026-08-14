import type { CrateGraph, CrateTree, Edge, Node, NodeSummary } from "#lib/schema.js";

export function summarizeNode(node: Node): NodeSummary {
  const summary: NodeSummary = {
    id: node.id,
    name: node.name,
    kind: node.kind,
    visibility: node.visibility,
    is_external: node.is_external,
    is_deprecated: node.is_deprecated,
  };
  if (node.kind === "Impl") {
    summary.impl_trait = node.impl_trait;
    summary.impl_category = node.impl_category;
    summary.generics = node.generics;
  }
  return summary;
}

export function buildCrateTree(graph: Pick<CrateGraph, "nodes" | "edges">): CrateTree {
  const internalNodes = graph.nodes.filter((node) => !node.is_external);
  const internalIds = new Set(internalNodes.map((node) => node.id));
  const structuralEdges = graph.edges.filter(
    (edge): edge is Edge =>
      (edge.kind === "Contains" || edge.kind === "Defines") &&
      internalIds.has(edge.from) &&
      internalIds.has(edge.to),
  );
  return {
    nodes: internalNodes.map(summarizeNode),
    edges: structuralEdges,
  };
}
