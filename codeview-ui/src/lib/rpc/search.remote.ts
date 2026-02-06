import { query } from "$app/server";
import {
  NodeIdsSchema,
  SearchNodesInputSchema,
  type NodeSummary,
  type SearchNodesInput,
} from "$lib/schema";
import {
  getProvider,
  loadWorkspace,
  loadCrateGraphByRef,
  getAllNodes,
  summarizeNode,
} from "./helpers";

/** Search nodes by name/id, optionally scoped to a crate */
export const searchNodes = query(
  SearchNodesInputSchema,
  async ({
    crate: crateId,
    version,
    q,
  }: SearchNodesInput): Promise<NodeSummary[]> => {
    const provider = await getProvider();
    const ws = await loadWorkspace(provider);
    const lower = q.toLowerCase();

    if (ws) {
      // If scoped to a specific crate that isn't in the workspace, fall through
      const isWorkspaceCrate =
        !crateId || ws.crates.some((c) => c.id === crateId);
      if (isWorkspaceCrate) {
        const results: NodeSummary[] = [];
        for (const c of ws.crates) {
          if (crateId && c.id !== crateId) continue;
          for (const n of c.nodes) {
            if (
              !n.is_external &&
              (n.name.toLowerCase().includes(lower) ||
                n.id.toLowerCase().includes(lower))
            ) {
              results.push(summarizeNode(n));
            }
          }
        }
        return results;
      }
      // Not a workspace crate — fall through to universal path
    }

    if (!crateId) return [];
    const graph = await loadCrateGraphByRef(crateId, version, provider);
    if (!graph) return [];
    return graph.nodes
      .filter(
        (n) =>
          !n.is_external &&
          (n.name.toLowerCase().includes(lower) ||
            n.id.toLowerCase().includes(lower)),
      )
      .map(summarizeNode);
  },
);

/** Check whether node IDs exist in the workspace (for link validation) */
export const checkNodeExists = query(
  NodeIdsSchema,
  async (nodeIds: string[]): Promise<Record<string, boolean>> => {
    const ws = await loadWorkspace();
    if (!ws) return {};
    const allNodes = getAllNodes(ws);
    const result: Record<string, boolean> = {};
    for (const id of nodeIds) {
      result[id] = allNodes.has(id);
    }
    return result;
  },
);
