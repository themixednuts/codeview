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
		const withoutSrc = normalized.startsWith('src/') ? normalized.slice('src/'.length) : normalized;
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

	selectProviders(group: SourceProviderGroup, mode: SourceProviderMode): SourceProviderGroup {
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

// ─────────────────────────────────────────────────────────────────────────────
// Std-library source loader
//
// The standard-library crates (`std`/`core`/`alloc`/`proc_macro`/`test`) live
// in `rust-lang/rust` under `library/{crate}/...`. Their rustdoc spans already
// use that exact form (e.g. `library/alloc/src/boxed.rs`), so we just pick a
// git ref that matches the crate version and stream the file from GitHub raw.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pick a rust-lang/rust git ref for an std crate version.
 * - "1.x.y-nightly" → master (no exact commit pinned in rustdoc JSON)
 * - "1.x.y-beta.N"  → beta
 * - "1.x.y"          → tag "1.x.y"
 * - channel aliases  → branch matching the channel
 */
export function stdRustRef(version: string): string {
	const v = version.trim();
	if (v === 'stable') return 'stable';
	if (v === 'beta') return 'beta';
	if (v === 'nightly' || v === 'latest') return 'master';
	if (/-nightly(\.|$)/i.test(v)) return 'master';
	if (/-beta(\.|$)/i.test(v)) return 'beta';
	if (/^\d+\.\d+(\.\d+)?$/.test(v)) return v;
	return 'master';
}

/** GitHub raw + blob URL pair for an std-library source path. */
export function buildStdSourceUrls(
	relativePath: string,
	version: string,
): { rawUrl: string; blobUrl: string } {
	const ref = stdRustRef(version);
	const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
	return {
		rawUrl: `https://raw.githubusercontent.com/rust-lang/rust/${ref}/${normalized}`,
		blobUrl: `https://github.com/rust-lang/rust/blob/${ref}/${normalized}`,
	};
}

/** Fetch an std-library source file from rust-lang/rust on GitHub. */
export async function fetchStdSourceFile(
	relativePath: string,
	version: string,
	maxBytes: number,
	userAgent: string,
): Promise<{ content: string; blobUrl: string } | { error: string; blobUrl: string }> {
	const { rawUrl, blobUrl } = buildStdSourceUrls(relativePath, version);
	try {
		const response = await fetch(rawUrl, {
			headers: { 'User-Agent': userAgent, Accept: 'text/plain' },
		});
		if (!response.ok) {
			return {
				error: `Std source fetch failed: ${response.status} ${response.statusText}`,
				blobUrl,
			};
		}
		const text = await response.text();
		return { content: text.length > maxBytes ? text.slice(0, maxBytes) : text, blobUrl };
	} catch (err) {
		return {
			error: `Std source fetch error: ${err instanceof Error ? err.message : String(err)}`,
			blobUrl,
		};
	}
}
