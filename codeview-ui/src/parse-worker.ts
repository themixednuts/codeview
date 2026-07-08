import {
	DurableObject,
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
	type WorkflowStepConfig,
	type WorkflowStepContext,
} from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import {
	crateStatusTag,
	isParseRequestMessage,
	makeParseRequest,
	parseStatusObject,
	parseWorkflowId,
	type BeginParseResponse,
	type ParseCompletionPayload,
	type ParseQueueSnapshot,
	type ParseRequestMessage,
	type ParseStatusEvent,
	type ParseWorkflowParams,
	type StoredParseStatus,
} from './lib/server/cloudflare/parse-contract';

type ParseWorkerEnv = Env & {
	CRATE_GRAPHS: R2Bucket;
	PARSE_REQUESTS?: Queue<ParseRequestMessage>;
	PARSE_STATUS: DurableObjectNamespace;
	PARSE_WORKFLOW: Workflow<ParseWorkflowParams>;
	GITHUB_TOKEN?: string;
	GITHUB_REPO?: string;
	GITHUB_REF?: string;
	GITHUB_WORKFLOW_FILE?: string;
	PARSE_CALLBACK_BASE_URL?: string;
	PARSE_CALLBACK_SECRET?: string;
	PARSE_DISPATCH_BURST?: string;
	PARSE_DISPATCH_REFILL_SECONDS?: string;
	DOCSRS_PARSE_BURST?: string;
	DOCSRS_PARSE_REFILL_SECONDS?: string;
	SYSROOT_PARSE_BURST?: string;
	SYSROOT_PARSE_REFILL_SECONDS?: string;
	PLAN_DRAIN_ACTIVE_TARGET?: string;
	PLAN_DRAIN_BATCH_SIZE?: string;
};

type WebSocketAttachment = {
	id: string;
	tags: string[];
};

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const DEFAULT_GITHUB_WORKFLOW_FILE = 'parse.yml';
const GITHUB_API_VERSION = '2026-03-10';
const VERSION_ALIASES = new Set(['latest', 'stable', 'beta', 'nightly']);
const MAX_WS_MESSAGE_CHARS = 4096;
const MAX_WS_TAGS_PER_MESSAGE = 20;
const MAX_WS_TAGS_PER_SOCKET = 100;
const SAFE_CRATE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_VERSION_PATTERN = /^(?:stable|beta|nightly|[0-9A-Za-z][0-9A-Za-z.+_-]{0,127})$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,160}$/;
const ACTIVE_GITHUB_RUN_STATUSES = [
	'queued',
	'pending',
	'in_progress',
	'waiting',
	'requested',
] as const;
const STALE_PROCESSING_RECONCILE_MS = 20 * 60 * 1000;
const ORPHANED_PROCESSING_RECONCILE_MS = 30 * 60 * 1000;
const GITHUB_CALLBACK_WAIT_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const MAX_ORPHANED_PROCESSING_RECONCILE_MS =
	GITHUB_CALLBACK_WAIT_TIMEOUT_MS + 15 * 60 * 1000;
const GITHUB_CALLBACK_WAIT_TIMEOUT = '6 hours';
const WORKFLOW_STATUS_STEP_CONFIG = {
	retries: { limit: 8, delay: '5 seconds', backoff: 'exponential' },
	timeout: '30 seconds',
} satisfies WorkflowStepConfig;
const WORKFLOW_GITHUB_DISPATCH_STEP_CONFIG = {
	retries: { limit: 8, delay: '20 seconds', backoff: 'exponential' },
	timeout: '2 minutes',
} satisfies WorkflowStepConfig;
const WORKFLOW_ARTIFACT_VERIFY_STEP_CONFIG = {
	retries: { limit: 12, delay: '15 seconds', backoff: 'linear' },
	timeout: '45 seconds',
} satisfies WorkflowStepConfig;
const HOSTED_SYSROOT_PARSE_CHANNEL = 'nightly';
const HOSTED_SYSROOT_UNAVAILABLE_MESSAGE =
	'Hosted standard-library parsing currently supports the nightly rustdoc JSON channel.';

type RateBucketConfig = {
	name: string;
	capacity: number;
	refillTokensPerSecond: number;
	cost: number;
};

type RateBucketState = RateBucketConfig & {
	tokens: number;
};

type LeaseResult = { leased: true } | { leased: false; retryAfterSeconds: number };

type WorkPlanArtifact = {
	run_id?: string;
	runId?: string;
	generated_at?: string;
	generatedAt?: string;
	work?: Array<{
		work_id?: string;
		workId?: string;
		kind?: string;
		name?: string;
		version?: string;
	}>;
};

type PlanCandidate = {
	key: string;
	uploaded?: string;
};

type PlannedParseItem = {
	kind: 'crate' | 'sysroot';
	name: string;
	version: string;
};

type GitHubWorkflowRun = {
	id?: number;
	status?: string;
	conclusion?: string | null;
	html_url?: string;
	created_at?: string;
	updated_at?: string;
};

type GitHubWorkflowRunsResponse = {
	workflow_runs?: GitHubWorkflowRun[];
};

type GitHubRepositoryResponse = {
	private?: boolean;
	owner?: {
		login?: string;
		type?: string;
	};
};

type GitHubBillingUsageItem = {
	product?: string;
	sku?: string;
	unitType?: string;
	grossQuantity?: number;
	discountQuantity?: number;
	quantity?: number;
	netQuantity?: number;
	grossAmount?: number;
	discountAmount?: number;
	netAmount?: number;
};

type GitHubBillingUsageSummaryResponse = {
	usageItems?: GitHubBillingUsageItem[];
};

function json(value: unknown, init?: ResponseInit): Response {
	const headers = new Headers(init?.headers);
	headers.set('content-type', JSON_HEADERS['content-type']);
	return new Response(JSON.stringify(value), {
		...init,
		headers,
	});
}

async function readJson<T = unknown>(request: Request): Promise<T> {
	return (await request.json()) as T;
}

function statusRowToObject(row: Record<string, unknown>): StoredParseStatus {
	const action = typeof row.action === 'string' && row.action ? row.action : undefined;
	const kind = row.kind === 'sysroot' ? 'sysroot' : 'crate';
	return {
		ecosystem: 'rust',
		kind,
		name: String(row.name),
		version: String(row.version),
		status: row.status as StoredParseStatus['status'],
		step: typeof row.step === 'string' && row.step ? row.step : undefined,
		error: typeof row.error === 'string' && row.error ? row.error : undefined,
		action: action === 'install_std_docs' || action === 'docs_unavailable' ? action : undefined,
		requestId: typeof row.request_id === 'string' && row.request_id ? row.request_id : undefined,
		workflowId:
			typeof row.workflow_id === 'string' && row.workflow_id ? row.workflow_id : undefined,
		githubRunId:
			typeof row.github_run_id === 'string' && row.github_run_id ? row.github_run_id : undefined,
		githubRunUrl:
			typeof row.github_run_url === 'string' && row.github_run_url ? row.github_run_url : undefined,
		requestedBy:
			typeof row.requested_by_id === 'string' &&
			row.requested_by_id &&
			typeof row.requested_by_login === 'string' &&
			row.requested_by_login
				? {
						provider: 'github',
						id: row.requested_by_id,
						login: row.requested_by_login,
						avatarUrl:
							typeof row.requested_by_avatar_url === 'string' && row.requested_by_avatar_url
								? row.requested_by_avatar_url
								: undefined,
					}
				: undefined,
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
		sequence: Number(row.sequence ?? 0),
	};
}

function databaseNow(): string {
	return new Date().toISOString();
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function logWorkflowRetry(
	ctx: WorkflowStepContext,
	params: ParseWorkflowParams,
	detail?: string,
): void {
	if (ctx.attempt <= 1) return;
	console.warn(
		`parse workflow retry step=${ctx.step.name} attempt=${ctx.attempt} ${params.name}@${params.version}${detail ? ` ${detail}` : ''}`,
	);
}

function workflowOutputOk(output: unknown): boolean | null {
	return output &&
		typeof output === 'object' &&
		'ok' in output &&
		typeof (output as { ok?: unknown }).ok === 'boolean'
		? (output as { ok: boolean }).ok
		: null;
}

function normalizeCrateName(name: string): string {
	return name.replace(/-/g, '_');
}

function hyphenateCrateName(name: string): string {
	return name.replace(/_/g, '-');
}

function crateNameVariants(name: string): string[] {
	return [...new Set([name, hyphenateCrateName(name), normalizeCrateName(name)])];
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value ?? '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function finiteNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function githubNetUsageQuantity(item: GitHubBillingUsageItem): number {
	return finiteNumber(item.netQuantity) ?? 0;
}

function isActionsMinuteUsage(item: GitHubBillingUsageItem): boolean {
	const product = (item.product ?? '').toLowerCase();
	const sku = (item.sku ?? '').toLowerCase();
	const unitType = (item.unitType ?? '').toLowerCase();
	return (product.includes('actions') || sku.includes('actions')) && unitType.includes('minute');
}

function totalBillableActionsMinutes(body: GitHubBillingUsageSummaryResponse): number {
	return (body.usageItems ?? [])
		.filter(isActionsMinuteUsage)
		.reduce((total, item) => total + githubNetUsageQuantity(item), 0);
}

function monthStartIso(now = new Date()): string {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function workflowRunDurationMinutes(run: GitHubWorkflowRun, nowMs: number): number {
	const start = run.created_at ? Date.parse(run.created_at) : NaN;
	if (!Number.isFinite(start)) return 0;
	const isActive = run.status
		? (ACTIVE_GITHUB_RUN_STATUSES as readonly string[]).includes(run.status)
		: false;
	const updated = run.updated_at ? Date.parse(run.updated_at) : NaN;
	const end = isActive ? nowMs : Number.isFinite(updated) ? updated : nowMs;
	return Math.max(0, (end - start) / 60_000);
}

function isSafeCrateName(value: string): boolean {
	return SAFE_CRATE_NAME_PATTERN.test(value);
}

function isSafeVersion(value: string): boolean {
	return SAFE_VERSION_PATTERN.test(value);
}

function isSafeId(value: string): boolean {
	return SAFE_ID_PATTERN.test(value);
}

function isValidSubscriptionTag(tag: string): boolean {
	if (tag === 'processing:rust') return true;
	const parts = tag.split(':');
	return (
		parts.length === 3 &&
		parts[0] === 'rust' &&
		isSafeCrateName(parts[1]) &&
		isSafeVersion(parts[2])
	);
}

function normalizeSubscriptionTags(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [
		...new Set(
			value
				.filter((tag): tag is string => typeof tag === 'string')
				.filter(isValidSubscriptionTag)
				.slice(0, MAX_WS_TAGS_PER_MESSAGE),
		),
	];
}

function constantTimeEqual(a: string, b: string): boolean {
	const encoder = new TextEncoder();
	const left = encoder.encode(a);
	const right = encoder.encode(b);
	let diff = left.length ^ right.length;
	const length = Math.max(left.length, right.length);
	for (let i = 0; i < length; i += 1) {
		diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
	}
	return diff === 0;
}

function callbackSecretsFromRequest(request: Request): string[] {
	const auth = request.headers.get('authorization') ?? '';
	const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
	const headerSecret = request.headers.get('x-codeview-callback-secret') ?? '';
	return [bearer, headerSecret].filter((value) => value.length > 0);
}

function parseCompletionPayload(value: unknown): ParseCompletionPayload | null {
	if (typeof value !== 'object' || value === null) return null;
	const raw = value as Record<string, unknown>;
	if (
		raw.schemaVersion !== 1 ||
		typeof raw.workflowId !== 'string' ||
		!isSafeId(raw.workflowId) ||
		typeof raw.requestId !== 'string' ||
		!isSafeId(raw.requestId) ||
		typeof raw.name !== 'string' ||
		!isSafeCrateName(raw.name) ||
		typeof raw.version !== 'string' ||
		!isSafeVersion(raw.version) ||
		typeof raw.ok !== 'boolean' ||
		typeof raw.completedAt !== 'string'
	) {
		return null;
	}
	const kind = raw.kind === 'sysroot' || raw.kind === 'crate' ? raw.kind : undefined;
	const runId = typeof raw.runId === 'string' && isSafeId(raw.runId) ? raw.runId : undefined;
	const runUrl = typeof raw.runUrl === 'string' ? raw.runUrl : undefined;
	const error = typeof raw.error === 'string' ? raw.error.slice(0, 4000) : undefined;
	return {
		schemaVersion: 1,
		kind,
		workflowId: raw.workflowId,
		requestId: raw.requestId,
		name: raw.name,
		version: raw.version,
		ok: raw.ok,
		runId,
		runUrl,
		error,
		completedAt: raw.completedAt,
	};
}

function schedulerBuckets(env: ParseWorkerEnv, message: ParseRequestMessage): RateBucketConfig[] {
	const dispatchBurst = parsePositiveNumber(env.PARSE_DISPATCH_BURST, 2);
	const dispatchRefillSeconds = parsePositiveNumber(env.PARSE_DISPATCH_REFILL_SECONDS, 45);
	const buckets: RateBucketConfig[] = [
		{
			name: 'github-dispatch',
			capacity: dispatchBurst,
			refillTokensPerSecond: 1 / dispatchRefillSeconds,
			cost: 1,
		},
	];

	if (message.kind === 'sysroot') {
		const sysrootBurst = parsePositiveNumber(env.SYSROOT_PARSE_BURST, 1);
		const sysrootRefillSeconds = parsePositiveNumber(env.SYSROOT_PARSE_REFILL_SECONDS, 600);
		buckets.push({
			name: 'sysroot',
			capacity: sysrootBurst,
			refillTokensPerSecond: 1 / sysrootRefillSeconds,
			cost: 1,
		});
	} else {
		const docsrsBurst = parsePositiveNumber(env.DOCSRS_PARSE_BURST, 4);
		const docsrsRefillSeconds = parsePositiveNumber(env.DOCSRS_PARSE_REFILL_SECONDS, 20);
		buckets.push({
			name: 'docsrs',
			capacity: docsrsBurst,
			refillTokensPerSecond: 1 / docsrsRefillSeconds,
			cost: 1,
		});
	}

	return buckets;
}

function githubApiHeaders(env: ParseWorkerEnv): HeadersInit {
	if (!env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is not configured');
	return {
		accept: 'application/vnd.github+json',
		authorization: `Bearer ${env.GITHUB_TOKEN}`,
		'content-type': 'application/json',
		'user-agent': 'codeview-parse-worker',
		'x-github-api-version': GITHUB_API_VERSION,
	};
}

function githubDispatchBody(env: ParseWorkerEnv, params: ParseWorkflowParams, workflowId: string) {
	const callbackBase = env.PARSE_CALLBACK_BASE_URL ?? params.callbackBaseUrl;
	return {
		ref: env.GITHUB_REF ?? 'main',
		inputs: {
			crate: params.name,
			version: params.version,
			request_kind: params.kind,
			toolchain: params.kind === 'sysroot' ? HOSTED_SYSROOT_PARSE_CHANNEL : '',
			parse_force: params.force ? 'true' : 'false',
			workflow_id: workflowId,
			request_id: params.requestId,
			callback_url: callbackBase ? `${callbackBase.replace(/\/$/, '')}/api/parse/callback` : '',
		},
	};
}

async function dispatchGitHubParse(
	env: ParseWorkerEnv,
	params: ParseWorkflowParams,
	workflowId: string,
) {
	const repo = env.GITHUB_REPO;
	if (!repo) throw new Error('GITHUB_REPO is not configured');
	const workflowFile = env.GITHUB_WORKFLOW_FILE ?? DEFAULT_GITHUB_WORKFLOW_FILE;
	const url = `https://api.github.com/repos/${repo}/actions/workflows/${workflowFile}/dispatches`;
	const response = await fetch(url, {
		method: 'POST',
		headers: githubApiHeaders(env),
		body: JSON.stringify(githubDispatchBody(env, params, workflowId)),
	});
	if (!response.ok) {
		const body = await response.text().catch(() => '');
		throw new Error(`GitHub dispatch failed: ${response.status} ${response.statusText} ${body}`);
	}
	return { dispatchedAt: databaseNow(), workflowFile };
}

async function updateStatus(
	env: ParseWorkerEnv,
	event: ParseStatusEvent,
): Promise<StoredParseStatus> {
	const response = await parseStatusObject(env.PARSE_STATUS).fetch('https://status/event', {
		method: 'POST',
		headers: JSON_HEADERS,
		body: JSON.stringify(event),
	});
	if (!response.ok) throw new Error(`status update failed: ${response.status}`);
	return (await response.json()) as StoredParseStatus;
}

async function readStatus(
	env: ParseWorkerEnv,
	name: string,
	version: string,
): Promise<StoredParseStatus | null> {
	const url = new URL('https://status/status');
	url.searchParams.set('name', name);
	url.searchParams.set('version', version);
	const response = await parseStatusObject(env.PARSE_STATUS).fetch(url);
	if (!response.ok) return null;
	return (await response.json()) as StoredParseStatus | null;
}

async function readProcessingCount(env: ParseWorkerEnv): Promise<number> {
	const url = new URL('https://status/queue');
	url.searchParams.set('limit', '100');
	const response = await parseStatusObject(env.PARSE_STATUS).fetch(url);
	if (!response.ok) return 0;
	const snapshot = (await response.json()) as ParseQueueSnapshot;
	return snapshot.active.length;
}

function githubReadHeaders(env: ParseWorkerEnv): HeadersInit {
	const headers: Record<string, string> = {
		accept: 'application/vnd.github+json',
		'user-agent': 'codeview-parse-worker',
		'x-github-api-version': GITHUB_API_VERSION,
	};
	if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
	return headers;
}

async function countActiveGitHubParseRuns(env: ParseWorkerEnv): Promise<number> {
	const repo = env.GITHUB_REPO;
	if (!repo) return 0;
	const workflowFile = env.GITHUB_WORKFLOW_FILE ?? DEFAULT_GITHUB_WORKFLOW_FILE;
	const ids = new Set<number>();
	const failedStatuses: string[] = [];
	await Promise.all(
		ACTIVE_GITHUB_RUN_STATUSES.map(async (status) => {
			const url = new URL(
				`https://api.github.com/repos/${repo}/actions/workflows/${workflowFile}/runs`,
			);
			url.searchParams.set('status', status);
			url.searchParams.set('per_page', '20');
			const response = await fetch(url, { headers: githubReadHeaders(env) });
			if (!response.ok) {
				console.warn(
					`active GitHub parse run count failed status=${status} code=${response.status}`,
				);
				failedStatuses.push(`${status}:${response.status}`);
				return;
			}
			const body = (await response.json()) as GitHubWorkflowRunsResponse;
			for (const run of body.workflow_runs ?? []) {
				if (typeof run.id === 'number') ids.add(run.id);
			}
		}),
	);
	if (failedStatuses.length) {
		throw new Error(`active GitHub parse run count incomplete: ${failedStatuses.join(', ')}`);
	}
	return ids.size;
}

function isGitHubRunActive(run: GitHubWorkflowRun | null | undefined): boolean {
	return ACTIVE_GITHUB_RUN_STATUSES.includes(
		run?.status as (typeof ACTIVE_GITHUB_RUN_STATUSES)[number],
	);
}

async function loadGitHubWorkflowRun(
	env: ParseWorkerEnv,
	runId: string,
): Promise<GitHubWorkflowRun | null> {
	const repo = env.GITHUB_REPO;
	if (!repo || !SAFE_ID_PATTERN.test(runId)) return null;
	const response = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${runId}`, {
		headers: githubReadHeaders(env),
	});
	if (response.status === 404 || response.status === 410) return null;
	if (!response.ok) throw new Error(`GitHub run ${runId} lookup failed: ${response.status}`);
	return (await response.json()) as GitHubWorkflowRun;
}

async function loadGitHubRepository(env: ParseWorkerEnv): Promise<GitHubRepositoryResponse | null> {
	const repo = env.GITHUB_REPO;
	if (!repo) return null;
	const response = await fetch(`https://api.github.com/repos/${repo}`, {
		headers: githubReadHeaders(env),
	});
	if (!response.ok) return null;
	return (await response.json()) as GitHubRepositoryResponse;
}

async function loadGitHubRepoBillableActionsMinutes(
	env: ParseWorkerEnv,
	repository: GitHubRepositoryResponse,
): Promise<number | null> {
	const owner = repository.owner?.login ?? env.GITHUB_REPO?.split('/')[0];
	if (!owner || !env.GITHUB_TOKEN) return null;
	const ownerType = repository.owner?.type;
	const path =
		ownerType === 'Organization'
			? `/organizations/${owner}/settings/billing/usage/summary`
			: `/users/${owner}/settings/billing/usage/summary`;
	const url = new URL(`https://api.github.com${path}`);
	url.searchParams.set('product', 'Actions');
	if (env.GITHUB_REPO) url.searchParams.set('repository', env.GITHUB_REPO);
	const response = await fetch(url, {
		headers: githubReadHeaders(env),
	});
	if (!response.ok) return null;
	const body = (await response.json()) as GitHubBillingUsageSummaryResponse;
	return totalBillableActionsMinutes(body);
}

async function estimateParseWorkflowMinutesThisMonth(env: ParseWorkerEnv): Promise<number | null> {
	const repo = env.GITHUB_REPO;
	if (!repo) return null;
	const workflowFile = env.GITHUB_WORKFLOW_FILE ?? DEFAULT_GITHUB_WORKFLOW_FILE;
	const startedAt = monthStartIso();
	const nowMs = Date.now();
	let total = 0;
	let loaded = 0;
	for (let page = 1; page <= 5; page += 1) {
		const url = new URL(
			`https://api.github.com/repos/${repo}/actions/workflows/${workflowFile}/runs`,
		);
		url.searchParams.set('created', `>=${startedAt}`);
		url.searchParams.set('per_page', '100');
		url.searchParams.set('page', String(page));
		const response = await fetch(url, { headers: githubReadHeaders(env) });
		if (!response.ok) return null;
		const body = (await response.json()) as GitHubWorkflowRunsResponse;
		const runs = body.workflow_runs ?? [];
		loaded += runs.length;
		for (const run of runs) total += workflowRunDurationMinutes(run, nowMs);
		if (runs.length < 100) break;
	}
	return loaded > 0 ? total : 0;
}

async function plannedDrainBudgetAllowance(env: ParseWorkerEnv): Promise<{
	allowed: boolean;
	reason?: string;
	estimatedRepoMinutesThisMonth?: number;
}> {
	const repository = await loadGitHubRepository(env).catch(() => null);
	if (repository?.private !== true) return { allowed: true };

	const repoActionsUsageMinutes = await loadGitHubRepoBillableActionsMinutes(env, repository).catch(
		() => null,
	);
	const estimatedRepoMinutesThisMonth =
		repoActionsUsageMinutes ?? (await estimateParseWorkflowMinutesThisMonth(env).catch(() => null));
	return estimatedRepoMinutesThisMonth === null
		? {
				allowed: true,
				reason: 'budget-unavailable',
			}
		: {
				allowed: true,
				reason: 'budget-unavailable',
				estimatedRepoMinutesThisMonth,
			};
}

async function readDrainPressure(env: ParseWorkerEnv): Promise<{
	statusActive: number;
	githubActive: number;
	actionsInUse: number;
	capacityReliable: boolean;
	capacityReason?: string;
}> {
	const [statusActive, githubActiveResult] = await Promise.all([
		readProcessingCount(env),
		countActiveGitHubParseRuns(env)
			.then((count) => ({ ok: true as const, count }))
			.catch((err) => ({ ok: false as const, error: errorMessage(err) })),
	]);
	if (!githubActiveResult.ok) {
		console.warn(`planned parse drain paused: ${githubActiveResult.error}`);
		return {
			statusActive,
			githubActive: statusActive,
			actionsInUse: statusActive,
			capacityReliable: false,
			capacityReason: 'github-active-unavailable',
		};
	}
	const githubActive = githubActiveResult.count;
	return {
		statusActive,
		githubActive,
		actionsInUse: Math.max(statusActive, githubActive),
		capacityReliable: true,
	};
}

async function listPlanKeys(env: ParseWorkerEnv, maxKeys = 2000): Promise<PlanCandidate[]> {
	const candidates: PlanCandidate[] = [];
	let cursor: string | undefined;
	do {
		const page = await env.CRATE_GRAPHS.list({
			prefix: 'rust/_runs/',
			limit: Math.min(1000, Math.max(1, maxKeys - candidates.length)),
			cursor,
		});
		for (const object of page.objects) {
			if (object.key.endsWith('/plan.json')) {
				candidates.push({
					key: object.key,
					uploaded: object.uploaded?.toISOString(),
				});
			}
			if (candidates.length >= maxKeys) break;
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor && candidates.length < maxKeys);
	return candidates.sort(
		(a, b) => (b.uploaded ?? '').localeCompare(a.uploaded ?? '') || b.key.localeCompare(a.key),
	);
}

async function readPlan(env: ParseWorkerEnv, key: string): Promise<WorkPlanArtifact | null> {
	const object = await env.CRATE_GRAPHS.get(key);
	if (!object) return null;
	return (await object.json()) as WorkPlanArtifact;
}

function generatedAt(plan: WorkPlanArtifact): string {
	return plan.generated_at ?? plan.generatedAt ?? '';
}

async function loadLatestPlan(env: ParseWorkerEnv): Promise<WorkPlanArtifact | null> {
	const plans = await Promise.all(
		(await listPlanKeys(env)).slice(0, 25).map(async ({ key }) => readPlan(env, key)),
	);
	return (
		plans
			.filter((plan): plan is WorkPlanArtifact => plan !== null)
			.sort((a, b) => generatedAt(b).localeCompare(generatedAt(a)))[0] ?? null
	);
}

function statusIsNewerThanPlan(status: StoredParseStatus, plan: WorkPlanArtifact | null): boolean {
	const generatedAtMs = plan ? Date.parse(generatedAt(plan)) : NaN;
	const updatedAtMs = Date.parse(status.updatedAt);
	return Number.isFinite(generatedAtMs) && Number.isFinite(updatedAtMs)
		? updatedAtMs >= generatedAtMs
		: true;
}

function plannedParseItem(
	value: NonNullable<WorkPlanArtifact['work']>[number],
): PlannedParseItem | null {
	const name = value.name ?? '';
	const version = value.version ?? '';
	if (!isSafeCrateName(name) || !isSafeVersion(version)) return null;
	if (value.kind === 'std' || value.kind === 'sysroot') {
		if (version !== HOSTED_SYSROOT_PARSE_CHANNEL) return null;
		return { kind: 'sysroot', name, version };
	}
	if (value.kind === 'crate') return { kind: 'crate', name, version };
	return null;
}

async function enqueuePlannedItem(env: ParseWorkerEnv, item: PlannedParseItem): Promise<void> {
	const request = makeParseRequest(item.name, item.version, true, 'planned', item.kind);
	const workflowId = parseWorkflowId(request.requestId);
	await updateStatus(env, {
		kind: request.kind,
		name: request.name,
		version: request.version,
		status: 'processing',
		step: 'queued',
		requestId: request.requestId,
		workflowId,
	});
	try {
		await env.PARSE_REQUESTS!.send(request);
	} catch (err) {
		await updateStatus(env, {
			kind: request.kind,
			name: request.name,
			version: request.version,
			status: 'failed',
			step: 'queue-send',
			error: err instanceof Error ? err.message : String(err),
			requestId: request.requestId,
			workflowId,
		});
		throw err;
	}
}

async function drainPlannedParses(env: ParseWorkerEnv): Promise<{
	queued: number;
	skipped: number;
	statusActive: number;
	githubActive: number;
	actionsInUse: number;
	activeTarget: number;
	availableSlots: number;
	budgetLimited: boolean;
	budgetReason?: string;
}> {
	const activeTarget = parsePositiveInteger(env.PLAN_DRAIN_ACTIVE_TARGET, 4);
	const empty = {
		queued: 0,
		skipped: 0,
		statusActive: 0,
		githubActive: 0,
		actionsInUse: 0,
		activeTarget,
		availableSlots: 0,
		budgetLimited: false,
	};
	if (!env.PARSE_REQUESTS) return empty;
	const batchSize = parsePositiveInteger(env.PLAN_DRAIN_BATCH_SIZE, 2);
	const pressure = await readDrainPressure(env);
	if (!pressure.capacityReliable) {
		return {
			...pressure,
			activeTarget,
			availableSlots: 0,
			budgetLimited: true,
			budgetReason: pressure.capacityReason,
			queued: 0,
			skipped: 0,
		};
	}
	const availableSlots = Math.max(0, activeTarget - pressure.actionsInUse);
	let remaining = Math.max(0, Math.min(batchSize, availableSlots));
	if (remaining === 0) {
		return {
			...pressure,
			activeTarget,
			availableSlots,
			budgetLimited: false,
			queued: 0,
			skipped: 0,
		};
	}
	const budget = await plannedDrainBudgetAllowance(env);
	if (!budget.allowed) {
		return {
			...pressure,
			activeTarget,
			availableSlots,
			budgetLimited: true,
			budgetReason: budget.reason,
			queued: 0,
			skipped: 0,
		};
	}

	const plan = await loadLatestPlan(env);
	const work = Array.isArray(plan?.work) ? plan.work : [];
	let queued = 0;
	let skipped = 0;
	for (const raw of work) {
		if (remaining === 0) break;
		const item = plannedParseItem(raw);
		if (!item) {
			skipped += 1;
			continue;
		}
		const status = await readStatus(env, item.name, item.version);
		if (status?.status === 'processing' || (status && statusIsNewerThanPlan(status, plan))) {
			skipped += 1;
			continue;
		}
		await enqueuePlannedItem(env, item);
		queued += 1;
		remaining -= 1;
	}
	return { ...pressure, activeTarget, availableSlots, budgetLimited: false, queued, skipped };
}

type CrateRefs = {
	storageName?: string;
	aliases?: Record<string, { version?: string; graphHash?: string } | undefined>;
	versions?: Array<{ version?: string; graphHash?: string }>;
};

async function readCrateRefs(env: ParseWorkerEnv, name: string): Promise<CrateRefs> {
	const tried: string[] = [];
	for (const variant of crateNameVariants(name)) {
		const key = `rust/_refs/${variant}.json`;
		tried.push(key);
		const refs = await env.CRATE_GRAPHS.get(key);
		if (refs) return (await refs.json()) as CrateRefs;
	}
	throw new Error(`missing R2 refs for ${name} (tried ${tried.join(', ')})`);
}

async function verifyArtifacts(env: ParseWorkerEnv, name: string, version: string): Promise<void> {
	const parsed = await readCrateRefs(env, name);
	const target = VERSION_ALIASES.has(version)
		? parsed.aliases?.[version]
		: parsed.versions?.find((entry) => entry.version === version);
	if (!target?.version || !target.graphHash)
		throw new Error(`R2 refs do not include ${name}@${version}`);
	const storageName = parsed.storageName || hyphenateCrateName(name);
	const meta = await env.CRATE_GRAPHS.get(`rust/${storageName}/${target.version}/site/meta.json`);
	if (!meta) throw new Error(`missing hosted metadata for ${name}@${version}`);
}

async function reconcileFinalizingParses(
	env: ParseWorkerEnv,
): Promise<{ ready: number; failed: number }> {
	const url = new URL('https://status/queue');
	url.searchParams.set('limit', '100');
	const response = await parseStatusObject(env.PARSE_STATUS).fetch(url);
	if (!response.ok) return { ready: 0, failed: 0 };
	const snapshot = (await response.json()) as ParseQueueSnapshot;
	let ready = 0;
	let failed = 0;
	for (const status of snapshot.active) {
		if (status.step !== 'finalizing') continue;
		try {
			await verifyArtifacts(env, status.name, status.version);
			await updateStatus(env, {
				kind: status.kind,
				name: status.name,
				version: status.version,
				status: 'ready',
				requestId: status.requestId,
				workflowId: status.workflowId,
				githubRunId: status.githubRunId,
				githubRunUrl: status.githubRunUrl,
			});
			ready += 1;
		} catch (err) {
			const updatedAtMs = Date.parse(status.updatedAt);
			const ageMs = Number.isFinite(updatedAtMs) ? Date.now() - updatedAtMs : 0;
			if (ageMs < 15 * 60 * 1000) continue;
			await updateStatus(env, {
				kind: status.kind,
				name: status.name,
				version: status.version,
				status: 'failed',
				step: 'artifact-verify',
				error: errorMessage(err),
				requestId: status.requestId,
				workflowId: status.workflowId,
				githubRunId: status.githubRunId,
				githubRunUrl: status.githubRunUrl,
			});
			failed += 1;
		}
	}
	return { ready, failed };
}

async function markReadyIfArtifactsExist(
	env: ParseWorkerEnv,
	status: StoredParseStatus,
): Promise<boolean> {
	try {
		await verifyArtifacts(env, status.name, status.version);
		await updateStatus(env, {
			kind: status.kind,
			name: status.name,
			version: status.version,
			status: 'ready',
			requestId: status.requestId,
			workflowId: status.workflowId,
			githubRunId: status.githubRunId,
			githubRunUrl: status.githubRunUrl,
		});
		return true;
	} catch {
		return false;
	}
}

async function failStaleProcessing(
	env: ParseWorkerEnv,
	status: StoredParseStatus,
	step: string,
	error: string,
): Promise<void> {
	await updateStatus(env, {
		kind: status.kind,
		name: status.name,
		version: status.version,
		status: 'failed',
		step,
		error,
		requestId: status.requestId,
		workflowId: status.workflowId,
		githubRunId: status.githubRunId,
		githubRunUrl: status.githubRunUrl,
	});
}

async function reconcileStaleProcessingParses(env: ParseWorkerEnv): Promise<{
	ready: number;
	failed: number;
	kept: number;
}> {
	const url = new URL('https://status/queue');
	url.searchParams.set('limit', '100');
	const response = await parseStatusObject(env.PARSE_STATUS).fetch(url);
	if (!response.ok) return { ready: 0, failed: 0, kept: 0 };
	const snapshot = (await response.json()) as ParseQueueSnapshot;
	const githubActive = await countActiveGitHubParseRuns(env).catch((err) => {
		console.warn(`stale parse reconciliation cannot read active GitHub runs: ${errorMessage(err)}`);
		return null;
	});
	const now = Date.now();
	let ready = 0;
	let failed = 0;
	let kept = 0;

	for (const status of snapshot.active) {
		if (status.step === 'finalizing') continue;
		const updatedAtMs = Date.parse(status.updatedAt);
		const ageMs = Number.isFinite(updatedAtMs) ? now - updatedAtMs : 0;
		if (ageMs < STALE_PROCESSING_RECONCILE_MS) {
			kept += 1;
			continue;
		}

		if (await markReadyIfArtifactsExist(env, status)) {
			ready += 1;
			continue;
		}

		if (status.githubRunId) {
			let runLookupFailed = false;
			const run = await loadGitHubWorkflowRun(env, status.githubRunId).catch((err) => {
				runLookupFailed = true;
				console.warn(
					`stale parse run lookup failed ${status.name}@${status.version} run=${status.githubRunId}: ${errorMessage(err)}`,
				);
				return undefined;
			});
			if (runLookupFailed && ageMs < MAX_ORPHANED_PROCESSING_RECONCILE_MS) {
				kept += 1;
				continue;
			}
			if (runLookupFailed) {
				await failStaleProcessing(
					env,
					status,
					'github-reconcile',
					`GitHub parse workflow run lookup did not recover after ${Math.round(ageMs / 60_000)} minutes`,
				);
				failed += 1;
				continue;
			}
			if (isGitHubRunActive(run)) {
				kept += 1;
				continue;
			}
			const conclusion =
				run?.status === 'completed'
					? (run.conclusion ?? 'completed without conclusion')
					: (run?.status ?? 'missing');
			await failStaleProcessing(
				env,
				status,
				'github-reconcile',
				`GitHub parse workflow ${conclusion} before callback`,
			);
			failed += 1;
			continue;
		}

		const shouldKeepOrphan =
			ageMs < ORPHANED_PROCESSING_RECONCILE_MS ||
			(githubActive !== 0 && ageMs < MAX_ORPHANED_PROCESSING_RECONCILE_MS);
		if (shouldKeepOrphan) {
			kept += 1;
			continue;
		}

		await failStaleProcessing(
			env,
			status,
			'github-reconcile',
			`Parse request had no GitHub run id or callback after ${Math.round(ageMs / 60_000)} minutes`,
		);
		failed += 1;
	}

	return { ready, failed, kept };
}

export class ParseStatusDurableObject extends DurableObject<ParseWorkerEnv> {
	constructor(ctx: DurableObjectState, env: ParseWorkerEnv) {
		super(ctx, env);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS statuses (
				ecosystem TEXT NOT NULL,
				kind TEXT NOT NULL DEFAULT 'crate',
				name TEXT NOT NULL,
				version TEXT NOT NULL,
				status TEXT NOT NULL,
				step TEXT,
				error TEXT,
				action TEXT,
				request_id TEXT,
				workflow_id TEXT,
				github_run_id TEXT,
				github_run_url TEXT,
				requested_by_provider TEXT,
				requested_by_id TEXT,
				requested_by_login TEXT,
				requested_by_avatar_url TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				sequence INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (ecosystem, name, version)
			);
		`);
		this.trySql(`ALTER TABLE statuses ADD COLUMN kind TEXT NOT NULL DEFAULT 'crate'`);
		this.trySql(`ALTER TABLE statuses ADD COLUMN requested_by_provider TEXT`);
		this.trySql(`ALTER TABLE statuses ADD COLUMN requested_by_id TEXT`);
		this.trySql(`ALTER TABLE statuses ADD COLUMN requested_by_login TEXT`);
		this.trySql(`ALTER TABLE statuses ADD COLUMN requested_by_avatar_url TEXT`);
		this.ctx.storage.sql.exec(`
			CREATE INDEX IF NOT EXISTS statuses_processing_idx
			ON statuses (ecosystem, status, updated_at DESC);
		`);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS rate_buckets (
				name TEXT PRIMARY KEY,
				tokens REAL NOT NULL,
				updated_at_ms INTEGER NOT NULL
			);
		`);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/ws' || url.pathname === '/api/events/ws') {
			return this.handleWebSocket(request);
		}
		if (url.pathname === '/begin' && request.method === 'POST') {
			return json(await this.beginParse(await readJson<ParseRequestMessage>(request)));
		}
		if (url.pathname === '/event' && request.method === 'POST') {
			return json(await this.recordEvent(await readJson<ParseStatusEvent>(request)));
		}
		if (url.pathname === '/status' && request.method === 'GET') {
			const name = url.searchParams.get('name') ?? '';
			const version = url.searchParams.get('version') ?? '';
			return json(this.getStatus(name, version));
		}
		if (url.pathname === '/processing' && request.method === 'GET') {
			const limit = Number(url.searchParams.get('limit') ?? '20');
			return json(this.processing(Number.isFinite(limit) ? limit : 20));
		}
		if (url.pathname === '/queue' && request.method === 'GET') {
			const limit = Number(url.searchParams.get('limit') ?? '50');
			return json(this.queueSnapshot(Number.isFinite(limit) ? limit : 50));
		}
		return new Response('Not found', { status: 404 });
	}

	webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void | Promise<void> {
		const raw = typeof message === 'string' ? message : new TextDecoder().decode(message);
		if (raw.length > MAX_WS_MESSAGE_CHARS) {
			ws.close(1009, 'Message too large');
			return;
		}
		let parsed: { action?: string; tags?: string[] };
		try {
			parsed = JSON.parse(raw) as { action?: string; tags?: string[] };
		} catch {
			return;
		}
		if (parsed.action === 'ping') {
			ws.send(JSON.stringify({ type: 'pong' }));
			return;
		}

		const attachment = this.attachmentFor(ws);
		const requestedTags = normalizeSubscriptionTags(parsed.tags);
		if (parsed.action === 'subscribe' && requestedTags.length) {
			const tags = new Set(attachment.tags);
			for (const tag of requestedTags) {
				if (tags.size >= MAX_WS_TAGS_PER_SOCKET) break;
				tags.add(tag);
			}
			this.setAttachment(ws, { ...attachment, tags: [...tags] });
			for (const tag of requestedTags) this.sendInitial(ws, tag);
			return;
		}
		if (parsed.action === 'unsubscribe' && requestedTags.length) {
			const remove = new Set(requestedTags);
			this.setAttachment(ws, {
				...attachment,
				tags: attachment.tags.filter((tag) => !remove.has(tag)),
			});
		}
	}

	private handleWebSocket(request: Request): Response {
		if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
			return new Response('Expected WebSocket upgrade', { status: 426 });
		}
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		const id = crypto.randomUUID();
		this.ctx.acceptWebSocket(server);
		this.setAttachment(server, { id, tags: [] });
		server.send(JSON.stringify({ type: 'connected', connectionId: id }));
		return new Response(null, { status: 101, webSocket: client });
	}

	private attachmentFor(ws: WebSocket): WebSocketAttachment {
		const attachment = ws.deserializeAttachment() as Partial<WebSocketAttachment> | null;
		return {
			id: typeof attachment?.id === 'string' ? attachment.id : crypto.randomUUID(),
			tags: Array.isArray(attachment?.tags)
				? attachment.tags.filter((tag): tag is string => typeof tag === 'string')
				: [],
		};
	}

	private setAttachment(ws: WebSocket, attachment: WebSocketAttachment): void {
		ws.serializeAttachment(attachment);
	}

	private sendInitial(ws: WebSocket, tag: string): void {
		if (!isValidSubscriptionTag(tag)) return;
		if (tag.startsWith('rust:')) {
			const [, name, version] = tag.split(':');
			if (!name || !version) return;
			const status = this.getStatus(name, version);
			if (status) ws.send(JSON.stringify({ tag, data: status }));
			return;
		}
		if (tag === 'processing:rust') {
			ws.send(
				JSON.stringify({
					tag,
					data: { type: 'processing', count: this.processing(100).length },
				}),
			);
		}
	}

	private broadcast(tag: string, data: unknown): void {
		for (const ws of this.ctx.getWebSockets()) {
			const attachment = this.attachmentFor(ws);
			if (attachment.tags.includes(tag)) {
				ws.send(JSON.stringify({ tag, data }));
			}
		}
	}

	private trySql(sql: string): void {
		try {
			this.ctx.storage.sql.exec(sql);
		} catch {
			// Existing Durable Objects may already have the column.
		}
	}

	private getStatus(name: string, version: string): StoredParseStatus | null {
		const row = this.ctx.storage.sql
			.exec(
				`SELECT * FROM statuses WHERE ecosystem = ? AND name = ? AND version = ? LIMIT 1`,
				'rust',
				name,
				version,
			)
			.toArray()[0] as Record<string, unknown> | undefined;
		return row ? statusRowToObject(row) : null;
	}

	private processing(limit: number): StoredParseStatus[] {
		return this.ctx.storage.sql
			.exec(
				`SELECT * FROM statuses
			 WHERE ecosystem = ? AND status = ?
			 ORDER BY updated_at DESC
			 LIMIT ?`,
				'rust',
				'processing',
				Math.max(1, Math.min(limit, 100)),
			)
			.toArray()
			.map((row) => statusRowToObject(row as Record<string, unknown>));
	}

	private recent(limit: number): StoredParseStatus[] {
		return this.ctx.storage.sql
			.exec(
				`SELECT * FROM statuses
			 WHERE ecosystem = ? AND status != ?
			 ORDER BY updated_at DESC
			 LIMIT ?`,
				'rust',
				'processing',
				Math.max(1, Math.min(limit, 100)),
			)
			.toArray()
			.map((row) => statusRowToObject(row as Record<string, unknown>));
	}

	private queueSnapshot(limit: number): ParseQueueSnapshot {
		return {
			active: this.processing(limit),
			recent: this.recent(limit),
		};
	}

	private readBucket(config: RateBucketConfig, nowMs: number): RateBucketState {
		const row = this.ctx.storage.sql
			.exec(`SELECT * FROM rate_buckets WHERE name = ? LIMIT 1`, config.name)
			.toArray()[0] as Record<string, unknown> | undefined;
		if (!row) return { ...config, tokens: config.capacity };

		const previousTokens = Number(row.tokens);
		const previousUpdatedAt = Number(row.updated_at_ms);
		const elapsedSeconds = Math.max(0, nowMs - previousUpdatedAt) / 1000;
		const tokens = Math.min(
			config.capacity,
			(Number.isFinite(previousTokens) ? previousTokens : config.capacity) +
				elapsedSeconds * config.refillTokensPerSecond,
		);
		return { ...config, tokens };
	}

	private writeBucket(state: RateBucketState, nowMs: number): void {
		this.ctx.storage.sql.exec(
			`INSERT INTO rate_buckets (name, tokens, updated_at_ms)
			 VALUES (?, ?, ?)
			 ON CONFLICT(name) DO UPDATE SET
				tokens = excluded.tokens,
				updated_at_ms = excluded.updated_at_ms`,
			state.name,
			Math.max(0, Math.min(state.capacity, state.tokens)),
			nowMs,
		);
	}

	private tryLease(message: ParseRequestMessage): LeaseResult {
		const nowMs = Date.now();
		const states = schedulerBuckets(this.env, message).map((config) =>
			this.readBucket(config, nowMs),
		);
		const waitSeconds = states.map((state) => {
			if (state.tokens >= state.cost) return 0;
			return Math.ceil((state.cost - state.tokens) / state.refillTokensPerSecond);
		});
		const retryAfterSeconds = Math.max(...waitSeconds);
		if (retryAfterSeconds > 0) {
			for (const state of states) this.writeBucket(state, nowMs);
			return { leased: false, retryAfterSeconds: Math.min(Math.max(1, retryAfterSeconds), 900) };
		}

		for (const state of states)
			this.writeBucket({ ...state, tokens: state.tokens - state.cost }, nowMs);
		return { leased: true };
	}

	private beginParse(message: ParseRequestMessage): BeginParseResponse {
		if (!isParseRequestMessage(message)) throw new Error('invalid parse request');
		const existing = this.getStatus(message.name, message.version);
		if (!message.force && existing?.status === 'ready') {
			return {
				accepted: false,
				leased: false,
				workflowId: existing.workflowId ?? parseWorkflowId(message.requestId),
				status: existing,
			};
		}
		if (
			!message.force &&
			existing?.status === 'processing' &&
			existing.requestId &&
			existing.requestId !== message.requestId
		) {
			return {
				accepted: false,
				leased: false,
				workflowId: existing.workflowId ?? parseWorkflowId(message.requestId),
				status: existing,
			};
		}

		const workflowId = parseWorkflowId(message.requestId);
		const now = databaseNow();
		this.ctx.storage.sql.exec(
			`INSERT INTO statuses (
				ecosystem, kind, name, version, status, step, error, action,
				request_id, workflow_id,
				requested_by_provider, requested_by_id, requested_by_login, requested_by_avatar_url,
				created_at, updated_at, sequence
			)
			VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 1)
			ON CONFLICT(ecosystem, name, version) DO UPDATE SET
				kind = excluded.kind,
				status = excluded.status,
				step = excluded.step,
				error = NULL,
				action = NULL,
				request_id = excluded.request_id,
				workflow_id = excluded.workflow_id,
				requested_by_provider = excluded.requested_by_provider,
				requested_by_id = excluded.requested_by_id,
				requested_by_login = excluded.requested_by_login,
				requested_by_avatar_url = excluded.requested_by_avatar_url,
				updated_at = excluded.updated_at,
				sequence = statuses.sequence + 1`,
			'rust',
			message.kind,
			message.name,
			message.version,
			'processing',
			'queued',
			message.requestId,
			workflowId,
			message.requestedBy?.provider ?? null,
			message.requestedBy?.id ?? null,
			message.requestedBy?.login ?? null,
			message.requestedBy?.avatarUrl ?? null,
			now,
			now,
		);

		const lease = this.tryLease(message);
		if (!lease.leased) {
			const status = this.recordEvent({
				kind: message.kind,
				name: message.name,
				version: message.version,
				status: 'processing',
				step: 'waiting-rate-limit',
				requestId: message.requestId,
				workflowId,
				requestedBy: message.requestedBy,
			});
			return {
				accepted: true,
				leased: false,
				workflowId,
				retryAfterSeconds: lease.retryAfterSeconds,
				status,
			};
		}

		const status = this.recordEvent({
			kind: message.kind,
			name: message.name,
			version: message.version,
			status: 'processing',
			step: 'workflow-started',
			requestId: message.requestId,
			workflowId,
			requestedBy: message.requestedBy,
		});
		if (!status) throw new Error('failed to write parse status');
		return { accepted: true, leased: true, workflowId, status };
	}

	private recordEvent(event: ParseStatusEvent): StoredParseStatus {
		if (event.requestId) {
			const existing = this.getStatus(event.name, event.version);
			if (existing?.requestId && existing.requestId !== event.requestId) {
				return existing;
			}
		}

		const now = databaseNow();
		this.ctx.storage.sql.exec(
			`INSERT INTO statuses (
				ecosystem, kind, name, version, status, step, error, action,
				request_id, workflow_id, github_run_id, github_run_url,
				requested_by_provider, requested_by_id, requested_by_login, requested_by_avatar_url,
				created_at, updated_at, sequence
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
			ON CONFLICT(ecosystem, name, version) DO UPDATE SET
				kind = excluded.kind,
				status = excluded.status,
				step = excluded.step,
				error = excluded.error,
				action = excluded.action,
				request_id = COALESCE(excluded.request_id, statuses.request_id),
				workflow_id = COALESCE(excluded.workflow_id, statuses.workflow_id),
				github_run_id = COALESCE(excluded.github_run_id, statuses.github_run_id),
				github_run_url = COALESCE(excluded.github_run_url, statuses.github_run_url),
				requested_by_provider = COALESCE(excluded.requested_by_provider, statuses.requested_by_provider),
				requested_by_id = COALESCE(excluded.requested_by_id, statuses.requested_by_id),
				requested_by_login = COALESCE(excluded.requested_by_login, statuses.requested_by_login),
				requested_by_avatar_url = COALESCE(excluded.requested_by_avatar_url, statuses.requested_by_avatar_url),
				updated_at = excluded.updated_at,
				sequence = statuses.sequence + 1`,
			'rust',
			event.kind ?? 'crate',
			event.name,
			event.version,
			event.status,
			event.step ?? null,
			event.error ?? null,
			event.action ?? null,
			event.requestId ?? null,
			event.workflowId ?? null,
			event.githubRunId ?? null,
			event.githubRunUrl ?? null,
			event.requestedBy?.provider ?? null,
			event.requestedBy?.id ?? null,
			event.requestedBy?.login ?? null,
			event.requestedBy?.avatarUrl ?? null,
			now,
			now,
		);
		const status = this.getStatus(event.name, event.version);
		if (!status) throw new Error('failed to write parse status');
		this.broadcast(crateStatusTag(event.name, event.version), status);
		this.broadcast('processing:rust', { type: 'processing', count: this.processing(100).length });
		return status;
	}
}

export class ParseCrateWorkflow extends WorkflowEntrypoint<ParseWorkerEnv, ParseWorkflowParams> {
	async run(event: WorkflowEvent<ParseWorkflowParams>, step: WorkflowStep): Promise<unknown> {
		const params = event.payload;
		if (!params) throw new NonRetryableError('missing parse workflow payload');
		const workflowId = parseWorkflowId(params.requestId);

		await step.do('mark workflow started', WORKFLOW_STATUS_STEP_CONFIG, async (ctx) => {
			logWorkflowRetry(ctx, params);
			await updateStatus(this.env, {
				kind: params.kind,
				name: params.name,
				version: params.version,
				status: 'processing',
				step: 'workflow-started',
				requestId: params.requestId,
				workflowId,
			});
		});

		const dispatch = await step.do(
			'dispatch github action',
			WORKFLOW_GITHUB_DISPATCH_STEP_CONFIG,
			async (ctx) => {
				logWorkflowRetry(ctx, params);
				return dispatchGitHubParse(this.env, params, workflowId);
			},
		);

		await step.do('mark github running', WORKFLOW_STATUS_STEP_CONFIG, async (ctx) => {
			logWorkflowRetry(ctx, params);
			await updateStatus(this.env, {
				kind: params.kind,
				name: params.name,
				version: params.version,
				status: 'processing',
				step: 'github-running',
				requestId: params.requestId,
				workflowId,
			});
			return dispatch;
		});

		let completion: { payload: ParseCompletionPayload };
		try {
			completion = await step.waitForEvent<ParseCompletionPayload>('wait for github', {
				type: 'github-complete',
				timeout: GITHUB_CALLBACK_WAIT_TIMEOUT,
			});
		} catch (err) {
			const recovered = await step
				.do(
					'recover artifacts after github wait timeout',
					WORKFLOW_ARTIFACT_VERIFY_STEP_CONFIG,
					async (ctx) => {
						logWorkflowRetry(ctx, params);
						await verifyArtifacts(this.env, params.name, params.version);
						return true;
					},
				)
				.catch((verifyErr) => {
					console.warn(
						`parse workflow timeout artifact recovery failed ${params.name}@${params.version}: ${errorMessage(verifyErr)}`,
					);
					return false;
				});
			if (recovered) {
				await step.do('mark ready after github wait timeout', WORKFLOW_STATUS_STEP_CONFIG, async (ctx) => {
					logWorkflowRetry(ctx, params);
					await updateStatus(this.env, {
						kind: params.kind,
						name: params.name,
						version: params.version,
						status: 'ready',
						requestId: params.requestId,
						workflowId,
					});
				});
				return { ok: true, recovered: 'artifacts-after-timeout' };
			}

			await step.do('mark github wait failed', WORKFLOW_STATUS_STEP_CONFIG, async (ctx) => {
				logWorkflowRetry(ctx, params);
				await updateStatus(this.env, {
					kind: params.kind,
					name: params.name,
					version: params.version,
					status: 'failed',
					step: 'github-timeout',
					error: `GitHub callback did not arrive before workflow timeout: ${errorMessage(err)}`,
					requestId: params.requestId,
					workflowId,
				});
			});
			return { ok: false };
		}
		const payload = completion.payload;
		if (!payload?.ok) {
			await step.do('mark failed', WORKFLOW_STATUS_STEP_CONFIG, async (ctx) => {
				logWorkflowRetry(ctx, params);
				await updateStatus(this.env, {
					kind: params.kind,
					name: params.name,
					version: params.version,
					status: 'failed',
					step: 'failed',
					error: payload?.error ?? 'GitHub parse workflow failed',
					requestId: params.requestId,
					workflowId,
					githubRunId: payload?.runId,
					githubRunUrl: payload?.runUrl,
				});
			});
			return { ok: false };
		}

		try {
			await step.do(
				'verify r2 artifacts',
				WORKFLOW_ARTIFACT_VERIFY_STEP_CONFIG,
				async (ctx) => {
					logWorkflowRetry(ctx, params);
					await verifyArtifacts(this.env, params.name, params.version);
					return true;
				},
			);
		} catch (err) {
			await step.do(
				'mark artifact verification failed',
				WORKFLOW_STATUS_STEP_CONFIG,
				async (ctx) => {
					logWorkflowRetry(ctx, params);
					await updateStatus(this.env, {
						kind: params.kind,
						name: params.name,
						version: params.version,
						status: 'failed',
						step: 'artifact-verify',
						error: errorMessage(err),
						requestId: params.requestId,
						workflowId,
						githubRunId: payload.runId,
						githubRunUrl: payload.runUrl,
					});
				},
			);
			return { ok: false };
		}

		await step.do('mark ready', WORKFLOW_STATUS_STEP_CONFIG, async (ctx) => {
			logWorkflowRetry(ctx, params);
			await updateStatus(this.env, {
				kind: params.kind,
				name: params.name,
				version: params.version,
				status: 'ready',
				requestId: params.requestId,
				workflowId,
				githubRunId: payload.runId,
				githubRunUrl: payload.runUrl,
			});
		});
		return { ok: true };
	}
}

async function reconcileExistingWorkflowInstance(
	env: ParseWorkerEnv,
	request: ParseRequestMessage,
	workflowId: string,
): Promise<void> {
	let status:
		| {
				status: string;
				error?: { name?: string; message?: string };
				output?: unknown;
		  }
		| null = null;
	try {
		const instance = await env.PARSE_WORKFLOW.get(workflowId);
		status = await instance.status();
	} catch (err) {
		console.warn(
			`workflow instance status lookup failed ${request.name}@${request.version} workflow=${workflowId}: ${errorMessage(err)}`,
		);
		return;
	}

	const outputOk = workflowOutputOk(status.output);
	if (status.status === 'complete' && outputOk !== false) {
		try {
			await verifyArtifacts(env, request.name, request.version);
			await updateStatus(env, {
				kind: request.kind,
				name: request.name,
				version: request.version,
				status: 'ready',
				requestId: request.requestId,
				workflowId,
			});
			return;
		} catch (err) {
			if (outputOk !== true) return;
			await updateStatus(env, {
				kind: request.kind,
				name: request.name,
				version: request.version,
				status: 'failed',
				step: 'workflow-complete',
				error: `Existing workflow completed successfully but artifacts are unavailable: ${errorMessage(err)}`,
				requestId: request.requestId,
				workflowId,
			});
			return;
		}
	}

	if (status.status === 'errored' || status.status === 'terminated' || outputOk === false) {
		const detail = status.error?.message
			? `${status.error.name ? `${status.error.name}: ` : ''}${status.error.message}`
			: `Workflow instance status is ${status.status}`;
		await updateStatus(env, {
			kind: request.kind,
			name: request.name,
			version: request.version,
			status: 'failed',
			step: 'workflow-existing',
			error: detail,
			requestId: request.requestId,
			workflowId,
		});
	}
}

async function handleQueueMessage(message: Message<unknown>, env: ParseWorkerEnv): Promise<void> {
	if (!isParseRequestMessage(message.body)) {
		message.ack();
		return;
	}
	if (message.body.kind === 'sysroot' && message.body.version !== HOSTED_SYSROOT_PARSE_CHANNEL) {
		await updateStatus(env, {
			name: message.body.name,
			version: message.body.version,
			kind: message.body.kind,
			status: 'failed',
			step: 'unsupported',
			error: HOSTED_SYSROOT_UNAVAILABLE_MESSAGE,
			requestId: message.body.requestId,
			workflowId: parseWorkflowId(message.body.requestId),
			requestedBy: message.body.requestedBy,
		});
		message.ack();
		return;
	}
	const beginResponse = await parseStatusObject(env.PARSE_STATUS).fetch('https://status/begin', {
		method: 'POST',
		headers: JSON_HEADERS,
		body: JSON.stringify(message.body),
	});
	if (!beginResponse.ok) {
		message.retry({ delaySeconds: 30 });
		return;
	}
	const begin = (await beginResponse.json()) as BeginParseResponse;
	if (!begin.accepted) {
		message.ack();
		return;
	}
	if (!begin.leased) {
		const retryAfterSeconds = Math.min(
			900,
			Math.max(1, begin.retryAfterSeconds ?? 30) + Math.floor(Math.random() * 5),
		);
		if (env.PARSE_REQUESTS) {
			await env.PARSE_REQUESTS.send(message.body, { delaySeconds: retryAfterSeconds });
			message.ack();
		} else {
			message.retry({ delaySeconds: retryAfterSeconds });
		}
		return;
	}
	try {
		await env.PARSE_WORKFLOW.create({
			id: begin.workflowId,
			params: {
				...message.body,
				callbackBaseUrl: env.PARSE_CALLBACK_BASE_URL,
			},
			retention: {
				successRetention: '7 days',
				errorRetention: '14 days',
			},
		});
		message.ack();
	} catch (err) {
		const text = err instanceof Error ? err.message : String(err);
		if (text.includes('already exists')) {
			await reconcileExistingWorkflowInstance(env, message.body, begin.workflowId);
			message.ack();
			return;
		}
		await updateStatus(env, {
			name: message.body.name,
			version: message.body.version,
			kind: message.body.kind,
			status: 'failed',
			step: 'workflow-create',
			error: text,
			requestId: message.body.requestId,
			workflowId: begin.workflowId,
		});
		message.retry({ delaySeconds: 60 });
	}
}

async function handleCallback(request: Request, env: ParseWorkerEnv): Promise<Response> {
	if (!env.PARSE_CALLBACK_SECRET) {
		return json({ error: 'parse callback secret is not configured' }, { status: 503 });
	}
	const authorized = callbackSecretsFromRequest(request).some((candidate) =>
		constantTimeEqual(candidate, env.PARSE_CALLBACK_SECRET!),
	);
	if (!authorized) {
		return json({ error: 'unauthorized' }, { status: 401 });
	}
	const payload = parseCompletionPayload(await readJson<unknown>(request));
	if (!payload) {
		return json({ error: 'invalid callback payload' }, { status: 400 });
	}
	const existing = await readStatus(env, payload.name, payload.version);
	if (existing?.requestId && existing.requestId !== payload.requestId) {
		return json({ ok: true, eventDelivered: false, ignored: 'stale-request' });
	}
	if (existing?.requestId === payload.requestId) {
		if (existing.status === 'ready') {
			return json({ ok: true, eventDelivered: false, alreadyReady: true });
		}
		if (!payload.ok && existing.status === 'failed') {
			return json({ ok: true, eventDelivered: false, alreadyFailed: true });
		}
	}
	await updateStatus(env, {
		kind: payload.kind,
		name: payload.name,
		version: payload.version,
		status: payload.ok ? 'processing' : 'failed',
		step: payload.ok ? 'finalizing' : 'failed',
		error: payload.error,
		requestId: payload.requestId,
		workflowId: payload.workflowId,
		githubRunId: payload.runId,
		githubRunUrl: payload.runUrl,
	});
	let eventDelivered = true;
	try {
		const instance = await env.PARSE_WORKFLOW.get(payload.workflowId);
		await instance.sendEvent({ type: 'github-complete', payload });
	} catch (err) {
		eventDelivered = false;
		console.warn(`workflow event delivery failed for ${payload.workflowId}: ${errorMessage(err)}`);
	}
	if (payload.ok) {
		try {
			await verifyArtifacts(env, payload.name, payload.version);
			await updateStatus(env, {
				kind: payload.kind,
				name: payload.name,
				version: payload.version,
				status: 'ready',
				requestId: payload.requestId,
				workflowId: payload.workflowId,
				githubRunId: payload.runId,
				githubRunUrl: payload.runUrl,
			});
		} catch (err) {
			if (!eventDelivered) throw err;
		}
	}
	return json({ ok: true, eventDelivered });
}

export default {
	async scheduled(_controller: ScheduledController, env: ParseWorkerEnv): Promise<void> {
		const reconciled = await reconcileFinalizingParses(env);
		if (reconciled.ready > 0 || reconciled.failed > 0) {
			console.log(
				`reconciled finalizing parses ready=${reconciled.ready} failed=${reconciled.failed}`,
			);
		}
		const stale = await reconcileStaleProcessingParses(env);
		if (stale.ready > 0 || stale.failed > 0) {
			console.log(
				`reconciled stale parses ready=${stale.ready} failed=${stale.failed} kept=${stale.kept}`,
			);
		}
		const result = await drainPlannedParses(env);
		if (result.budgetLimited) {
			console.log(`planned parse drain paused reason=${result.budgetReason ?? 'budget-limited'}`);
		} else if (result.queued > 0) {
			console.log(
				`drained planned parses queued=${result.queued} skipped=${result.skipped} activeTarget=${result.activeTarget} actionsInUse=${result.actionsInUse} statusActive=${result.statusActive} githubActive=${result.githubActive}`,
			);
		}
	},

	async queue(batch: MessageBatch<unknown>, env: ParseWorkerEnv): Promise<void> {
		await Promise.all(batch.messages.map((message) => handleQueueMessage(message, env)));
	},

	async fetch(request: Request, env: ParseWorkerEnv): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/api/parse/callback' && request.method === 'POST') {
			return handleCallback(request, env);
		}
		if (url.pathname === '/health') return json({ ok: true });
		return new Response('Not found', { status: 404 });
	},
} satisfies ExportedHandler<ParseWorkerEnv, unknown>;
