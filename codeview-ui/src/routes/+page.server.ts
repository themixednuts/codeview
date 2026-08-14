import type { PageServerLoad } from "./$types";
import { hasLocalWorkspace, initProvider } from "#lib/server/provider.js";
import { isHosted } from "#lib/platform.js";

const TOP_CRATES_TTL_MS = 5 * 60 * 1000;

type TopCrate = {
  id?: string;
  name: string;
  version: string;
  description?: string;
};

let topCratesCache: { fetchedAt: number; data: TopCrate[] } | null = null;

async function getTopCratesCached(provider: ReturnType<typeof initProvider>): Promise<TopCrate[]> {
  const now = Date.now();
  if (topCratesCache && now - topCratesCache.fetchedAt < TOP_CRATES_TTL_MS) {
    return topCratesCache.data;
  }

  const next = await provider.getTopCrates(10);
  topCratesCache = {
    fetchedAt: now,
    data: next,
  };
  return next;
}

export const load: PageServerLoad = async (event) => {
  const provider = initProvider(event);
  const searchQuery = event.url.searchParams.get("q")?.trim().slice(0, 100) ?? "";
  const canLoadLocalWorkspace = !isHosted && hasLocalWorkspace(provider);
  const workspace = canLoadLocalWorkspace ? await provider.loadWorkspace() : null;
  const [top, searchResults] = await Promise.all([
    getTopCratesCached(provider).catch((): TopCrate[] => []),
    searchQuery ? provider.searchRegistry(searchQuery).catch(() => []) : Promise.resolve([]),
  ]);

  return {
    hasLocalWorkspace: canLoadLocalWorkspace,
    localCrates: (workspace?.crates ?? []).map((crate) => ({
      id: crate.id,
      name: crate.name,
      version: crate.version,
    })),
    topCrates: top.map((crate) => ({
      id: crate.id ?? crate.name,
      name: crate.name,
      version: crate.version,
      description: crate.description,
    })),
    searchQuery,
    searchResults: searchResults.map((crate) => ({
      id: crate.id ?? crate.name,
      name: crate.name,
      version: crate.version,
      description: crate.description,
    })),
  };
};
