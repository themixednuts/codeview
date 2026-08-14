import { prerender, query } from "$app/server";
import { getLogger } from "#lib/log.js";
import { perf } from "#lib/perf.js";
import type { TreeNodeDTO } from "#lib/schema.js";
import { resolve } from "./helpers";
import { assertCrateRef } from "./remote-utils";
import { CrateRefSchema } from "./schemas";

const log = getLogger("rpc.roots");

/**
 * Root tree nodes for the sidebar. Returns TreeNodeDTO[] with hasChildren flags.
 */
async function loadTreeRoots({ name, version }: { name: string; version?: string }) {
  assertCrateRef(name, version ?? "latest");
  return perf.timeAsync(
    "server",
    `getTreeRoots(${name})`,
    async () => {
      const resolvedVersion = version ?? "latest";
      const roots = await resolve.treeRoots(name, resolvedVersion);
      log.info`getTreeRoots done name=${name} roots=${roots.length}`;
      return roots satisfies TreeNodeDTO[];
    },
    { detail: (r) => `${r.length} roots` },
  );
}

export const getTreeRoots = query(CrateRefSchema, loadTreeRoots);

export const getStaticTreeRoots = prerender(CrateRefSchema, loadTreeRoots, {
  dynamic: true,
});
