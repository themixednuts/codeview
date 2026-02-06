import type { SourceProviderGroup } from './sources/types';
import type { CrateStatus } from './provider';

export const USER_AGENT = 'codeview';
export const SOURCE_MAX_BYTES = 96 * 1024 * 1024;

/**
 * Classify `action` from a failed status error message.
 * The DB doesn't store `action`, so we re-derive it from the error string
 * whenever a status is read back from storage.
 */
export function classifyStatusAction(status: { status: string; error?: string | null }): CrateStatus['action'] {
	if (status.status === 'failed' && status.error && /Failed to fetch artifact:.*\b404\b/.test(status.error)) {
		return 'docs_unavailable';
	}
	return undefined;
}

export function sourcePathCandidates(path: string): string[] {
	const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
	const withSrc = normalized.startsWith('src/') ? normalized : `src/${normalized}`;
	const withoutSrc = normalized.startsWith('src/') ? normalized.slice('src/'.length) : normalized;
	const values = [normalized, withSrc, withoutSrc];
	return values.filter((v, i, all) => v.length > 0 && all.indexOf(v) === i);
}

export function resolveSourceFileFromMap(files: Map<string, string>, file: string): string | null {
	for (const candidate of sourcePathCandidates(file)) {
		const exact = files.get(candidate);
		if (exact !== undefined) return exact;
	}
	for (const candidate of sourcePathCandidates(file)) {
		const suffix = `/${candidate}`;
		for (const [path, content] of files) {
			const normalizedPath = path.replace(/\\/g, '/');
			if (normalizedPath === candidate || normalizedPath.endsWith(suffix)) return content;
		}
	}
	return null;
}

export function selectSourceProviders(
	group: SourceProviderGroup,
	mode: 'auto' | 'crates-io' | 'github'
): SourceProviderGroup {
	if (mode === 'auto') return group;
	if (mode === 'crates-io') {
		return {
			...group,
			main: group.main.filter((provider) => provider.id === 'crate-archive'),
			fallbacks: []
		};
	}
	return {
		...group,
		main: [],
		fallbacks: group.fallbacks.filter((provider) => provider.id.startsWith('github-'))
	};
}
