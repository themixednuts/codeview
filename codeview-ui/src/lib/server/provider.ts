import type { Result } from 'better-result';
import type { Edge, Workspace, CrateGraph } from '$lib/graph';
import type { CrateIndex, NodeSummary } from '$lib/schema';
import type { ValidationError, NotAvailableError, RateLimitError } from './errors';

export type CrateStatusValue = 'unknown' | 'processing' | 'ready' | 'failed';

export interface CrateStatus {
	status: CrateStatusValue;
	error?: string;
	step?: string;
	action?: 'install_std_docs';
	installedVersion?: string;
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
	triggerParse(name: string, version: string, force?: boolean): Promise<Result<void, ValidationError | NotAvailableError | RateLimitError>>;
	triggerStdInstall(name: string, version: string): Promise<Result<void, ValidationError | NotAvailableError>>;
	searchRegistry(query: string): Promise<CrateSummaryResult[]>;
	getTopCrates(limit?: number): Promise<CrateSummaryResult[]>;
	getProcessingCrates(limit?: number): Promise<CrateSummaryResult[]>;
	getCrateVersions(name: string, limit?: number): Promise<string[]>;

	// SSE streaming
	streamCrateStatus(name: string, version: string, signal: AbortSignal): Promise<Response>;
	streamProcessingStatus(ecosystem: string, signal: AbortSignal): Promise<Response>;
	streamEdgeUpdates(nodeId: string, signal: AbortSignal): Promise<Response>;
}

/**
 * Create the data provider for the current platform.
 *
 * `$provider` is a virtual alias resolved at build time via kit.alias in
 * svelte.config.js — it points to cloudflare/provider.ts or local/provider.ts
 * depending on PUBLIC_CODEVIEW_PLATFORM. This keeps incompatible platform
 * APIs (node:fs vs Cloudflare DO/R2) out of the wrong bundle entirely.
 */
export { createProvider as initProvider } from '$provider';
