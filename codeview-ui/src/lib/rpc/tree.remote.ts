import { query } from "$app/server";
import { isHosted } from "$lib/platform";
import { getLogger } from "$lib/log";
import { perf } from "$lib/perf";
import { CrateRefSchema, type CrateTree } from "$lib/schema";
import {
  canonicalizeTree,
  getProvider,
  loadWorkspace,
  loadCrateGraphByRef,
  summarizeNode,
} from "./helpers";

const log = getLogger("rpc.tree");

/** Get crate tree structure (nodes + Contains/Defines edges for one crate) */
export const getCrateTree = query(
  CrateRefSchema,
  async ({
    name,
    version,
    mode,
    includeExternal,
  }): Promise<CrateTree | null> => {
    return perf.timeAsync(
      "server",
      `getCrateTree(${name})`,
      async () => {
        log.info`getCrateTree start name=${name} version=${version ?? "latest"}`;
        // Workspace crates are already in memory
        const provider = await getProvider();
        const ws = await loadWorkspace(provider);
        const wsCrate = ws?.crates.find((c) => c.id === name) ?? null;
        if (wsCrate) {
          const internalNodes = wsCrate.nodes.filter((n) => !n.is_external);
          const internalIds = new Set(internalNodes.map((n) => n.id));
          const treeEdges = wsCrate.edges.filter(
            (e) =>
              (e.kind === "Contains" || e.kind === "Defines") &&
              internalIds.has(e.from) &&
              internalIds.has(e.to),
          );
          const tree = canonicalizeTree(
            name,
            { nodes: internalNodes.map(summarizeNode), edges: treeEdges },
            {
              mode,
              includeExternal,
            },
          );
          log.info`getCrateTree source=workspace name=${name} version=${version ?? "latest"} nodes=${tree.nodes.length} edges=${tree.edges.length}`;
          return tree;
        }

        // Try pre-computed tree first (avoids loading full graph for sidebar)
        const tree = await provider.loadCrateTree(name, version ?? "latest");
        if (tree) {
          const normalized = canonicalizeTree(name, tree, {
            mode,
            includeExternal,
          });
          log.info`getCrateTree source=providerTree name=${name} version=${version ?? "latest"} nodes=${normalized.nodes.length} edges=${normalized.edges.length}`;
          return normalized;
        }

        // Fallback: load full graph and compute tree
        if (isHosted) {
          log.info`getCrateTree source=hosted-null name=${name} version=${version ?? "latest"}`;
          return null;
        }
        const graph = await loadCrateGraphByRef(name, version, provider);
        if (!graph) {
          log.info`getCrateTree source=fallbackGraph-none name=${name} version=${version ?? "latest"}`;
          return null;
        }

        const internalNodes = graph.nodes.filter((n) => !n.is_external);
        const internalIds = new Set(internalNodes.map((n) => n.id));
        const treeEdges = graph.edges.filter(
          (e) =>
            (e.kind === "Contains" || e.kind === "Defines") &&
            internalIds.has(e.from) &&
            internalIds.has(e.to),
        );
        const derivedTree = canonicalizeTree(
          name,
          { nodes: internalNodes.map(summarizeNode), edges: treeEdges },
          {
            mode,
            includeExternal,
          },
        );
        log.info`getCrateTree source=fallbackGraph name=${name} version=${version ?? "latest"} graphNodes=${graph.nodes.length} graphEdges=${graph.edges.length} treeNodes=${derivedTree.nodes.length} treeEdges=${derivedTree.edges.length}`;
        return derivedTree;
      },
      {
        detail: (r) => (r ? `${r.nodes.length}n ${r.edges.length}e` : "null"),
      },
    );
  },
);
