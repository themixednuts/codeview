import type { Result } from 'better-result';
import type { Edge, Node, NodeKind, Workspace, CrateGraph } from '$lib/graph';
import type {
	CrateIndex,
	CrateTree,
	NodeSummary,
	NodeDetail,
	NodeViewBase,
	TreeNodeDTO,
} from '$lib/schema';
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

export interface ParseQueueEntry {
	kind: 'crate' | 'sysroot';
	name: string;
	version: string;
	status: CrateStatusValue;
	step?: string;
	error?: string;
	requestId?: string;
	workflowId?: string;
	githubRunId?: string;
	githubRunUrl?: string;
	requestedBy?: {
		provider: 'github';
		id: string;
		login: string;
		avatarUrl?: string;
	};
	requestedAt: string;
	updatedAt: string;
	position?: number;
}

export interface PlannedParseItem {
	kind: 'crate' | 'sysroot';
	name: string;
	version: string;
	channel: string;
	priorityTier: string;
	reason: string;
	downloadRank?: number;
	workId: string;
}

export interface PlannedParseRun {
	runId: string;
	generatedAt: string;
	mode: string;
	shardCount: number;
	total: number;
	items: PlannedParseItem[];
}

export interface ActiveParseRun {
	id: string;
	title: string;
	status: string;
	event: string;
	branch?: string;
	url: string;
	createdAt: string;
	updatedAt: string;
}

export interface ParseQueueSnapshot {
	active: ParseQueueEntry[];
	activeRuns: ActiveParseRun[];
	recent: ParseQueueEntry[];
	planned: PlannedParseRun | null;
}

export interface GitHubActionsBillingSummary {
	available: boolean;
	owner: string;
	accountType: 'User' | 'Organization' | 'unknown';
	includedMinutes: number | null;
	totalMinutesUsed: number | null;
	totalPaidMinutesUsed: number | null;
	minutesUsedBreakdown?: Record<string, number>;
	error?: string;
}

export interface ParseQueueAllowance {
	repo: string | null;
	workflowFile: string;
	activeTarget: number;
	batchSize: number;
	trackedActiveCount: number;
	githubActiveRunCount: number;
	actionsInUse: number;
	availableSlots: number;
	repoUsageTargetPercent: number;
	repoPrivate: boolean | null;
	standardRunnerMinutesMetered: boolean | null;
	monthStartedAt: string;
	estimatedRepoMinutesThisMonth: number | null;
	repoBudgetMinutes: number | null;
	repoBudgetUsedPercent: number | null;
	billing: GitHubActionsBillingSummary;
}

export interface AdminDashboardData {
	queue: ParseQueueSnapshot;
	allowance: ParseQueueAllowance;
}

export interface CrossEdgeData {
	edges: Edge[];
	nodes: NodeSummary[];
}

export interface DataProvider {
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
	): Promise<NodeViewBase | null>;
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
		kinds?: NodeKind[],
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
	getParseQueue?(limit?: number): Promise<ParseQueueSnapshot>;
	getAdminDashboard?(limit?: number): Promise<AdminDashboardData>;
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

export interface LocalWorkspaceProvider {
	loadWorkspace(): Promise<Workspace | null>;
}

export function hasLocalWorkspace(provider: DataProvider): provider is DataProvider & LocalWorkspaceProvider {
	return typeof (provider as Partial<LocalWorkspaceProvider>).loadWorkspace === 'function';
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
