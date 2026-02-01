import type { RegistryAdapter, PackageMetadata } from './types';

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

async function fetchJson<T>(url: string): Promise<T> {
	const res = await fetch(url, {
		headers: { 'User-Agent': USER_AGENT }
	});
	if (!res.ok) {
		throw new Error(`crates.io API error: ${res.status} ${res.statusText}`);
	}
	return res.json() as Promise<T>;
}

/** Extract "owner/repo" from a GitHub URL, or return undefined. */
function extractGitHubRepo(url: string | null | undefined): string | undefined {
	if (!url) return undefined;
	const match = url.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\/|$)/);
	return match?.[1];
}

export function createCratesIoAdapter(): RegistryAdapter {
	return {
		async resolve(name, version) {
			try {
				const data = await fetchJson<{ version: CratesIoVersion; crate?: CratesIoCrate }>(
					`${CRATES_IO_API}/crates/${name}/${version}`
				);
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
			} catch {
				return null;
			}
		},

		async search(query, limit = 20) {
			try {
				const data = await fetchJson<{ crates: CratesIoCrate[] }>(
					`${CRATES_IO_API}/crates?q=${encodeURIComponent(query)}&per_page=${limit}`
				);
				return data.crates.map((c) => ({
					ecosystem: 'rust' as const,
					name: c.name,
					version: c.max_version,
					description: c.description,
					repository: extractGitHubRepo(c.repository),
					repositoryUrl: c.repository ?? undefined
				}));
			} catch {
				return [];
			}
		},

		async listTop(limit = 10) {
			try {
				const data = await fetchJson<{ crates: CratesIoCrate[] }>(
					`${CRATES_IO_API}/crates?sort=recent-downloads&per_page=${limit}`
				);
				return data.crates.map((c) => ({
					ecosystem: 'rust' as const,
					name: c.name,
					version: c.max_version,
					description: c.description,
					repository: extractGitHubRepo(c.repository),
					repositoryUrl: c.repository ?? undefined
				}));
			} catch {
				return [];
			}
		},

		async listVersions(name, limit = 20) {
			try {
				const data = await fetchJson<CratesIoVersionsResponse>(
					`${CRATES_IO_API}/crates/${name}/versions?per_page=${limit}`
				);
				const versions = data.versions
					.filter((v) => !v.yanked)
					.map((v) => v.num);
				return versions;
			} catch {
				return [];
			}
		},

		async getLatestVersion(name) {
			try {
				const data = await fetchJson<CratesIoCrateDetailResponse>(
					`${CRATES_IO_API}/crates/${name}`
				);
				return data.crate?.max_version ?? null;
			} catch {
				return null;
			}
		}
	};
}
