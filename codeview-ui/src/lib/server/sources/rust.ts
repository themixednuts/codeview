import type {
	SourceAdapter,
	SourceFetchContext,
	SourceProvider,
	SourceProviderGroup,
	SourceRequest,
	SourceFetchOutcome
} from './types';
import { fetchSourceArchive } from '../parser/source-archive';
import {
	collectManifests,
	filterSourceFilesForManifest,
	selectManifestForCrate
} from '../parser/cargo-manifest';

type RepoInfo =
	| { host: 'github'; owner: string; repo: string }
	| { host: 'gitlab'; projectPath: string; repoName: string }
	| { host: 'unknown' };

const DEFAULT_REFS = (version: string) => [`v${version}`, version, 'main', 'master'];

export function createRustSourceAdapter(): SourceAdapter {
	return {
		getProviders(request: SourceRequest): SourceProviderGroup {
			const { metadata } = request;
			const main: SourceProvider[] = [];
			const fallbacks: SourceProvider[] = [];

			if (metadata.sourceArchiveUrl) {
				main.push(createArchiveProvider('crate-archive', metadata.sourceArchiveUrl));
			}

			const repoInfo = parseRepository(metadata);
			if (repoInfo.host === 'github') {
				fallbacks.push(createGitHubProvider(repoInfo));
			} else if (repoInfo.host === 'gitlab') {
				fallbacks.push(createGitLabProvider(repoInfo));
			}

			return { main, fallbacks, maxMainFailures: 2, mainRetries: 2, fallbackRetries: 1 };
		}
	};
}

function createArchiveProvider(id: string, url: string): SourceProvider {
	return {
		id,
		async fetch(request: SourceRequest, context: SourceFetchContext): Promise<SourceFetchOutcome> {
			const archive = await fetchSourceArchive(url, {
				maxBytes: context.maxBytes,
				userAgent: context.userAgent
			});
			if (archive.status === 'ok') {
				const filtered = filterForCrate(request.name, archive.files);
				return filtered ? { status: 'ok', files: filtered } : { status: 'not-found' };
			}
			if (archive.status === 'over-limit') {
				return { status: 'over-limit' };
			}
			return { status: 'error', message: archive.message };
		}
	};
}

function createGitHubProvider(repoInfo: Extract<RepoInfo, { host: 'github' }>): SourceProvider {
	return {
		id: `github-${repoInfo.owner}/${repoInfo.repo}`,
		async fetch(request: SourceRequest, context: SourceFetchContext): Promise<SourceFetchOutcome> {
			const headers: Record<string, string> = {};
			if (context.githubToken) {
				headers['Authorization'] = `Bearer ${context.githubToken}`;
			}
			for (const ref of DEFAULT_REFS(request.version)) {
				const url = `https://codeload.github.com/${repoInfo.owner}/${repoInfo.repo}/tar.gz/${ref}`;
				const archive = await fetchSourceArchive(url, {
					maxBytes: context.maxBytes,
					userAgent: context.userAgent,
					headers
				});
				if (archive.status === 'ok') {
					const filtered = filterForCrate(request.name, archive.files);
					return filtered ? { status: 'ok', files: filtered } : { status: 'not-found' };
				}
				if (archive.status === 'over-limit') {
					return { status: 'over-limit' };
				}
			}
			return { status: 'not-found' };
		}
	};
}

function createGitLabProvider(repoInfo: Extract<RepoInfo, { host: 'gitlab' }>): SourceProvider {
	return {
		id: `gitlab-${repoInfo.projectPath}`,
		async fetch(request: SourceRequest, context: SourceFetchContext): Promise<SourceFetchOutcome> {
			for (const ref of DEFAULT_REFS(request.version)) {
				const url = `https://${repoInfo.projectPath}/-/archive/${ref}/${repoInfo.repoName}-${ref}.tar.gz`;
				const archive = await fetchSourceArchive(url, {
					maxBytes: context.maxBytes,
					userAgent: context.userAgent
				});
				if (archive.status === 'ok') {
					const filtered = filterForCrate(request.name, archive.files);
					return filtered ? { status: 'ok', files: filtered } : { status: 'not-found' };
				}
				if (archive.status === 'over-limit') {
					return { status: 'over-limit' };
				}
			}
			return { status: 'not-found' };
		}
	};
}

function parseRepository(metadata: SourceRequest['metadata']): RepoInfo {
	if (metadata.repositoryUrl) {
		const urlInfo = parseRepositoryUrl(metadata.repositoryUrl);
		if (urlInfo) return urlInfo;
	}

	if (metadata.repository) {
		const [owner, repo] = metadata.repository.split('/');
		if (owner && repo) return { host: 'github', owner, repo };
	}

	return { host: 'unknown' };
}

function parseRepositoryUrl(urlValue: string): RepoInfo | null {
	const trimmed = urlValue.trim();
	if (!trimmed) return null;

	const scpMatch = trimmed.match(/^git@([^:]+):(.+)$/);
	if (scpMatch) {
		const host = scpMatch[1];
		const path = scpMatch[2].replace(/\.git$/, '').replace(/^\/+/, '');
		return parseRepoByHost(host, path);
	}

	try {
		const url = new URL(trimmed);
		const host = url.hostname;
		const path = url.pathname.replace(/\.git$/, '').replace(/^\/+/, '');
		return parseRepoByHost(host, path);
	} catch {
		return null;
	}
}

function parseRepoByHost(host: string, path: string): RepoInfo | null {
	if (!host || !path) return null;
	if (host.includes('github.com')) {
		const [owner, repo] = path.split('/');
		if (owner && repo) return { host: 'github', owner, repo };
		return null;
	}
	if (host.includes('gitlab')) {
		const segments = path.split('/').filter(Boolean);
		if (segments.length === 0) return null;
		const repoName = segments[segments.length - 1];
		const projectPath = `${host}/${segments.join('/')}`;
		return { host: 'gitlab', projectPath, repoName };
	}
	return { host: 'unknown' };
}

function filterForCrate(crateName: string, files: Map<string, string>): Map<string, string> | null {
	const manifests = collectManifests(files);
	const manifest = selectManifestForCrate(crateName, manifests);
	if (!manifest) return null;
	const filtered = filterSourceFilesForManifest(files, manifest);
	const hasRust = [...filtered.keys()].some((path) => path.endsWith('.rs'));
	return hasRust ? filtered : null;
}
