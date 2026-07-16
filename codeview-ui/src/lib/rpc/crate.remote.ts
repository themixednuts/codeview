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
import { summarizeNode } from '$lib/node-summary';
import { loader } from './helpers';
import { assertCrateName, assertCrateRef, throwIfProviderErr } from './remote-utils';
import {
	CrateRefSchema,
	ProcessingInputSchema,
	CrateVersionInputSchema,
	CrateNameInputSchema,
	RegistrySearchInputSchema,
	TriggerParseInputSchema,
	InstallStdDocsInputSchema,
} from './schemas';

/** Get local CLI workspace crates. Hosted mode has no workspace. */
export const getLocalCrates = query(async (): Promise<CrateSummary[]> => {
	if (isHosted) return [];
	const ws = await loader.localWorkspace();
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
	return await provider.getCrateVersions(name);
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

async function requestParse({ name, version }: { name: string; version: string }): Promise<void> {
	assertCrateRef(name, version);
	const provider = await loader.provider();
	const result = await provider.triggerParse(name, version, false);
	throwIfProviderErr(result, { RateLimitError: 429 });
}

/** Trigger parsing from an imperative client flow. */
export const triggerCrateParse = command(TriggerParseInputSchema, requestParse);

/** Progressively enhanced parse request form for user-facing controls. */
export const requestCrateParse = form(TriggerParseInputSchema, requestParse);

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
