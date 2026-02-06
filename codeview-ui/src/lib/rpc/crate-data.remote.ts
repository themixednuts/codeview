import { query } from "$app/server";
import { isHosted } from "$lib/platform";
import { getLogger } from "$lib/log";
import { perf } from "$lib/perf";
import { CrateRefSchema, type CrateData, type CrateTree } from "$lib/schema";
import {
  canonicalizeTree,
  getProvider,
  loadWorkspace,
  loadCrateGraphByRef,
  summarizeNode,
} from "./helpers";

const log = getLogger("rpc.crate-data");

/**
 * Combined query: tree + index + versions in a single roundtrip.
 * Replaces three separate calls (getCrateTree, getCrateIndex, getCrateVersions).
 */
export const getCrateData = query(
  CrateRefSchema,
  async ({
    name,
    version,
    mode,
    includeExternal,
  }): Promise<CrateData | null> => {
    return perf.timeAsync(
      "server",
      `getCrateData(${name})`,
      async () => {
        log.info`getCrateData start name=${name} version=${version ?? "latest"}`;
        const provider = await getProvider();
        const ws = await loadWorkspace(provider);
        const resolvedVersion = version ?? "latest";

        // Workspace path: tree from memory, index + versions from provider
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
            { mode, includeExternal },
          );

          const [index, versions] = await Promise.all([
            provider.loadCrateIndex(name, resolvedVersion),
            provider.getCrateVersions(name, 20),
          ]);

          log.info`getCrateData source=workspace name=${name} nodes=${tree.nodes.length} edges=${tree.edges.length} versions=${versions.length}`;
          return { tree, index, versions };
        }

        // Hosted/remote path: all three in parallel
        const [providerTree, index, versions] = await Promise.all([
          provider.loadCrateTree(name, resolvedVersion),
          provider.loadCrateIndex(name, resolvedVersion),
          provider.getCrateVersions(name, 20),
        ]);

        let tree: CrateTree | null = null;
        if (providerTree) {
          tree = canonicalizeTree(name, providerTree, {
            mode,
            includeExternal,
          });
          log.info`getCrateData source=providerTree name=${name} nodes=${tree.nodes.length} edges=${tree.edges.length} versions=${versions.length}`;
        }

        // Fallback: load full graph (local mode only)
        if (!tree && !isHosted) {
          const graph = await loadCrateGraphByRef(name, version, provider);
          if (graph) {
            const internalNodes = graph.nodes.filter((n) => !n.is_external);
            const internalIds = new Set(internalNodes.map((n) => n.id));
            const treeEdges = graph.edges.filter(
              (e) =>
                (e.kind === "Contains" || e.kind === "Defines") &&
                internalIds.has(e.from) &&
                internalIds.has(e.to),
            );
            tree = canonicalizeTree(
              name,
              { nodes: internalNodes.map(summarizeNode), edges: treeEdges },
              { mode, includeExternal },
            );
            log.info`getCrateData source=fallbackGraph name=${name} nodes=${tree.nodes.length} edges=${tree.edges.length} versions=${versions.length}`;
          }
        }

        if (!tree) {
          log.info`getCrateData source=null name=${name}`;
          return null;
        }

        return { tree, index, versions };
      },
      {
        detail: (r) =>
          r ? `${r.tree.nodes.length}n ${r.tree.edges.length}e ${r.versions.length}v` : "null",
      },
    );
  },
);
