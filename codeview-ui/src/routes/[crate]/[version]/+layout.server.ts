import { error, redirect } from "@sveltejs/kit";
import type { LayoutServerLoad } from "./$types";
import { initProvider } from "#lib/server/provider.js";
import { hyphenateCrateName, normalizeCrateName } from "#lib/crate-names.js";
import { resolve } from "#lib/rpc/helpers.js";
import { isHosted } from "#lib/platform.js";
import { parseExplorerState } from "#lib/url-state.js";
import { isStdCrate } from "#lib/std.js";

/** Version aliases that should be resolved to a concrete semver and redirected. */
const VERSION_ALIASES = new Set(["latest", "stable", "beta", "nightly"]);
const INVALID_VERSION_SENTINELS = new Set(["undefined"]);
const MAX_PREFETCH_TREE_CHILDREN = 12;

function readExpandedIds(url: URL): string[] {
  return parseExplorerState(url).ex.slice(0, MAX_PREFETCH_TREE_CHILDREN);
}

export const load: LayoutServerLoad = async (event) => {
  const { crate, version } = event.params;
  if (!crate || !version) return;

  // Allow client-side invalidation when crate status changes (e.g. parsing completes).
  event.depends("app:crateData");

  const provider = initProvider(event);
  const name = hyphenateCrateName(crate);

  // `rand_core` and `rand-core` are the same crate; keep one URL per page.
  // Toolchain crates (`proc_macro`) keep their underscore names.
  if (crate !== name && !isStdCrate(normalizeCrateName(crate))) {
    const pathname = `/${name}${event.url.pathname.slice(crate.length + 1)}`;
    throw redirect(308, `${pathname}${event.url.search}`);
  }

  if (INVALID_VERSION_SENTINELS.has(version)) {
    const resolved = await provider.resolveVersion(name, "latest");
    const prefix = `/${crate}/${version}`;
    const rest = event.url.pathname.startsWith(prefix)
      ? event.url.pathname.slice(prefix.length)
      : "";
    throw redirect(302, `/${crate}/${resolved}${rest}${event.url.search}`);
  }

  // Resolve version aliases (latest → concrete semver) and redirect
  if (VERSION_ALIASES.has(version)) {
    const resolved = await provider.resolveVersion(name, version);
    // `latest` only stays unresolved when neither crates.io nor our refs
    // know any version of this crate.
    if (resolved === version && version === "latest" && !isStdCrate(normalizeCrateName(name))) {
      error(404, "Crate not found");
    }
    if (resolved !== version) {
      const prefix = `/${crate}/${version}`;
      const rest = event.url.pathname.startsWith(prefix)
        ? event.url.pathname.slice(prefix.length)
        : "";
      throw redirect(302, `/${crate}/${resolved}${rest}${event.url.search}`);
    }
  }

  if (!isHosted && isStdCrate(normalizeCrateName(name))) {
    void provider.ensureParsed?.(name, version).catch((err) => {
      console.error(`ensureParsed failed for ${name}@${version}:`, err);
    });
  }

  // Derive nodeId from URL path (same logic as nodeIdFromPath in url.ts)
  const prefix = `/${crate}/${version}`;
  const rest = event.url.pathname.startsWith(prefix)
    ? event.url.pathname.slice(prefix.length).replace(/^\//, "")
    : "";
  const normalizedCrate = normalizeCrateName(crate);
  const nodeId = rest ? `${normalizedCrate}::${rest.replace(/\//g, "::")}` : normalizedCrate;

  const status = await provider.getCrateStatus(name, version);
  if (status.status !== "ready") {
    const neverParsed = status.status === "unknown" || status.action === "docs_unavailable";
    if (neverParsed && !VERSION_ALIASES.has(version)) {
      const versions = await provider.getCrateVersions(name).catch((): string[] => []);
      // An empty list means the registry lookup failed; don't 404 on that.
      if (versions.length > 0 && !versions.includes(version)) {
        error(404, `${name} ${version} is not a published version`);
      }
    }
    return {
      status,
      meta: null,
      roots: null,
      rootChildren: null,
      crateMap: null,
      nodeView: null,
      prefetchedTreeChildren: [],
      nodeId,
    };
  }

  // Resolve re-exported items: URL "syn/2.0.0/Item" → nodeId "syn::Item",
  // but the canonical path is "syn::item::Item". Redirect to the canonical URL
  // so the browser always shows the correct path.
  if (rest && !isHosted) {
    const canonical = await resolve.resolveCanonicalNodeId(name, version, nodeId);
    if (canonical && canonical !== nodeId) {
      const canonicalPath = canonical
        .replace(new RegExp(`^${normalizedCrate}::`), "")
        .replace(/::/g, "/");
      throw redirect(302, `/${crate}/${version}/${canonicalPath}${event.url.search}`);
    }
  }

  // Node detail is primary route content, not a secondary enhancement.
  // Await it in load so SSR and client navigations render the same stable
  // layout instead of committing a pending shell and shifting when data arrives.
  const [nodeView, crateMap, meta, roots] = await Promise.all([
    resolve.nodeView({ name, version, nodeId }, provider).catch(() => null),
    rest === ""
      ? provider
          .loadCrateMap(name, version, { maxHierarchyModules: 180, maxMatrixModules: 24 })
          .catch(() => null)
      : Promise.resolve(null),
    resolve.crateMeta(name, version, provider).catch(() => null),
    resolve.treeRoots(name, version, provider).catch(() => null),
  ]);

  if (rest && nodeView === null && meta !== null) {
    error(404, "Item not found");
  }

  const rootId = roots?.[0]?.node.id;
  const rootChildrenPromise = rootId
    ? resolve.treeChildren(name, version, rootId, provider).catch(() => [])
    : Promise.resolve(null);

  const prefetchIds = new Set<string>();
  if (nodeView?.ancestors) {
    for (const ancestor of nodeView.ancestors) prefetchIds.add(ancestor.id);
  }
  for (const id of readExpandedIds(event.url)) prefetchIds.add(id);

  const [rootChildrenData, prefetchedTreeChildren] = await Promise.all([
    rootChildrenPromise,
    Promise.all(
      Array.from(prefetchIds)
        .filter((id) => id !== rootId)
        .slice(0, MAX_PREFETCH_TREE_CHILDREN)
        .map(async (id) => ({
          id,
          children: await resolve.treeChildren(name, version, id, provider).catch(() => []),
        })),
    ),
  ]);

  const rootChildren = rootId
    ? {
        id: rootId,
        children: rootChildrenData ?? [],
      }
    : null;

  return {
    status,
    meta,
    roots,
    rootChildren,
    prefetchedTreeChildren,
    crateMap,
    nodeView,
    nodeId,
  };
};
