import type { SourceProviderGroup } from './sources/types';
import type { CrateStatus } from './provider';

export const USER_AGENT = 'codeview';
export const SOURCE_MAX_BYTES = 96 * 1024 * 1024;

export type SourceProviderMode = 'auto' | 'crates-io' | 'github';

interface StatusActionOps {
	classify(status: { status: string; error?: string | null }): CrateStatus['action'];
}

export const statusAction = {
	/**
	 * Classify `action` from a failed status error message.
	 * The DB doesn't store `action`, so we re-derive it from the error string
	 * whenever a status is read back from storage.
	 */
	classify(status: { status: string; error?: string | null }): CrateStatus['action'] {
		if (
			status.status === 'failed' &&
			status.error &&
			/Failed to fetch artifact:.*\b404\b/.test(status.error)
		) {
			return 'docs_unavailable';
		}
		return undefined;
	},
} satisfies StatusActionOps;

interface SourceOps {
	pathCandidates(path: string): string[];
	resolveFromMap(files: Map<string, string>, file: string): string | null;
	selectProviders(group: SourceProviderGroup, mode: SourceProviderMode): SourceProviderGroup;
}

export const source = {
	pathCandidates(path: string): string[] {
		const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
		const withSrc = normalized.startsWith('src/') ? normalized : `src/${normalized}`;
		const withoutSrc = normalized.startsWith('src/')
			? normalized.slice('src/'.length)
			: normalized;
		const values = [normalized, withSrc, withoutSrc];
		return values.filter((v, i, all) => v.length > 0 && all.indexOf(v) === i);
	},

	resolveFromMap(files: Map<string, string>, file: string): string | null {
		for (const candidate of source.pathCandidates(file)) {
			const exact = files.get(candidate);
			if (exact !== undefined) return exact;
		}
		for (const candidate of source.pathCandidates(file)) {
			const suffix = `/${candidate}`;
			for (const [path, content] of files) {
				const normalizedPath = path.replace(/\\/g, '/');
				if (normalizedPath === candidate || normalizedPath.endsWith(suffix)) return content;
			}
		}
		return null;
	},

	selectProviders(
		group: SourceProviderGroup,
		mode: SourceProviderMode,
	): SourceProviderGroup {
		if (mode === 'auto') return group;
		if (mode === 'crates-io') {
			return {
				...group,
				main: group.main.filter((provider) => provider.id === 'crate-archive'),
				fallbacks: [],
			};
		}
		return {
			...group,
			main: [],
			fallbacks: group.fallbacks.filter((provider) => provider.id.startsWith('github-')),
		};
	},
} satisfies SourceOps;
