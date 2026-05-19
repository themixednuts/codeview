import type { Result } from 'better-result';
import type { Edge, Node, Workspace, CrateGraph } from '$lib/graph';
import type { CrateIndex, CrateTree, NodeSummary, NodeDetail, TreeNodeDTO } from '$lib/schema';
import type { CrateMapData, CrateMapOptions } from '$lib/graph/crate-map';
import type { ValidationError, NotAvailableError, RateLimitError } from './errors';
import type { SourceProviderMode } from './provider-utils';

export type CrateStatusValue = 'unknown' | 'processing' | 'ready' | 'failed';

export interface CrateStatus {
	status: CrateStatusValue;
	error?: string;
	step?: string;
	action?: 'install_std_docs' | 'docs_unavailable';
	installedVersion?: string;
}

export interface CrateSummaryResult {
	id?: string;
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
	loadSourceFile(
		relativePath: string,
		crateName?: string,
		crateVersion?: string,
		sourceProvider?: SourceProviderMode,
	): Promise<{
		error: string | null;
		content: string | null;
		absolutePath: string | null;
		repoUrl: string | null;
	}>;

	// Cloud multi-crate mode
	loadCrateGraph(name: string, version: string): Promise<CrateGraph | null>;
	loadCrateTree(name: string, version: string): Promise<CrateTree | null>;
	loadCrateIndex(name: string, version: string): Promise<CrateIndex | null>;
	/** Load a single node with its edges and related nodes (progressive loading) */
	loadNodeDetail?(name: string, version: string, nodeId: string): Promise<NodeDetail | null>;
	loadNodeViewDirect?(
		name: string,
		version: string,
		nodeId: string,
	): Promise<import('$lib/schema').NodeView | null>;
	loadTreeMeta?(
		name: string,
		version: string,
	): Promise<{ kindCounts: Record<string, number>; roots: TreeNodeDTO[] } | null>;
	/** Direct tree queries — work mid-parse before treeJson is finalized. */
	loadTreeRootsDirect?(name: string, version: string): Promise<TreeNodeDTO[] | null>;
	loadTreeChildrenDirect?(
		name: string,
		version: string,
		parentId: string,
	): Promise<TreeNodeDTO[] | null>;
	loadTreeAncestorsDirect?(
		name: string,
		version: string,
		nodeId: string,
	): Promise<NodeSummary[] | null>;
	/** Build aggregated module map for crate overview visualizations. */
	loadCrateMap(
		name: string,
		version: string,
		options?: CrateMapOptions,
	): Promise<CrateMapData | null>;
	/** Hosted node search without loading full crate graph payloads. */
	searchNodesDirect?(
		name: string,
		version: string,
		query: string,
		limit?: number,
	): Promise<NodeSummary[] | null>;
	getCrossEdgeData(nodeId: string): Promise<CrossEdgeData>;
	getCrateStatus(name: string, version: string): Promise<CrateStatus>;
	triggerParse(
		name: string,
		version: string,
		force?: boolean,
	): Promise<Result<void, ValidationError | NotAvailableError | RateLimitError>>;
	triggerStdInstall(
		name: string,
		version: string,
	): Promise<Result<void, ValidationError | NotAvailableError>>;
	searchRegistry(query: string): Promise<CrateSummaryResult[]>;
	getTopCrates(limit?: number): Promise<CrateSummaryResult[]>;
	getProcessingCrates(limit?: number): Promise<CrateSummaryResult[]>;
	getCrateVersions(name: string, limit?: number): Promise<string[]>;

	/** Resolve version aliases ("latest", channel names) to an actual semver.
	 *  Returns the input unchanged if it's already a concrete version. */
	resolveVersion(name: string, version: string): Promise<string>;

	/**
	 * Trigger parsing if needed and wait for completion (or timeout).
	 * Used by SSR layout load so RPC queries run after data is available.
	 * For small crates, completes fully. For large crates, returns after
	 * timeout with partial data from progressive storage.
	 */
	ensureParsed?(name: string, version: string): Promise<void>;
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
