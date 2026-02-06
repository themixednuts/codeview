import { getRequestEvent } from "$app/server";
import { initProvider } from "$lib/server/provider";
import { perf } from "$lib/perf";
import { isHosted } from "$lib/platform";
import { normalizeCrateName, hyphenateCrateName } from "$lib/crate-names";
import type { Node, Workspace } from "$lib/graph";
import type { NodeSummary, CrateTree, NodeDetail } from "$lib/schema";

export type Provider = Awaited<ReturnType<typeof initProvider>>;
export type NodeDetailInput = {
  nodeId: string;
  version?: string;
  refresh?: number;
};

export type TreeMode = "structural" | "complete";

export function canonicalizeTree(
  name: string,
  tree: CrateTree,
  options?: { mode?: TreeMode; includeExternal?: boolean },
): CrateTree {
  const mode = options?.mode ?? "structural";
  const includeExternal = options?.includeExternal ?? false;
  const normalizedName = normalizeCrateName(name);
  const structuralOnly = mode === "structural";
  const allowedNodeIds = new Set<string>();
  const nodeById = new Map(tree.nodes.map((n) => [n.id, n]));
  const outEdges = [];

  for (const edge of tree.edges) {
    if (structuralOnly && edge.kind !== "Contains" && edge.kind !== "Defines")
      continue;
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (!from || !to) continue;
    if (!includeExternal && (from.is_external || to.is_external)) continue;
    allowedNodeIds.add(edge.from);
    allowedNodeIds.add(edge.to);
    outEdges.push(edge);
  }

  if (structuralOnly) {
    if (nodeById.has(name)) allowedNodeIds.add(name);
    if (nodeById.has(normalizedName)) allowedNodeIds.add(normalizedName);
  }

  const outNodes = [];
  for (const node of tree.nodes) {
    if (!includeExternal && node.is_external) continue;
    if (structuralOnly && !allowedNodeIds.has(node.id)) continue;
    outNodes.push(node);
  }

  return { nodes: outNodes, edges: outEdges };
}

export async function getProvider(provider?: Provider): Promise<Provider> {
  return provider ?? initProvider(getRequestEvent());
}

export async function loadWorkspace(provider?: Provider): Promise<Workspace | null> {
  const resolved = await getProvider(provider);
  return resolved.loadWorkspace();
}

export async function loadCrateGraphByRef(
  name: string,
  version?: string,
  provider?: Provider,
): Promise<import("$lib/graph").CrateGraph | null> {
  const resolved = await getProvider(provider);
  return resolved.loadCrateGraph(name, version ?? "latest");
}

// Cached lookup structures (built once from the cached workspace)
let _allNodesCache: Map<string, Node> | null = null;
let _edgesBySrcCache: Map<string, Workspace["cross_crate_edges"]> | null = null;
let _edgesByDstCache: Map<string, Workspace["cross_crate_edges"]> | null = null;
let _cachedWorkspaceRef: Workspace | null = null;

export function getAllNodes(ws: Workspace): Map<string, Node> {
  if (_allNodesCache && _cachedWorkspaceRef === ws) return _allNodesCache;
  const map = new Map<string, Node>();
  for (const c of ws.crates) {
    for (const n of c.nodes) map.set(n.id, n);
  }
  for (const ext of ws.external_crates) {
    for (const n of ext.nodes) map.set(n.id, n);
  }
  _allNodesCache = map;
  _cachedWorkspaceRef = ws;
  return map;
}

export function getCrossEdgesByNode(ws: Workspace): {
  bySrc: Map<string, typeof ws.cross_crate_edges>;
  byDst: Map<string, typeof ws.cross_crate_edges>;
} {
  if (_edgesBySrcCache && _edgesByDstCache && _cachedWorkspaceRef === ws) {
    return { bySrc: _edgesBySrcCache, byDst: _edgesByDstCache };
  }
  const bySrc = new Map<string, typeof ws.cross_crate_edges>();
  const byDst = new Map<string, typeof ws.cross_crate_edges>();
  for (const e of ws.cross_crate_edges) {
    if (!bySrc.has(e.from)) bySrc.set(e.from, []);
    bySrc.get(e.from)!.push(e);
    if (!byDst.has(e.to)) byDst.set(e.to, []);
    byDst.get(e.to)!.push(e);
  }
  _edgesBySrcCache = bySrc;
  _edgesByDstCache = byDst;
  return { bySrc, byDst };
}

export function summarizeNode(n: Node): NodeSummary {
  return {
    id: n.id,
    name: n.name,
    kind: n.kind,
    visibility: n.visibility,
    is_external: n.is_external,
    ...(n.kind === "Impl"
      ? {
          impl_trait: n.impl_trait,
          generics: n.generics,
          where_clause: n.where_clause,
          bound_links: n.bound_links,
        }
      : {}),
  };
}

export async function resolveNodeDetail(
  input: NodeDetailInput,
  provider: Provider,
  workspace: Workspace | null,
): Promise<NodeDetail | null> {
  const { nodeId, version } = input;
  return perf.timeAsync(
    "server",
    `getNodeDetail(${nodeId})`,
    async () => {
      const cratePrefix = nodeId.split("::")[0];
      // Provider lookups (DO/R2) are keyed by hyphenated name (URL convention),
      // but node IDs use underscores (Rust convention).
      const crateNameForProvider = hyphenateCrateName(cratePrefix);

      if (workspace) {
        const crate = workspace.crates.find((c) => c.id === cratePrefix);
        if (crate) {
          const allNodes = getAllNodes(workspace);
          const node = allNodes.get(nodeId);
          if (!node) return null;

          // Collect edges: from the crate's internal edges + cross-crate indexed edges
          const { bySrc, byDst } = getCrossEdgesByNode(workspace);
          const edges = [
            ...crate.edges.filter((e) => e.from === nodeId || e.to === nodeId),
            ...(bySrc.get(nodeId) ?? []),
            ...(byDst.get(nodeId) ?? []),
          ];

          // Related nodes referenced by those edges
          const relatedIds = new Set<string>();
          for (const e of edges) {
            relatedIds.add(e.from);
            relatedIds.add(e.to);
          }
          relatedIds.delete(nodeId);

          const relatedNodes: NodeSummary[] = [];
          for (const id of relatedIds) {
            const n = allNodes.get(id);
            if (n) relatedNodes.push(summarizeNode(n));
          }

          return { node, edges, relatedNodes };
        }
        // Not a workspace crate — fall through to universal path
      }

      // Universal path: prefer provider-level node detail to avoid loading full graphs.
      if (provider.loadNodeDetail) {
        const detail = await provider.loadNodeDetail(
          crateNameForProvider,
          version ?? "latest",
          nodeId,
        );
        if (detail) return detail;
      }

      // Fallback: load crate graph by ref (skip in hosted to avoid RPC limits)
      if (isHosted) return null;
      const graph = await provider.loadCrateGraph(
        crateNameForProvider,
        version ?? "latest",
      );
      if (!graph) return null;

      const nodesById = new Map<string, Node>();
      for (const n of graph.nodes) nodesById.set(n.id, n);
      const node = nodesById.get(nodeId);
      if (!node) return null;

      const edges = graph.edges.filter(
        (e) => e.from === nodeId || e.to === nodeId,
      );
      const crossData = await provider.getCrossEdgeData(nodeId);
      const edgeKey = (e: {
        from: string;
        to: string;
        kind: string;
        confidence: string;
      }) => `${e.from}|${e.to}|${e.kind}|${e.confidence}`;
      const edgeKeys = new Set(edges.map((e) => edgeKey(e)));
      for (const e of crossData.edges) {
        if (!edgeKeys.has(edgeKey(e))) {
          edges.push(e);
          edgeKeys.add(edgeKey(e));
        }
      }
      const relatedIds = new Set<string>();
      for (const e of edges) {
        relatedIds.add(e.from);
        relatedIds.add(e.to);
      }
      relatedIds.delete(nodeId);

      const relatedNodesMap = new Map<string, NodeSummary>();
      for (const id of relatedIds) {
        const n = nodesById.get(id);
        if (n) relatedNodesMap.set(id, summarizeNode(n));
      }
      for (const n of crossData.nodes) {
        if (!relatedNodesMap.has(n.id)) relatedNodesMap.set(n.id, n);
      }
      const relatedNodes = Array.from(relatedNodesMap.values());

      return { node, edges, relatedNodes };
    },
    {
      detail: (r) =>
        r ? `${r.edges.length}e ${r.relatedNodes.length}r` : "null",
    },
  );
}
