import { query, command, form } from '$app/server';
import { isHosted } from '$lib/platform';
import { sanitizeSearchQuery } from '$lib/server/validation';
import {
	type CrateSummary,
	type CrateIndex,
	type CrateTree,
	type CrateStatus,
	type CrateSearchResult,
} from '$lib/schema';
import { loader, summarizeNode } from './helpers';
import { assertCrateName, assertCrateRef, throwIfProviderErr } from './remote-utils';
import {
	CrateRefSchema,
	ProcessingInputSchema,
	CrateVersionInputSchema,
	CrateNameInputSchema,
	RegistrySearchInputSchema,
	TriggerParseInputSchema,
	InstallStdDocsInputSchema,
	ProbeDocsInputSchema,
} from './schemas';

/** Get list of workspace crates (for index page + switcher) */
export const getCrates = query(async (): Promise<CrateSummary[]> => {
	const ws = await loader.workspace();
	if (!ws) return [];
	return ws.crates.map((c) => ({
		id: c.id,
		name: c.name,
		version: c.version,
	}));
});

/** Get a hosted-friendly list of top crates (registry-backed). */
export const getTopCrates = query(async (): Promise<CrateSearchResult[]> => {
	const provider = await loader.provider();
	return provider.getTopCrates(10);
});

/** Get currently processing crates (cloud mode). */
export const getProcessingCrates = query(
	ProcessingInputSchema,
	async (): Promise<CrateSearchResult[]> => {
		const provider = await loader.provider();
		return provider.getProcessingCrates(20);
	},
);

/** Get available versions for a crate */
export const getCrateVersions = query(CrateNameInputSchema, async ({ name }): Promise<string[]> => {
	assertCrateName(name);
	const provider = await loader.provider();
	return await provider.getCrateVersions(name, 20);
});

/** Get a lightweight crate index for hosted mode (external crate list + versions). */
export const getCrateIndex = query(
	CrateRefSchema,
	async ({ name, version }): Promise<CrateIndex | null> => {
		const provider = await loader.provider();
		return await provider.loadCrateIndex(name, version ?? 'latest');
	},
);

/** Get the parse status of a crate (cloud mode). */
export const getCrateStatus = query(
	CrateVersionInputSchema,
	async ({ name, version }): Promise<CrateStatus> => {
		assertCrateRef(name, version);
		const provider = await loader.provider();
		return provider.getCrateStatus(name, version);
	},
);

/** Trigger parsing of a crate (cloud mode). */
export const triggerCrateParse = command(
	TriggerParseInputSchema,
	async ({ name, version, force }): Promise<void> => {
		assertCrateRef(name, version);
		const provider = await loader.provider();
		const result = await provider.triggerParse(name, version, !!force);
		throwIfProviderErr(result, { RateLimitError: 429 });
	},
);

export const triggerCrateParseForm = form(
	TriggerParseInputSchema,
	async ({ name, version, force }): Promise<void> => {
		assertCrateRef(name, version);
		const provider = await loader.provider();
		const result = await provider.triggerParse(name, version, !!force);
		throwIfProviderErr(result, { RateLimitError: 429 });
	},
);

/** Trigger std crate install + parse (local mode, requires user consent). */
export const installStdDocs = form(
	InstallStdDocsInputSchema,
	async ({ name, version }): Promise<void> => {
		assertCrateRef(name, version);
		const provider = await loader.provider();
		const result = await provider.triggerStdInstall(name, version);
		throwIfProviderErr(result);
	},
);

/** Search the registry for crates (cloud mode). */
export const searchRegistry = query(
	RegistrySearchInputSchema,
	async ({ q }): Promise<CrateSearchResult[]> => {
		const queryText = sanitizeSearchQuery(q);
		if (!queryText) return [];
		const provider = await loader.provider();
		return provider.searchRegistry(queryText);
	},
);

/**
 * Probe docs.rs to find the newest version with rustdoc JSON available.
 * Fires concurrent HEAD requests, preferring stable versions over pre-releases,
 * and aborts remaining requests once the best match is confirmed.
 */
export const probeAvailableDocsVersion = query(
	ProbeDocsInputSchema,
	async ({ name, currentVersion, candidates }): Promise<string | null> => {
		const MAX_PROBES = 10;
		const TIMEOUT_MS = 10_000;

		// Filter out current version, then order: stable first, pre-release after
		const filtered = candidates.filter((v) => v !== currentVersion);
		const stable = filtered.filter((v) => !v.includes('-'));
		const preRelease = filtered.filter((v) => v.includes('-'));
		const ordered = [...stable, ...preRelease].slice(0, MAX_PROBES);

		if (ordered.length === 0) return null;

		const controllers = ordered.map(() => new AbortController());
		const settled = new Array<boolean>(ordered.length).fill(false);
		const succeeded = new Array<boolean>(ordered.length).fill(false);

		return new Promise<string | null>((resolve) => {
			let resolved = false;
			let settledCount = 0;

			const timeoutId = setTimeout(() => {
				if (!resolved) {
					resolved = true;
					for (const c of controllers) c.abort();
					resolve(null);
				}
			}, TIMEOUT_MS);

			function checkResolve() {
				if (resolved) return;

				// Walk in order: return earliest version that succeeded,
				// but only once all higher-priority versions have settled.
				for (let i = 0; i < ordered.length; i++) {
					if (!settled[i]) return; // still waiting on a higher-priority version
					if (succeeded[i]) {
						resolved = true;
						clearTimeout(timeoutId);
						for (let j = i + 1; j < ordered.length; j++) {
							if (!settled[j]) controllers[j].abort();
						}
						resolve(ordered[i]);
						return;
					}
				}

				// All settled, none succeeded
				if (settledCount === ordered.length) {
					resolved = true;
					clearTimeout(timeoutId);
					resolve(null);
				}
			}

			ordered.forEach((version, i) => {
				fetch(`https://docs.rs/crate/${name}/${version}/json.gz`, {
					method: 'HEAD',
					signal: controllers[i].signal,
					headers: { 'User-Agent': 'codeview' },
				})
					.then((res) => {
						succeeded[i] = res.ok;
					})
					.catch(() => {
						succeeded[i] = false;
					})
					.finally(() => {
						settled[i] = true;
						settledCount++;
						checkResolve();
					});
			});
		});
	},
);

/** Load a single crate graph from R2 (cloud mode). */
export const loadCrateGraph = query(
	CrateRefSchema,
	async ({ name, version }): Promise<CrateTree | null> => {
		assertCrateRef(name, version ?? 'latest');
		const provider = await loader.provider();
		if (isHosted) return null;
		const graph = await provider.loadCrateGraph(name, version ?? 'latest');
		if (!graph) return null;

		// Filter to tree-relevant edges only
		const treeEdges = graph.edges.filter(
			(e: { kind: string }) => e.kind === 'Contains' || e.kind === 'Defines',
		);

		return {
			nodes: graph.nodes.map(summarizeNode),
			edges: treeEdges,
		};
	},
);
