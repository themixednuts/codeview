import { Result } from "better-result";
import * as Predicate from "effect/Predicate";
import type { Json, JsonObject } from "effect/Schema";
import type { RegistryAdapter, PackageMetadata } from "./types";
import { FetchError, JsonParseError } from "../errors";

const CRATES_IO_API = "https://crates.io/api/v1";
const CRATES_IO_INDEX = "https://index.crates.io";
const USER_AGENT = "codeview (https://github.com/themixednuts/codeview)";
const DEFAULT_VERSION_LIMIT = Number.POSITIVE_INFINITY;
const CACHE_TTL_BY_STATUS = {
  "200-299": 600,
  "404": 60,
  "500-599": -1,
} as const satisfies Record<string, number>;

interface CratesIoVersion {
  num: string;
  dl_path: string;
  crate: string;
}

interface CratesIoCrate {
  id: string;
  name: string;
  description: string;
  repository: string | null;
  max_version: string;
}

function cachedRequestInit(): RequestInit<RequestInitCfProperties> {
  return {
    headers: { "User-Agent": USER_AGENT },
    cf: {
      cacheEverything: true,
      cacheTtlByStatus: CACHE_TTL_BY_STATUS,
    },
  };
}

async function fetchJson(url: string): Promise<Result<Json, FetchError | JsonParseError>> {
  let res: Response;
  try {
    res = await fetch(url, cachedRequestInit());
  } catch (err) {
    return Result.err(new FetchError({ url, status: 0, statusText: String(err) }));
  }
  if (!res.ok) {
    return Result.err(new FetchError({ url, status: res.status, statusText: res.statusText }));
  }
  try {
    const data: Json = await res.json();
    return Result.ok(data);
  } catch (err) {
    return Result.err(
      new JsonParseError({ message: `Failed to parse JSON from ${url}`, cause: err }),
    );
  }
}

async function fetchText(url: string): Promise<Result<string, FetchError>> {
  let res: Response;
  try {
    res = await fetch(url, cachedRequestInit());
  } catch (err) {
    return Result.err(new FetchError({ url, status: 0, statusText: String(err) }));
  }
  if (!res.ok) {
    return Result.err(new FetchError({ url, status: res.status, statusText: res.statusText }));
  }
  return Result.ok(await res.text());
}

/** Extract "owner/repo" from a GitHub URL, or return undefined. */
function extractGitHubRepo(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const match = url.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\/|$)/);
  return match?.[1];
}

function canonicalCrateName(crate_: CratesIoCrate | undefined, fallback: string): string {
  return crate_?.name || crate_?.id || fallback;
}

function sparseIndexPath(name: string): string {
  const crateName = name.toLowerCase();
  if (crateName.length === 1) return `1/${crateName}`;
  if (crateName.length === 2) return `2/${crateName}`;
  if (crateName.length === 3) return `3/${crateName[0]}/${crateName}`;
  return `${crateName.slice(0, 2)}/${crateName.slice(2, 4)}/${crateName}`;
}

function isJsonObject(value: Json): value is JsonObject {
  return Predicate.isObject(value);
}

function parseCratesIoCrate(value: Json): CratesIoCrate | undefined {
  if (!isJsonObject(value)) return undefined;
  const { id, name, description, repository, max_version } = value;
  if (
    !Predicate.isString(id) ||
    !Predicate.isString(name) ||
    !Predicate.isString(description) ||
    !Predicate.isString(max_version)
  ) {
    return undefined;
  }
  if (repository !== null && repository !== undefined && !Predicate.isString(repository)) {
    return undefined;
  }
  return {
    id,
    name,
    description,
    repository: Predicate.isString(repository) ? repository : null,
    max_version,
  };
}

function parseCratesIoVersion(value: Json): CratesIoVersion | undefined {
  if (!isJsonObject(value)) return undefined;
  const { num, dl_path, crate: crateName } = value;
  if (!Predicate.isString(num) || !Predicate.isString(dl_path) || !Predicate.isString(crateName)) {
    return undefined;
  }
  return { num, dl_path, crate: crateName };
}

function parseCrateList(value: Json): CratesIoCrate[] {
  if (!isJsonObject(value) || !Array.isArray(value.crates)) return [];
  return value.crates.flatMap((entry) => {
    const crate = parseCratesIoCrate(entry);
    return crate ? [crate] : [];
  });
}

function crateToPackage(crate: CratesIoCrate): PackageMetadata {
  return {
    ecosystem: "rust",
    name: crate.name,
    version: crate.max_version,
    description: crate.description,
    repository: extractGitHubRepo(crate.repository),
    repositoryUrl: crate.repository ?? undefined,
  };
}

async function listSparseIndexVersions(name: string, limit: number): Promise<string[]> {
  const result = await fetchText(`${CRATES_IO_INDEX}/${sparseIndexPath(name)}`);
  if (result.isErr()) return [];
  const versions: string[] = [];
  for (const line of result.value.split("\n")) {
    if (!line) continue;
    try {
      const parsed: Json = JSON.parse(line);
      if (!isJsonObject(parsed) || !Predicate.isString(parsed.vers) || parsed.yanked === true) {
        continue;
      }
      versions.push(parsed.vers);
    } catch {
      continue;
    }
  }
  return versions.reverse().slice(0, limit);
}

export function createCratesIoAdapter(): RegistryAdapter {
  const adapter: RegistryAdapter = {
    async resolve(name, version) {
      // Resolve "latest" to actual version number
      let resolvedVersion = version;
      if (version === "latest") {
        const latest = await adapter.getLatestVersion(name);
        if (!latest) return null;
        resolvedVersion = latest;
      }

      const result = await fetchJson(`${CRATES_IO_API}/crates/${name}/${resolvedVersion}`);
      if (result.isErr()) return null;
      if (!isJsonObject(result.value)) return null;
      const dataVersion = parseCratesIoVersion(result.value.version);
      if (!dataVersion) return null;
      const dataCrate = parseCratesIoCrate(result.value.crate);

      // Build docs.rs rustdoc JSON URL (gzip)
      // Use canonical name from crates.io (e.g. rand_core) — docs.rs 404s on hyphenated variants (rand-core)
      const docsName = dataVersion.crate ?? name;
      const artifactUrl = `https://docs.rs/crate/${docsName}/${resolvedVersion}/json.gz`;

      // crates.io download URL for source archive
      const sourceArchiveUrl = `https://crates.io${dataVersion.dl_path}`;

      return {
        ecosystem: "rust",
        name: canonicalCrateName(dataCrate, dataVersion.crate ?? name),
        version: dataVersion.num,
        description: dataCrate?.description,
        repository: extractGitHubRepo(dataCrate?.repository),
        repositoryUrl: dataCrate?.repository ?? undefined,
        artifactUrl,
        sourceArchiveUrl,
      };
    },

    async search(query, limit = 20) {
      const result = await fetchJson(
        `${CRATES_IO_API}/crates?q=${encodeURIComponent(query)}&per_page=${limit}`,
      );
      if (result.isErr()) return [];
      return parseCrateList(result.value).map(crateToPackage);
    },

    async listTop(limit = 10) {
      const result = await fetchJson(`${CRATES_IO_API}/crates?sort=downloads&per_page=${limit}`);
      if (result.isErr()) return [];
      return parseCrateList(result.value).map(crateToPackage);
    },

    async listVersions(name, limit = DEFAULT_VERSION_LIMIT) {
      const maxVersions = Math.max(0, limit);
      if (maxVersions === 0) return [];
      return listSparseIndexVersions(name, maxVersions);
    },

    async getLatestVersion(name) {
      const result = await fetchJson(`${CRATES_IO_API}/crates/${name}`);
      if (result.isErr()) return null;
      if (!isJsonObject(result.value)) return null;
      return parseCratesIoCrate(result.value.crate)?.max_version ?? null;
    },
  };
  return adapter;
}
