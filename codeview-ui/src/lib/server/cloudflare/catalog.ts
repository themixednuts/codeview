import type { StaticCrateCatalogEntry } from "#lib/schema.js";
import { isStdCrate } from "#lib/std.js";
import { crateNameVariants, normalizeCrateName } from "../validation";

export type CatalogCrateSummary = {
  id?: string;
  name: string;
  version: string;
  description?: string;
};

function catalogEntryVersion(entry: StaticCrateCatalogEntry): string | null {
  return entry.version.length > 0 ? entry.version : null;
}

export function catalogEntryToSummary(entry: StaticCrateCatalogEntry): CatalogCrateSummary | null {
  const version = catalogEntryVersion(entry);
  if (!version) return null;
  return {
    id: entry.storageName ?? crateNameVariants(entry.name)[1],
    name: entry.name,
    version,
    description: entry.description,
  };
}

export function orderCatalogSummaries(entries: StaticCrateCatalogEntry[]): CatalogCrateSummary[] {
  const std: CatalogCrateSummary[] = [];
  const thirdParty: CatalogCrateSummary[] = [];
  for (const entry of entries) {
    const summary = catalogEntryToSummary(entry);
    if (!summary) continue;
    const source = entry.source === "std" || isStdCrate(normalizeCrateName(entry.name));
    (source ? std : thirdParty).push(summary);
  }
  return [...thirdParty, ...std];
}
