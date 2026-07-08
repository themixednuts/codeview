import { Result } from 'better-result';
import type { RegistryAdapter, PackageMetadata } from './types';
import { FetchError, JsonParseError } from '../errors';

const CRATES_IO_API = 'https://crates.io/api/v1';
const CRATES_IO_INDEX = 'https://index.crates.io';
const USER_AGENT = 'codeview (https://github.com/themixednuts/codeview)';
const DEFAULT_VERSION_LIMIT = Number.POSITIVE_INFINITY;

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

interface CratesIoCrateDetailResponse {
	crate: CratesIoCrate;
}

interface SparseIndexVersionEntry {
	vers: string;
	yanked?: boolean;
}

async function fetchJson<T>(url: string): Promise<Result<T, FetchError | JsonParseError>> {
	let res: Response;
	try {
		res = await fetch(url, {
			headers: { 'User-Agent': USER_AGENT },
		});
	} catch (err) {
		return Result.err(new FetchError({ url, status: 0, statusText: String(err) }));
	}
	if (!res.ok) {
		return Result.err(new FetchError({ url, status: res.status, statusText: res.statusText }));
	}
	try {
		const data = (await res.json()) as T;
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
		res = await fetch(url, {
			headers: { 'User-Agent': USER_AGENT },
		});
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
	const match = url.match(/github\.com\/([^\/]+\/[^\/]+?)(?:\.git)?(?:\/|$)/);
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

async function listSparseIndexVersions(name: string, limit: number): Promise<string[]> {
	const result = await fetchText(`${CRATES_IO_INDEX}/${sparseIndexPath(name)}`);
	if (result.isErr()) return [];
	const versions: string[] = [];
	for (const line of result.value.split('\n')) {
		if (!line) continue;
		try {
			const entry = JSON.parse(line) as Partial<SparseIndexVersionEntry>;
			if (typeof entry.vers === 'string' && entry.yanked !== true) {
				versions.push(entry.vers);
			}
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
			if (version === 'latest') {
				const latest = await adapter.getLatestVersion(name);
				if (!latest) return null;
				resolvedVersion = latest;
			}

			const result = await fetchJson<{ version: CratesIoVersion; crate?: CratesIoCrate }>(
				`${CRATES_IO_API}/crates/${name}/${resolvedVersion}`,
			);
			if (result.isErr()) return null;
			const data = result.value;
			if (!data.version) return null;

			// Build docs.rs rustdoc JSON URL (gzip)
			// Use canonical name from crates.io (e.g. rand_core) — docs.rs 404s on hyphenated variants (rand-core)
			const docsName = data.version.crate ?? name;
			const artifactUrl = `https://docs.rs/crate/${docsName}/${resolvedVersion}/json.gz`;

			// crates.io download URL for source archive
			const sourceArchiveUrl = `https://crates.io${data.version.dl_path}`;

			return {
				ecosystem: 'rust',
				name: canonicalCrateName(data.crate, data.version.crate ?? name),
				version: data.version.num,
				description: data.crate?.description,
				repository: extractGitHubRepo(data.crate?.repository),
				repositoryUrl: data.crate?.repository ?? undefined,
				artifactUrl,
				sourceArchiveUrl,
			};
		},

		async search(query, limit = 20) {
			const result = await fetchJson<{ crates: CratesIoCrate[] }>(
				`${CRATES_IO_API}/crates?q=${encodeURIComponent(query)}&per_page=${limit}`,
			);
			if (result.isErr()) return [];
			return result.value.crates.map((c) => ({
				ecosystem: 'rust' as const,
				name: c.name,
				version: c.max_version,
				description: c.description,
				repository: extractGitHubRepo(c.repository),
				repositoryUrl: c.repository ?? undefined,
			}));
		},

		async listTop(limit = 10) {
			const result = await fetchJson<{ crates: CratesIoCrate[] }>(
				`${CRATES_IO_API}/crates?sort=downloads&per_page=${limit}`,
			);
			if (result.isErr()) return [];
			return result.value.crates.map((c) => ({
				ecosystem: 'rust' as const,
				name: c.name,
				version: c.max_version,
				description: c.description,
				repository: extractGitHubRepo(c.repository),
				repositoryUrl: c.repository ?? undefined,
			}));
		},

		async listVersions(name, limit = DEFAULT_VERSION_LIMIT) {
			const maxVersions = Math.max(0, limit);
			if (maxVersions === 0) return [];
			return listSparseIndexVersions(name, maxVersions);
		},

		async getLatestVersion(name) {
			const result = await fetchJson<CratesIoCrateDetailResponse>(
				`${CRATES_IO_API}/crates/${name}`,
			);
			if (result.isErr()) return null;
			return result.value.crate?.max_version ?? null;
		},
	};
	return adapter;
}
