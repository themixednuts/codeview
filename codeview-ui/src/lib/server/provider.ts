import type { RequestEvent } from '@sveltejs/kit';
import type { Edge, Workspace, CrateGraph } from '$lib/graph';
import type { CrateIndex, NodeSummary } from '$lib/schema';

export type CrateStatusValue = 'unknown' | 'processing' | 'ready' | 'failed';

export interface CrateStatus {
	status: CrateStatusValue;
	error?: string;
}

export interface CrateSummaryResult {
	name: string;
	version: string;
	description?: string;
}

export interface CrossEdgeData {
	edges: Edge[];
	nodes: NodeSummary[];
}

export interface DataProvider {
	// Existing (kept for local CLI / single-workspace mode)
	loadWorkspace(): Promise<Workspace | null>;
	loadSourceFile(relativePath: string): Promise<{
		error: string | null;
		content: string | null;
	}>;

	// Cloud multi-crate mode
	loadCrateGraph(name: string, version: string): Promise<CrateGraph | null>;
	loadCrateIndex(name: string, version: string): Promise<CrateIndex | null>;
	getCrossEdgeData(nodeId: string): Promise<CrossEdgeData>;
	getCrateStatus(name: string, version: string): Promise<CrateStatus>;
	triggerParse(name: string, version: string): Promise<void>;
	searchRegistry(query: string): Promise<CrateSummaryResult[]>;
	getTopCrates(limit?: number): Promise<CrateSummaryResult[]>;
	getProcessingCrates(limit?: number): Promise<CrateSummaryResult[]>;
	getCrateVersions(name: string, limit?: number): Promise<string[]>;
}

function hasCloudflarePlatform(
	event: RequestEvent
): event is RequestEvent & { platform: { env: Env } } {
	return !!event.platform?.env?.GRAPH_STORE;
}

let _provider: DataProvider | null = null;

export async function initProvider(event: RequestEvent): Promise<DataProvider> {
	if (_provider) return _provider;

	if (hasCloudflarePlatform(event)) {
		const mod = await import('./provider.cloudflare');
		_provider = mod.createCloudflareProvider(event.platform.env);
	} else {
		const mod = await import('./provider.local');
		_provider = mod.createLocalProvider();
	}

	return _provider;
}
