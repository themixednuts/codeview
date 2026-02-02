import { Result } from 'better-result';
import type { RegistryAdapter, PackageMetadata } from './types';
import { FetchError, JsonParseError } from '../errors';

const CRATES_IO_API = 'https://crates.io/api/v1';
const USER_AGENT = 'codeview (https://github.com/nicksenger/codeview)';

interface CratesIoVersion {
	num: string;
	dl_path: string;
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

interface CratesIoVersionEntry {
	num: string;
	yanked: boolean;
}

interface CratesIoVersionsResponse {
	versions: CratesIoVersionEntry[];
}

async function fetchJson<T>(url: string): Promise<Result<T, FetchError | JsonParseError>> {
	let res: Response;
	try {
		res = await fetch(url, {
			headers: { 'User-Agent': USER_AGENT }
		});
	} catch (err) {
		return Result.err(new FetchError({ url, status: 0, statusText: String(err) }));
	}
	if (!res.ok) {
		return Result.err(new FetchError({ url, status: res.status, statusText: res.statusText }));
	}
	try {
		const data = await res.json() as T;
		return Result.ok(data);
	} catch (err) {
		return Result.err(new JsonParseError({ message: `Failed to parse JSON from ${url}`, cause: err }));
	}
}

/** Extract "owner/repo" from a GitHub URL, or return undefined. */
function extractGitHubRepo(url: string | null | undefined): string | undefined {
	if (!url) return undefined;
	const match = url.match(/github\.com\/([^\/]+\/[^\/]+?)(?:\.git)?(?:\/|$)/);
	return match?.[1];
}

export function createCratesIoAdapter(): RegistryAdapter {
	return {
		async resolve(name, version) {
			const result = await fetchJson<{ version: CratesIoVersion; crate?: CratesIoCrate }>(
				`${CRATES_IO_API}/crates/${name}/${version}`
			);
			if (result.isErr()) return null;
			const data = result.value;
			if (!data.version) return null;

			// Build docs.rs rustdoc JSON URL
			const artifactUrl = `https://docs.rs/crate/${name}/${version}/json`;

			// crates.io download URL for source archive
			const sourceArchiveUrl = `https://crates.io${data.version.dl_path}`;

			return {
				ecosystem: 'rust',
				name,
				version: data.version.num,
				description: data.crate?.description,
				repository: extractGitHubRepo(data.crate?.repository),
				repositoryUrl: data.crate?.repository ?? undefined,
				artifactUrl,
				sourceArchiveUrl
			};
		},

		async search(query, limit = 20) {
			const result = await fetchJson<{ crates: CratesIoCrate[] }>(
				`${CRATES_IO_API}/crates?q=${encodeURIComponent(query)}&per_page=${limit}`
			);
			if (result.isErr()) return [];
			return result.value.crates.map((c) => ({
				ecosystem: 'rust' as const,
				name: c.name,
				version: c.max_version,
				description: c.description,
				repository: extractGitHubRepo(c.repository),
				repositoryUrl: c.repository ?? undefined
			}));
		},

		async listTop(limit = 10) {
			const result = await fetchJson<{ crates: CratesIoCrate[] }>(
				`${CRATES_IO_API}/crates?sort=recent-downloads&per_page=${limit}`
			);
			if (result.isErr()) return [];
			return result.value.crates.map((c) => ({
				ecosystem: 'rust' as const,
				name: c.name,
				version: c.max_version,
				description: c.description,
				repository: extractGitHubRepo(c.repository),
				repositoryUrl: c.repository ?? undefined
			}));
		},

		async listVersions(name, limit = 20) {
			const result = await fetchJson<CratesIoVersionsResponse>(
				`${CRATES_IO_API}/crates/${name}/versions?per_page=${limit}`
			);
			if (result.isErr()) return [];
			return result.value.versions
				.filter((v) => !v.yanked)
				.map((v) => v.num);
		},

		async getLatestVersion(name) {
			const result = await fetchJson<CratesIoCrateDetailResponse>(
				`${CRATES_IO_API}/crates/${name}`
			);
			if (result.isErr()) return null;
			return result.value.crate?.max_version ?? null;
		}
	};
}
