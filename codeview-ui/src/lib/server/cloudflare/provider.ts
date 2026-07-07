import { Result } from 'better-result';
import { Data, Effect } from 'effect';
import type { RequestEvent } from '@sveltejs/kit';
import type { CrateGraph, Node, NodeKind } from '$lib/graph';
import type {
	CrateIndex,
	CrateTree,
	NodeDetail,
	NodeSummary,
	NodeViewBase,
	StaticCrateCatalog,
	StaticCrateManifest,
	StaticNodeDetailEntry,
	StaticNodeDetailShard,
	StaticNodeShard,
	StaticSearchManifest,
	StaticSearchShard,
	TreeNodeDTO,
} from '$lib/schema';
import type { CrateMapData, CrateMapOptions } from '$lib/graph/crate-map';
import { isStdCrate } from '$lib/std';
import type {
	CrateSummaryResult,
	CrossEdgeData,
	DataProvider,
	AdminDashboardData,
	ActiveParseRun,
	GitHubActionsBillingSummary,
	ParseQueueAllowance,
	ParseQueueEntry,
	ParseQueueSnapshot,
	PlannedParseItem,
	PlannedParseRun,
} from '../provider';
import { getRegistry } from '../registry/index';
import { fetchSourceFileFromArchive } from '../parser/archive';
import { getSourceAdapter } from '../sources/index';
import { fetchSourcesWithProviders } from '../sources/runner';
import { NotAvailableError, RateLimitError, ValidationError } from '../errors';
import {
	crateNameVariants,
	hyphenateCrateName,
	isValidCrateName,
	isValidVersion,
	normalizeCrateName,
} from '../validation';
import { getLogger } from '$lib/log';
import { summarizeNode } from '$lib/node-summary';
import { actorFromUser, getAuthStateFromRequest } from '../auth';
import {
	makeParseRequest,
	parseStatusObject,
	parseWorkflowId,
	type ParseRequestMessage,
	type ParseStatusEvent,
	type ParseQueueSnapshot as StoredParseQueueSnapshot,
	type StoredParseStatus,
} from './parse-contract';
import {
	USER_AGENT,
	SOURCE_MAX_BYTES,
	source,
	fetchStdSourceFile,
	type SourceProviderMode,
} from '../provider-utils';
import type { PackageMetadata } from '../registry/types';
import { orderCatalogSummaries } from './catalog';

const log = getLogger('cloudflare');

type AppEnv = Env & {
	CRATE_GRAPHS: R2Bucket;
	PARSE_REQUESTS?: Queue<ParseRequestMessage>;
	PARSE_STATUS?: DurableObjectNamespace;
	RATE_LIMIT_API?: RateLimit;
	RATE_LIMIT_API_ANON?: RateLimit;
	RATE_LIMIT_API_AUTH?: RateLimit;
	RATE_LIMIT_PARSE_ANON?: RateLimit;
	RATE_LIMIT_PARSE_AUTH?: RateLimit;
	AUTH_DB?: D1Database;
	BETTER_AUTH_SECRET?: string;
	BETTER_AUTH_URL?: string;
	GITHUB_OAUTH_CLIENT_ID?: string;
	GITHUB_OAUTH_CLIENT_SECRET?: string;
	GITHUB_ADMIN_LOGINS?: string;
	GITHUB_REPO?: string;
	GITHUB_REF?: string;
	GITHUB_WORKFLOW_FILE?: string;
	GITHUB_TOKEN?: string;
	PLAN_DRAIN_ACTIVE_TARGET?: string;
	PLAN_DRAIN_BATCH_SIZE?: string;
	GITHUB_ACTIONS_REPO_USAGE_TARGET_PERCENT?: string;
};

type SearchEntry = NodeSummary & { score?: number };
const NODE_VIEW_BUCKETS = 128;
const DEFAULT_SITE_TREE_BUCKETS = 128;
const DEFAULT_SITE_ALIAS_BUCKETS = 128;
const DEFAULT_GITHUB_WORKFLOW_FILE = 'parse.yml';
const DEFAULT_PLAN_DRAIN_ACTIVE_TARGET = 4;
const DEFAULT_PLAN_DRAIN_BATCH_SIZE = 2;
const DEFAULT_GITHUB_ACTIONS_REPO_USAGE_TARGET_PERCENT = 35;
const GITHUB_API_VERSION = '2026-03-10';
const ACTIVE_GITHUB_RUN_STATUSES = ['queued', 'in_progress', 'waiting', 'requested'] as const;

type GitHubWorkflowRun = {
	id?: number;
	name?: string;
	display_title?: string;
	status?: string;
	event?: string;
	head_branch?: string;
	html_url?: string;
	created_at?: string;
	updated_at?: string;
};

type GitHubWorkflowRunsResponse = {
	workflow_runs?: GitHubWorkflowRun[];
};

type GitHubRepositoryResponse = {
	full_name?: string;
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

function parsePositiveInteger(value: string | undefined, fallback: number): number {
	if (value === undefined || value.trim() === '') return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
	if (value === undefined || value.trim() === '') return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function monthStartIso(now = new Date()): string {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function finiteNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function githubGrossUsageQuantity(item: GitHubBillingUsageItem): number {
	return finiteNumber(item.grossQuantity) ?? finiteNumber(item.quantity) ?? 0;
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

function totalGrossActionsMinutes(body: GitHubBillingUsageSummaryResponse): number {
	return (body.usageItems ?? [])
		.filter(isActionsMinuteUsage)
		.reduce((total, item) => total + githubGrossUsageQuantity(item), 0);
}

function totalBillableActionsMinutes(body: GitHubBillingUsageSummaryResponse): number {
	return (body.usageItems ?? [])
		.filter(isActionsMinuteUsage)
		.reduce((total, item) => total + githubNetUsageQuantity(item), 0);
}

function registrySummary(result: PackageMetadata): CrateSummaryResult {
	return {
		id: hyphenateCrateName(result.name),
		name: result.name,
		version: result.version,
		description: result.description,
	};
}

class R2ReadError extends Data.TaggedError('R2ReadError')<{
	readonly key: string;
	readonly cause: unknown;
	readonly message: string;
}> {}

class R2DecodeError extends Data.TaggedError('R2DecodeError')<{
	readonly key: string;
	readonly cause: unknown;
	readonly message: string;
}> {}

class R2ParseError extends Data.TaggedError('R2ParseError')<{
	readonly key: string;
	readonly cause: unknown;
	readonly message: string;
}> {}

type R2JsonError = R2ReadError | R2DecodeError | R2ParseError;

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/** Build a GitHub file URL from package metadata, or null if repo info unavailable. */
function buildGitHubFileUrl(metadata: PackageMetadata, filePath: string): string | null {
	const repoUrl = metadata.repositoryUrl;
	if (!repoUrl) return null;
	try {
		const url = new URL(repoUrl);
		if (!url.hostname.includes('github.com')) return null;
		const path = url.pathname.replace(/\.git$/, '').replace(/\/+$/, '');
		const normalizedFile = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
		return `https://github.com${path}/blob/v${metadata.version}/${normalizedFile}`;
	} catch {
		return null;
	}
}

const VERSION_ALIAS_VALUES = ['latest', 'stable', 'beta', 'nightly'] as const;
type VersionAlias = (typeof VERSION_ALIAS_VALUES)[number];
const VERSION_ALIASES = new Set<string>(VERSION_ALIAS_VALUES);
const REF_ALIAS_TTL_MS = 60_000;
const REF_CACHE_MAX = 512;
const JSON_CACHE_MAX = 128;
const ARTIFACT_JSON_CACHE_MAX = 256;
const IMMUTABLE_ARTIFACT_CACHE_CONTROL = 'public, max-age=31536000, immutable';

function uniqueCrateNameVariants(name: string): string[] {
	return [...new Set(crateNameVariants(name))];
}

type ArtifactRef = {
	storageName: string;
	version: string;
	graphHash?: string;
};

type CrateRefTarget = {
	version: string;
	graphHash: string;
};

type CrateRefVersion = CrateRefTarget & {
	parsedAt?: string;
	nodes?: number;
	edges?: number;
};

type CrateRefFile = {
	schemaVersion?: number;
	storageName: string;
	displayName?: string;
	aliases: Partial<Record<VersionAlias, CrateRefTarget>>;
	versions: CrateRefVersion[];
};

type WorkPlanArtifact = {
	run_id?: string;
	runId?: string;
	generated_at?: string;
	generatedAt?: string;
	mode?: string;
	shard_count?: number;
	shardCount?: number;
	work?: Array<{
		work_id?: string;
		workId?: string;
		kind?: string;
		name?: string;
		version?: string;
		channel?: string;
		priority_tier?: string;
		priorityTier?: string;
		download_rank?: number;
		downloadRank?: number;
		reason?: string;
	}>;
};

type PlanKeyCandidate = {
	key: string;
	uploaded?: string;
};

type ResolvedRefCacheEntry = {
	value: Promise<ArtifactRef | null>;
	expiresAt: number | null;
};

const resolvedRefCache = new Map<string, ResolvedRefCacheEntry>();

function artifactPrefix(name: string, version: string): string {
	return `rust/${name}/${version}`;
}

function refsKey(storageName: string): string {
	return `rust/_refs/${storageName}.json`;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCrateRefTarget(value: unknown): CrateRefTarget | null {
	if (!isObject(value)) return null;
	const { version, graphHash } = value;
	if (typeof version !== 'string' || version.length === 0) return null;
	if (typeof graphHash !== 'string' || graphHash.length === 0) return null;
	return { version, graphHash };
}

function parseCrateRefs(value: unknown): CrateRefFile | null {
	if (!isObject(value)) return null;
	const storageName = value.storageName;
	const aliases = value.aliases;
	const versions = value.versions;
	if (typeof storageName !== 'string' || storageName.length === 0) return null;
	if (!isObject(aliases) || !Array.isArray(versions)) return null;

	const parsedAliases: CrateRefFile['aliases'] = {};
	for (const alias of VERSION_ALIAS_VALUES) {
		const target = parseCrateRefTarget(aliases[alias]);
		if (target) parsedAliases[alias] = target;
	}

	const parsedVersions = versions
		.map((entry): CrateRefVersion | null => {
			const target = parseCrateRefTarget(entry);
			if (!target) return null;
			return isObject(entry)
				? {
						...target,
						parsedAt: typeof entry.parsedAt === 'string' ? entry.parsedAt : undefined,
						nodes: typeof entry.nodes === 'number' ? entry.nodes : undefined,
						edges: typeof entry.edges === 'number' ? entry.edges : undefined,
					}
				: target;
		})
		.filter((entry): entry is CrateRefVersion => entry !== null);

	if (parsedVersions.length === 0) return null;
	return {
		schemaVersion: typeof value.schemaVersion === 'number' ? value.schemaVersion : undefined,
		storageName,
		displayName: typeof value.displayName === 'string' ? value.displayName : undefined,
		aliases: parsedAliases,
		versions: parsedVersions,
	};
}

function resolveRefFromRefs(refs: CrateRefFile, versionOrAlias: string): ArtifactRef | null {
	const target = VERSION_ALIASES.has(versionOrAlias)
		? refs.aliases[versionOrAlias as VersionAlias]
		: refs.versions.find((entry) => entry.version === versionOrAlias);
	if (!target) return null;
	return {
		storageName: refs.storageName,
		version: target.version,
		graphHash: target.graphHash,
	};
}

function resolvedRefCacheKey(name: string, version: string): string {
	return `${normalizeCrateName(name)}@${version}`;
}

function getCachedResolvedRef(key: string): Promise<ArtifactRef | null> | null {
	const cached = resolvedRefCache.get(key);
	if (!cached) return null;
	if (cached.expiresAt !== null && cached.expiresAt <= Date.now()) {
		resolvedRefCache.delete(key);
		return null;
	}
	resolvedRefCache.delete(key);
	resolvedRefCache.set(key, cached);
	return cached.value;
}

function setCachedResolvedRef(
	key: string,
	value: Promise<ArtifactRef | null>,
	expiresAt: number | null,
): void {
	resolvedRefCache.set(key, { value, expiresAt });
	while (resolvedRefCache.size > REF_CACHE_MAX) {
		const oldestKey = resolvedRefCache.keys().next().value;
		if (oldestKey === undefined) break;
		resolvedRefCache.delete(oldestKey);
	}
}

function fnv1a32(value: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i += 1) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash >>> 0;
}

function nodeViewBucket(nodeId: string, bucketCount = NODE_VIEW_BUCKETS): string {
	const bucket = fnv1a32(nodeId) % bucketCount;
	const width = Math.max(3, (bucketCount - 1).toString(16).length);
	return bucket.toString(16).padStart(width, '0');
}

function treeChildrenBucket(parentId: string, bucketCount = NODE_VIEW_BUCKETS): string {
	const bucket = fnv1a32(parentId) % bucketCount;
	const width = Math.max(3, (bucketCount - 1).toString(16).length);
	return bucket.toString(16).padStart(width, '0');
}

/**
 * Compute the search-shard prefix for a query string.
 *
 * Returns 1–2 characters. When the query is ≥ 2 chars we have an exact
 * 2-char prefix to look up. When it's 1 char, we return that single char
 * and the caller uses `manifest.prefixes.filter(p => p.startsWith(...))`
 * to fan out across all shards starting with that letter.
 */
function searchPrefix(value: string): string {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_]/g, '_');
	if (normalized.length === 0) return '__';
	if (normalized.length === 1) return normalized;
	return normalized.slice(0, 2);
}

function searchSummaries(
	entries: NodeSummary[],
	queryText: string,
	limit: number,
	kinds: Set<NodeKind> = new Set(),
): NodeSummary[] {
	const needle = queryText.trim().toLowerCase();
	if (!needle) return [];
	return entries
		.filter((entry) => kinds.size === 0 || kinds.has(entry.kind))
		.map((entry): SearchEntry | null => {
			const name = entry.name.toLowerCase();
			const id = entry.id.toLowerCase();
			if (name === needle) return { ...entry, score: 0 };
			if (name.startsWith(needle)) return { ...entry, score: 1 };
			if (id.endsWith(`::${needle}`)) return { ...entry, score: 2 };
			if (name.includes(needle)) return { ...entry, score: 3 };
			if (id.includes(needle)) return { ...entry, score: 4 };
			return null;
		})
		.filter((entry): entry is SearchEntry => entry !== null)
		.sort((a, b) => (a.score ?? 9) - (b.score ?? 9) || a.id.localeCompare(b.id))
		.slice(0, limit)
		.map(({ score: _score, ...entry }) => entry);
}

type HostedArtifactInfo = {
	nodeViewBucketCount?: number;
	treeChildrenBucketCount?: number;
	aliasBucketCount?: number;
	targetRawShardBytes?: number;
	searchPrefixLength?: number;
	nodeViewEntryLimit?: number;
	kindIndex?: boolean;
};

type HostedMetaArtifact = {
	schema_version: number;
	name: string;
	version: string;
	index: CrateIndex;
	nodeCount: number;
	edgeCount: number;
	kindCounts: Record<string, number>;
	roots: TreeNodeDTO[];
	rootChildren: Record<string, TreeNodeDTO[]>;
	artifacts?: HostedArtifactInfo;
};

type HostedNodeDetail = Omit<NodeDetail, 'node' | 'relatedNodes'> & {
	relatedNodes: NodeSummary[];
};

type HostedNodeViewEntry = {
	nodeId: string;
	detail: HostedNodeDetail;
	ancestors: NodeSummary[];
	stats?: {
		incomingEdges?: number;
		outgoingEdges?: number;
		relatedNodes?: number;
		includedIncomingEdges?: number;
		includedOutgoingEdges?: number;
		truncatedIncomingEdges?: number;
		truncatedOutgoingEdges?: number;
	};
};

type HostedNodeViewShard = {
	schema_version: number;
	name: string;
	version: string;
	bucket: string;
	bucketCount?: number;
	entries: Record<string, HostedNodeViewEntry>;
};

type HostedTreeChildrenShard = {
	schema_version: number;
	name: string;
	version: string;
	bucket: string;
	bucketCount?: number;
	parents: Record<
		string,
		{
			parent: NodeSummary;
			children: TreeNodeDTO[];
		}
	>;
};

type HostedSearchManifest = StaticSearchManifest;
type HostedSearchShard = StaticSearchShard;

type HostedKindShard = {
	schema_version: number;
	name: string;
	version: string;
	kind: NodeKind;
	entries: NodeSummary[];
};

type HostedAliasShard = {
	schema_version: number;
	name: string;
	version: string;
	bucket: string;
	bucketCount?: number;
	aliases: Record<string, { canonicalId: string; canonicalPath?: string }>;
};

function nodeFromSummary(summary: NodeSummary): Node {
	const node: Node = {
		id: summary.id,
		name: summary.name,
		kind: summary.kind,
		visibility: summary.visibility,
		attrs: [],
	};
	if (summary.is_external !== undefined) node.is_external = summary.is_external;
	if (summary.is_deprecated !== undefined) node.is_deprecated = summary.is_deprecated;
	if (summary.impl_trait !== undefined) node.impl_trait = summary.impl_trait;
	if (summary.impl_category !== undefined) node.impl_category = summary.impl_category;
	if (summary.generics !== undefined) node.generics = summary.generics;
	return node;
}

function readR2JsonEffect<T>(r2: R2Bucket, key: string): Effect.Effect<T | null, R2JsonError> {
	return Effect.gen(function* () {
		const obj = yield* Effect.tryPromise({
			try: () => r2.get(key),
			catch: (cause) =>
				new R2ReadError({
					key,
					cause,
					message: `R2 read failed for ${key}: ${errorMessage(cause)}`,
				}),
		});
		if (!obj) return null;

		const bytes = yield* Effect.tryPromise({
			try: async () => new Uint8Array(await obj.arrayBuffer()),
			catch: (cause) =>
				new R2DecodeError({
					key,
					cause,
					message: `R2 body decode failed for ${key}: ${errorMessage(cause)}`,
				}),
		});

		if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
			return yield* Effect.tryPromise({
				try: async () => {
					const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
					return (await new Response(stream).json()) as T;
				},
				catch: (cause) =>
					new R2ParseError({
						key,
						cause,
						message: `R2 gzip JSON parse failed for ${key}: ${errorMessage(cause)}`,
					}),
			});
		}

		return yield* Effect.try({
			try: () => JSON.parse(new TextDecoder().decode(bytes)) as T,
			catch: (cause) =>
				new R2ParseError({
					key,
					cause,
					message: `R2 JSON parse failed for ${key}: ${errorMessage(cause)}`,
				}),
		});
	});
}

const artifactJsonCache = new Map<string, Promise<unknown | null>>();
const artifactJsonInflight = new Map<string, Promise<unknown | null>>();
const sourceFileCache = new Map<string, string>();
const jsonCache = new Map<string, Promise<unknown | null>>();
const SOURCE_FILE_CACHE_MAX = 512;

function artifactR2Key(ref: ArtifactRef, path: string): string {
	return `${artifactPrefix(ref.storageName, ref.version)}/${path}`;
}

function encodePath(path: string): string {
	return path.split('/').map(encodeURIComponent).join('/');
}

function artifactCacheUrl(ref: ArtifactRef, path: string): string | null {
	if (!ref.graphHash) return null;
	return `https://codeview.internal/artifacts/${encodeURIComponent(ref.storageName)}/${encodeURIComponent(
		ref.version,
	)}/${encodeURIComponent(ref.graphHash)}/${encodePath(path)}`;
}

function getDefaultWorkerCache(): Cache | null {
	if (typeof caches === 'undefined') return null;
	return (caches as CacheStorage & { default?: Cache }).default ?? null;
}

async function decodeR2ObjectText(_key: string, obj: R2ObjectBody): Promise<string> {
	const bytes = new Uint8Array(await obj.arrayBuffer());
	if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
		const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
		return new Response(stream).text();
	}
	return new TextDecoder().decode(bytes);
}

function setArtifactJsonCache(key: string, value: Promise<unknown | null>): void {
	artifactJsonCache.set(key, value);
	while (artifactJsonCache.size > ARTIFACT_JSON_CACHE_MAX) {
		const oldestKey = artifactJsonCache.keys().next().value;
		if (oldestKey === undefined) break;
		artifactJsonCache.delete(oldestKey);
	}
}

async function readArtifactJsonWithCache<T>(
	r2: R2Bucket,
	r2Key: string,
	cacheUrl: string,
): Promise<T | null> {
	const request = new Request(cacheUrl, { method: 'GET' });
	const cache = getDefaultWorkerCache();
	if (cache) {
		try {
			const cached = await cache.match(request);
			if (cached) return (await cached.json()) as T;
		} catch (err) {
			log.warn`Cache API match failed for ${cacheUrl}: ${String(err)}`;
		}
	}

	let inflight = artifactJsonInflight.get(cacheUrl);
	if (!inflight) {
		inflight = (async (): Promise<T | null> => {
			const obj = await r2.get(r2Key);
			if (!obj) return null;
			const text = await decodeR2ObjectText(r2Key, obj);
			if (cache) {
				const response = new Response(text, {
					headers: {
						'Content-Type': 'application/json; charset=utf-8',
						'Cache-Control': IMMUTABLE_ARTIFACT_CACHE_CONTROL,
					},
				});
				try {
					await cache.put(request, response.clone());
				} catch (err) {
					log.warn`Cache API put failed for ${cacheUrl}: ${String(err)}`;
				}
			}
			return JSON.parse(text) as T;
		})().finally(() => {
			artifactJsonInflight.delete(cacheUrl);
		});
		artifactJsonInflight.set(cacheUrl, inflight);
	}
	return (await inflight) as T | null;
}

export function createCloudflareProvider(env: AppEnv, request?: Request): DataProvider {
	function sourceCacheKey(
		crateName: string,
		crateVersion: string,
		file: string,
		sourceProvider: SourceProviderMode,
	): string {
		return `${crateName}|${crateVersion}|${sourceProvider}|${file}`;
	}

	function getCachedSourceFile(key: string): string | null {
		const value = sourceFileCache.get(key);
		if (value === undefined) return null;
		sourceFileCache.delete(key);
		sourceFileCache.set(key, value);
		return value;
	}

	function setCachedSourceFile(key: string, content: string): void {
		if (sourceFileCache.has(key)) sourceFileCache.delete(key);
		sourceFileCache.set(key, content);
		while (sourceFileCache.size > SOURCE_FILE_CACHE_MAX) {
			const oldestKey = sourceFileCache.keys().next().value;
			if (oldestKey === undefined) break;
			sourceFileCache.delete(oldestKey);
		}
	}

	function anonymousParseRateLimitKey(): string {
		const ip =
			request?.headers.get('cf-connecting-ip') ??
			request?.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
			'anonymous';
		return `parse:anon:${ip}`;
	}

	async function resolveParseRequestContext({ rateLimit }: { rateLimit: boolean }) {
		const auth = request ? await getAuthStateFromRequest(request, env) : null;
		const actor = actorFromUser(auth?.user ?? null);
		if (!rateLimit) return { auth, actor, rateLimitError: null, configError: null };

		const limiter = actor
			? (env.RATE_LIMIT_PARSE_AUTH ?? env.RATE_LIMIT_API_AUTH ?? env.RATE_LIMIT_API)
			: (env.RATE_LIMIT_PARSE_ANON ?? env.RATE_LIMIT_API_ANON ?? env.RATE_LIMIT_API);
		if (!limiter) {
			return {
				auth,
				actor,
				rateLimitError: null,
				configError: new NotAvailableError({
					message: 'Hosted parse rate limiting is not configured',
				}),
			};
		}

		const key = actor ? `parse:user:${actor.id}` : anonymousParseRateLimitKey();
		const outcome = await limiter.limit({ key });
		if (outcome.success) return { auth, actor, rateLimitError: null, configError: null };
		return {
			auth,
			actor,
			configError: null,
			rateLimitError: new RateLimitError({
				message: actor
					? 'Too many signed-in parse requests. Try again shortly.'
					: 'Too many anonymous parse requests. Sign in for a higher limit or try again shortly.',
			}),
		};
	}

	function readJson<T>(key: string): Promise<T | null> {
		let cached = jsonCache.get(key);
		if (!cached) {
			cached = Effect.runPromise(
				readR2JsonEffect<T>(env.CRATE_GRAPHS, key).pipe(
					Effect.catch((err) =>
						Effect.sync(() => {
							jsonCache.delete(key);
							log.warn`${err.message}`;
							return null;
						}),
					),
				),
			);
			jsonCache.set(key, cached);
			while (jsonCache.size > JSON_CACHE_MAX) {
				const oldestKey = jsonCache.keys().next().value;
				if (oldestKey === undefined) break;
				jsonCache.delete(oldestKey);
			}
		}
		return cached as Promise<T | null>;
	}

	async function readArtifactJson<T>(ref: ArtifactRef, path: string): Promise<T | null> {
		const r2Key = artifactR2Key(ref, path);
		const cacheUrl = artifactCacheUrl(ref, path);
		if (!cacheUrl) return readJson<T>(r2Key);

		let cached = artifactJsonCache.get(cacheUrl);
		if (!cached) {
			cached = readArtifactJsonWithCache<T>(env.CRATE_GRAPHS, r2Key, cacheUrl).catch((err) => {
				artifactJsonCache.delete(cacheUrl);
				log.warn`R2 artifact read failed for ${r2Key}: ${String(err)}`;
				return null;
			});
			setArtifactJsonCache(cacheUrl, cached);
		}
		return cached as Promise<T | null>;
	}

	async function readCrateRefs(storageName: string): Promise<CrateRefFile | null> {
		const raw = await readJson<unknown>(refsKey(storageName));
		if (!raw) return null;
		const refs = parseCrateRefs(raw);
		if (!refs) {
			log.warn`Invalid crate refs at ${refsKey(storageName)}`;
			return null;
		}
		return refs;
	}

	async function resolveRefForArtifactUncached(
		name: string,
		version: string,
	): Promise<{ ref: ArtifactRef | null; cacheMode: 'none' | 'short' | 'forever' }> {
		let foundRefs = false;
		for (const variant of uniqueCrateNameVariants(name)) {
			const refs = await readCrateRefs(variant);
			if (!refs) continue;
			foundRefs = true;
			const ref = resolveRefFromRefs(refs, version);
			if (!ref) continue;
			const meta = await readArtifactJson<HostedMetaArtifact>(ref, 'site/meta.json');
			if (meta?.schema_version !== 1) continue;
			return {
				ref,
				cacheMode: VERSION_ALIASES.has(version) ? 'short' : 'forever',
			};
		}

		return { ref: null, cacheMode: foundRefs ? 'short' : 'none' };
	}

	async function resolveRefForArtifact(name: string, version: string): Promise<ArtifactRef | null> {
		const key = resolvedRefCacheKey(name, version);
		const cached = getCachedResolvedRef(key);
		if (cached) return cached;

		const pending = resolveRefForArtifactUncached(name, version)
			.then(({ ref, cacheMode }) => {
				if (cacheMode === 'none') {
					resolvedRefCache.delete(key);
					return ref;
				}
				const expiresAt =
					cacheMode === 'forever' && ref?.graphHash ? null : Date.now() + REF_ALIAS_TTL_MS;
				setCachedResolvedRef(key, Promise.resolve(ref), expiresAt);
				return ref;
			})
			.catch((err) => {
				resolvedRefCache.delete(key);
				throw err;
			});
		setCachedResolvedRef(key, pending, Date.now() + REF_ALIAS_TTL_MS);
		return pending;
	}

	async function listPublishedVersionsFromRefs(
		name: string,
		limit: number,
	): Promise<string[] | null> {
		let foundRefs = false;
		for (const variant of uniqueCrateNameVariants(name)) {
			const refs = await readCrateRefs(variant);
			if (!refs) continue;
			foundRefs = true;
			return refs.versions.map((entry) => entry.version).slice(0, limit);
		}
		return foundRefs ? [] : null;
	}

	async function loadHostedContext(
		name: string,
		version: string,
	): Promise<{ ref: ArtifactRef; meta: HostedMetaArtifact } | null> {
		const ref = await resolveRefForArtifact(name, version);
		if (!ref) return null;
		const meta = await readArtifactJson<HostedMetaArtifact>(ref, 'site/meta.json');
		return meta?.schema_version === 1 ? { ref, meta } : null;
	}

	async function loadHostedMetaArtifact(
		name: string,
		version: string,
	): Promise<HostedMetaArtifact | null> {
		return (await loadHostedContext(name, version))?.meta ?? null;
	}

	/**
	 * Per-isolate cache of `manifest.populatedShards` indexed for O(1) lookup.
	 * Each entry is either:
	 *   - `null`  : manifest missing or malformed, so no shard is trusted.
	 *   - `Map<kind, Set<bucket>>` : the typed lookup tables.
	 *
	 * The manifest body is cached by the artifact JSON reader; this extra layer
	 * avoids the JSON.parse + Set construction on every shard lookup (which
	 * happens dozens of times per page render for large crates).
	 */
	type PopulatedKind = 'nodes' | 'nodeDetails' | 'treeChildren';
	const populatedShardsCache = new Map<string, Map<PopulatedKind, Set<string>> | null>();

	async function populatedShardMap(
		ref: ArtifactRef,
	): Promise<Map<PopulatedKind, Set<string>> | null> {
		const cacheKey = `${ref.storageName}@${ref.version}`;
		let entry = populatedShardsCache.get(cacheKey);
		if (entry === undefined) {
			const manifest = await readArtifactJson<StaticCrateManifest>(ref, 'manifest.json');
			if (!manifest?.populatedShards) {
				populatedShardsCache.set(cacheKey, null);
				return null;
			}
			entry = new Map<PopulatedKind, Set<string>>([
				['nodes', new Set(manifest.populatedShards.nodes)],
				['nodeDetails', new Set(manifest.populatedShards.nodeDetails)],
				['treeChildren', new Set(manifest.populatedShards.treeChildren)],
			]);
			populatedShardsCache.set(cacheKey, entry);
		}
		return entry;
	}

	async function populatedShardBuckets(ref: ArtifactRef, kind: PopulatedKind): Promise<string[]> {
		return Array.from((await populatedShardMap(ref))?.get(kind) ?? []);
	}

	async function isShardPopulated(
		ref: ArtifactRef,
		kind: PopulatedKind,
		bucket: string,
	): Promise<boolean> {
		return (await populatedShardMap(ref))?.get(kind)?.has(bucket) ?? false;
	}

	async function loadNodeFromRef(ref: ArtifactRef, nodeId: string): Promise<Node | null> {
		const bucket = nodeViewBucket(nodeId);
		if (!(await isShardPopulated(ref, 'nodes', bucket))) return null;
		const shard = await readArtifactJson<StaticNodeShard>(ref, `nodes/${bucket}.json`);
		return shard?.nodes[nodeId] ?? null;
	}

	async function filterNodesFromShards(
		ref: ArtifactRef,
		kinds: Set<NodeKind>,
		limit: number,
	): Promise<NodeSummary[]> {
		if (kinds.size === 0) return [];
		const entries: NodeSummary[] = [];
		for (const bucket of await populatedShardBuckets(ref, 'nodes')) {
			const shard = await readArtifactJson<StaticNodeShard>(ref, `nodes/${bucket}.json`);
			if (!shard) continue;
			for (const node of Object.values(shard.nodes)) {
				if (node.is_external || !kinds.has(node.kind)) continue;
				entries.push(summarizeNode(node));
			}
		}
		return entries.sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit);
	}

	async function loadHostedKindShardFromRef(
		ref: ArtifactRef,
		kind: NodeKind,
	): Promise<HostedKindShard | null> {
		return readArtifactJson<HostedKindShard>(ref, `site/kinds/${kind}.json`);
	}

	async function filterNodesFromKindIndex(
		ref: ArtifactRef,
		meta: HostedMetaArtifact,
		kinds: Set<NodeKind>,
		limit: number,
	): Promise<NodeSummary[] | null> {
		if (kinds.size === 0) return [];
		if (!meta.artifacts?.kindIndex) return null;
		const shards = await Promise.all(
			Array.from(kinds)
				.sort()
				.map((kind) => loadHostedKindShardFromRef(ref, kind)),
		);
		const entries = shards.flatMap((shard) => shard?.entries ?? []);
		if (shards.length <= 1) return entries.slice(0, limit);
		return entries.sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit);
	}

	async function loadHostedAlias(
		ref: ArtifactRef,
		meta: HostedMetaArtifact,
		nodeId: string,
	): Promise<string | null> {
		const bucket = nodeViewBucket(
			nodeId,
			meta.artifacts?.aliasBucketCount ?? DEFAULT_SITE_ALIAS_BUCKETS,
		);
		const shard = await readArtifactJson<HostedAliasShard>(ref, `site/aliases/${bucket}.json`);
		return shard?.aliases[nodeId]?.canonicalId ?? null;
	}

	/**
	 * Per-crate path aliases (`public_path → canonical_id`). Cached in-process
	 * per (name, version) since the file is small and lookups happen on every
	 * nodeView fetch.
	 *
	 * NOTE: This is a process-lifetime cache. For Cloudflare Workers each
	 * request gets a fresh isolate, so the first lookup pays the R2 read; the
	 * file is tiny enough that this is negligible.
	 */
	const aliasCache = new Map<string, Map<string, string> | null>();

	async function loadCrateAliasesFromRef(ref: ArtifactRef): Promise<Map<string, string> | null> {
		const key = `${ref.storageName}@${ref.version}`;
		if (aliasCache.has(key)) return aliasCache.get(key) ?? null;
		const map = await readArtifactJson<Record<string, string>>(ref, 'aliases.json');
		const result = map ? new Map(Object.entries(map)) : null;
		aliasCache.set(key, result);
		return result;
	}

	async function loadNodeDetailEntryFromRef(
		ref: ArtifactRef,
		nodeId: string,
	): Promise<StaticNodeDetailEntry | null> {
		const bucket = nodeViewBucket(nodeId);
		if (!(await isShardPopulated(ref, 'nodeDetails', bucket))) return null;
		const shard = await readArtifactJson<StaticNodeDetailShard>(ref, `node-details/${bucket}.json`);
		return shard?.details[nodeId] ?? null;
	}

	async function assembleNodeViewFromShards(
		ref: ArtifactRef,
		nodeId: string,
	): Promise<NodeViewBase | null> {
		let resolvedId = nodeId;
		let [entry, node] = await Effect.runPromise(
			Effect.all(
				[
					Effect.promise(() => loadNodeDetailEntryFromRef(ref, resolvedId)),
					Effect.promise(() => loadNodeFromRef(ref, resolvedId)),
				] as const,
				{ concurrency: 2 },
			),
		);

		// Alias resolution — `nodeId` may be a public re-export path (e.g.
		// `core::async_iter::AsyncIterator`) that doesn't correspond to a
		// stored node. Resolve via `aliases.json` to the canonical ID.
		if ((!entry || !node) && !resolvedId.endsWith('!alias-checked')) {
			const aliases = await loadCrateAliasesFromRef(ref);
			const canonical = aliases?.get(nodeId);
			if (canonical && canonical !== nodeId) {
				resolvedId = canonical;
				[entry, node] = await Effect.runPromise(
					Effect.all(
						[
							Effect.promise(() => loadNodeDetailEntryFromRef(ref, resolvedId)),
							Effect.promise(() => loadNodeFromRef(ref, resolvedId)),
						] as const,
						{ concurrency: 2 },
					),
				);
			}
		}

		if (!entry || !node) return null;

		const relatedNodes = new Map<string, Node>();
		const relatedBuckets = new Map<string, string[]>();
		for (const id of entry.relatedIds) {
			const bucket = nodeViewBucket(id);
			(relatedBuckets.get(bucket) ?? relatedBuckets.set(bucket, []).get(bucket)!).push(id);
		}

		await Effect.runPromise(
			Effect.forEach(
				Array.from(relatedBuckets.entries()),
				([bucket, ids]) =>
					Effect.promise(async () => {
						// Skip empty buckets. The populated-shards manifest tells us
						// before we pay the R2 round-trip.
						if (!(await isShardPopulated(ref, 'nodes', bucket))) return;
						const shard = await readArtifactJson<StaticNodeShard>(ref, `nodes/${bucket}.json`);
						if (!shard) return;
						for (const id of ids) {
							const related = shard.nodes[id];
							if (related) relatedNodes.set(id, related);
						}
					}),
				{ concurrency: 8, discard: true },
			),
		);

		return {
			detail: {
				node,
				edges: entry.edges,
				relatedNodes: entry.relatedIds
					.map((id) => relatedNodes.get(id))
					.filter((related): related is Node => Boolean(related)),
			},
			ancestors: entry.ancestors,
		};
	}

	async function loadMaterializedNodeView(
		hostedRef: ArtifactRef,
		hostedMeta: HostedMetaArtifact,
		nodeId: string,
	): Promise<NodeViewBase | null> {
		async function loadEntry(id: string): Promise<HostedNodeViewEntry | null> {
			const bucketCount = hostedMeta.artifacts?.nodeViewBucketCount ?? NODE_VIEW_BUCKETS;
			if (bucketCount <= 0) return null;
			const bucket = nodeViewBucket(id, bucketCount);
			const shard = await readArtifactJson<HostedNodeViewShard>(
				hostedRef,
				`site/node-views/${bucket}.json`,
			);
			return shard?.entries[id] ?? null;
		}

		let resolvedId = nodeId;
		let entry = await loadEntry(resolvedId);
		if (!entry) {
			const canonical = await loadHostedAlias(hostedRef, hostedMeta, nodeId);
			if (canonical && canonical !== nodeId) {
				resolvedId = canonical;
				entry = await loadEntry(resolvedId);
			}
		}
		const node = entry ? await loadNodeFromRef(hostedRef, resolvedId) : null;
		return entry && node
			? {
					detail: {
						node,
						edges: entry.detail.edges,
						relatedNodes: entry.detail.relatedNodes.map(nodeFromSummary),
					},
					ancestors: entry.ancestors,
				}
			: null;
	}

	async function loadNodeView(
		name: string,
		version: string,
		nodeId: string,
	): Promise<NodeViewBase | null> {
		const context = await loadHostedContext(name, version);
		if (!context) return null;
		const nodeViewBucketCount = context.meta.artifacts?.nodeViewBucketCount ?? NODE_VIEW_BUCKETS;
		if (nodeViewBucketCount <= 0) {
			return assembleNodeViewFromShards(context.ref, nodeId);
		}
		return loadMaterializedNodeView(context.ref, context.meta, nodeId);
	}

	async function loadHostedSearchManifestFromRef(
		ref: ArtifactRef,
	): Promise<HostedSearchManifest | null> {
		return readArtifactJson<HostedSearchManifest>(ref, 'site/search-manifest.json');
	}

	async function loadHostedSearchShardFromRef(
		ref: ArtifactRef,
		prefix: string,
	): Promise<HostedSearchShard | null> {
		return readArtifactJson<HostedSearchShard>(ref, `site/search/${prefix}.json`);
	}

	async function loadHostedTreeChildrenFromContext(
		context: { ref: ArtifactRef; meta: HostedMetaArtifact },
		parentId: string,
	): Promise<TreeNodeDTO[] | null> {
		const bucket = treeChildrenBucket(
			parentId,
			context.meta.artifacts?.treeChildrenBucketCount ?? DEFAULT_SITE_TREE_BUCKETS,
		);
		const shard = await readArtifactJson<HostedTreeChildrenShard>(
			context.ref,
			`site/tree-children/${bucket}.json`,
		);
		return shard?.parents[parentId]?.children ?? null;
	}

	async function loadCatalogArtifact(): Promise<StaticCrateCatalog | null> {
		const catalog = await readJson<StaticCrateCatalog>('rust/catalog.json');
		if (catalog?.schema_version !== 1 || !Array.isArray(catalog.crates)) return null;
		return catalog;
	}

	async function listPublishedVersions(name: string, limit = 20): Promise<string[]> {
		const refsVersions = await listPublishedVersionsFromRefs(name, limit);
		return refsVersions ?? [];
	}

	async function firstPublishedVersion(name: string): Promise<string | null> {
		const latest = await resolveRefForArtifact(name, 'latest');
		if (latest) return latest.version;
		return (await listPublishedVersions(name, 1))[0] ?? null;
	}

	function storedStatusToCrateStatus(stored: StoredParseStatus) {
		return {
			status: stored.status,
			error: stored.error,
			step: stored.step,
			action: stored.action,
			installedVersion: stored.installedVersion,
		};
	}

	async function readHostedParseStatus(
		name: string,
		version: string,
	): Promise<StoredParseStatus | null> {
		if (!env.PARSE_STATUS) return null;
		const url = new URL('https://status/status');
		url.searchParams.set('name', name);
		url.searchParams.set('version', version);
		const response = await parseStatusObject(env.PARSE_STATUS).fetch(url);
		if (!response.ok) return null;
		return (await response.json()) as StoredParseStatus | null;
	}

	async function listHostedProcessing(limit: number): Promise<StoredParseStatus[]> {
		if (!env.PARSE_STATUS) return [];
		const url = new URL('https://status/processing');
		url.searchParams.set('limit', String(limit));
		const response = await parseStatusObject(env.PARSE_STATUS).fetch(url);
		if (!response.ok) return [];
		return (await response.json()) as StoredParseStatus[];
	}

	async function readHostedQueue(limit: number): Promise<StoredParseQueueSnapshot> {
		if (!env.PARSE_STATUS) return { active: [], recent: [] };
		const url = new URL('https://status/queue');
		url.searchParams.set('limit', String(limit));
		const response = await parseStatusObject(env.PARSE_STATUS).fetch(url);
		if (!response.ok) return { active: [], recent: [] };
		return (await response.json()) as StoredParseQueueSnapshot;
	}

	function githubHeaders(): HeadersInit {
		const headers: Record<string, string> = {
			accept: 'application/vnd.github+json',
			'user-agent': USER_AGENT,
			'x-github-api-version': GITHUB_API_VERSION,
		};
		if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
		return headers;
	}

	function workflowRunToActiveRun(run: GitHubWorkflowRun): ActiveParseRun | null {
		if (!run.id || !run.html_url || !run.created_at || !run.updated_at) return null;
		return {
			id: String(run.id),
			title: run.display_title || run.name || 'parse',
			status: run.status ?? 'unknown',
			event: run.event ?? 'workflow',
			branch: run.head_branch,
			url: run.html_url,
			createdAt: run.created_at,
			updatedAt: run.updated_at,
		};
	}

	async function listActiveGitHubParseRuns(limit: number): Promise<ActiveParseRun[]> {
		const repo = env.GITHUB_REPO;
		if (!repo) return [];
		const workflowFile = env.GITHUB_WORKFLOW_FILE ?? DEFAULT_GITHUB_WORKFLOW_FILE;
		const runs = await Promise.all(
			ACTIVE_GITHUB_RUN_STATUSES.map(async (status) => {
				const url = new URL(
					`https://api.github.com/repos/${repo}/actions/workflows/${workflowFile}/runs`,
				);
				url.searchParams.set('status', status);
				url.searchParams.set('per_page', String(Math.max(1, Math.min(limit, 20))));
				const response = await fetch(url, { headers: githubHeaders() });
				if (!response.ok) {
					log.warn`GitHub workflow run lookup failed status=${status} code=${String(response.status)}`;
					return [];
				}
				const body = (await response.json()) as GitHubWorkflowRunsResponse;
				return (body.workflow_runs ?? [])
					.map(workflowRunToActiveRun)
					.filter((run): run is ActiveParseRun => run !== null);
			}),
		);
		const byId = new Map<string, ActiveParseRun>();
		for (const run of runs.flat()) byId.set(run.id, run);
		return [...byId.values()]
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
			.slice(0, Math.max(1, Math.min(limit, 20)));
	}

	async function loadGitHubRepository(): Promise<GitHubRepositoryResponse | null> {
		const repo = env.GITHUB_REPO;
		if (!repo) return null;
		const response = await fetch(`https://api.github.com/repos/${repo}`, {
			headers: githubHeaders(),
		});
		if (!response.ok) {
			log.warn`GitHub repository lookup failed code=${String(response.status)}`;
			return null;
		}
		return (await response.json()) as GitHubRepositoryResponse;
	}

	function emptyBillingSummary(
		owner: string,
		accountType: GitHubActionsBillingSummary['accountType'],
		error?: string,
	): GitHubActionsBillingSummary {
		return {
			available: false,
			owner,
			accountType,
			totalMinutesUsed: null,
			totalPaidMinutesUsed: null,
			error,
		};
	}

	function unmeteredBillingSummary(
		owner: string,
		accountType: GitHubActionsBillingSummary['accountType'],
	): GitHubActionsBillingSummary {
		return {
			available: true,
			owner,
			accountType,
			totalMinutesUsed: null,
			totalPaidMinutesUsed: null,
		};
	}

	function actionsBillingUsageUrl(
		owner: string,
		accountType: GitHubActionsBillingSummary['accountType'],
	): string {
		const path =
			accountType === 'Organization'
				? `/organizations/${owner}/settings/billing/usage/summary`
				: `/users/${owner}/settings/billing/usage/summary`;
		const url = new URL(`https://api.github.com${path}`);
		url.searchParams.set('product', 'Actions');
		if (env.GITHUB_REPO) url.searchParams.set('repository', env.GITHUB_REPO);
		return url.toString();
	}

	async function loadGitHubActionsBilling(
		repository: GitHubRepositoryResponse | null,
	): Promise<GitHubActionsBillingSummary> {
		const owner = repository?.owner?.login ?? env.GITHUB_REPO?.split('/')[0] ?? '';
		const ownerType =
			repository?.owner?.type === 'Organization'
				? 'Organization'
				: repository?.owner?.type === 'User'
					? 'User'
					: 'unknown';
		if (!owner) return emptyBillingSummary('', 'unknown', 'GITHUB_REPO is not configured');
		if (!env.GITHUB_TOKEN)
			return emptyBillingSummary(owner, ownerType, 'GITHUB_TOKEN is not configured');

		const response = await fetch(actionsBillingUsageUrl(owner, ownerType), {
			headers: githubHeaders(),
		});
		if (!response.ok) {
			return emptyBillingSummary(
				owner,
				ownerType,
				`GitHub billing usage unavailable: ${response.status} ${response.statusText}`,
			);
		}
		const body = (await response.json()) as GitHubBillingUsageSummaryResponse;
		return {
			available: true,
			owner,
			accountType: ownerType,
			totalMinutesUsed: totalGrossActionsMinutes(body),
			totalPaidMinutesUsed: totalBillableActionsMinutes(body),
		};
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

	async function estimateParseWorkflowMinutesThisMonth(): Promise<number | null> {
		const repo = env.GITHUB_REPO;
		if (!repo) return null;
		const workflowFile = env.GITHUB_WORKFLOW_FILE ?? DEFAULT_GITHUB_WORKFLOW_FILE;
		const startedAt = monthStartIso();
		let total = 0;
		let loaded = 0;
		const nowMs = Date.now();
		for (let page = 1; page <= 5; page += 1) {
			const url = new URL(
				`https://api.github.com/repos/${repo}/actions/workflows/${workflowFile}/runs`,
			);
			url.searchParams.set('created', `>=${startedAt}`);
			url.searchParams.set('per_page', '100');
			url.searchParams.set('page', String(page));
			const response = await fetch(url, { headers: githubHeaders() });
			if (!response.ok) {
				log.warn`GitHub monthly workflow usage lookup failed code=${String(response.status)}`;
				return null;
			}
			const body = (await response.json()) as GitHubWorkflowRunsResponse;
			const runs = body.workflow_runs ?? [];
			loaded += runs.length;
			for (const run of runs) total += workflowRunDurationMinutes(run, nowMs);
			if (runs.length < 100) break;
		}
		return loaded > 0 ? total : 0;
	}

	async function buildParseQueueSnapshot(limit: number): Promise<ParseQueueSnapshot> {
		const boundedLimit = Math.max(1, Math.min(limit, 100));
		const [queue, activeRuns] = await Promise.all([
			readHostedQueue(boundedLimit),
			listActiveGitHubParseRuns(boundedLimit).catch((err) => {
				log.warn`active GitHub parse run load failed: ${String(err)}`;
				return [];
			}),
		]);
		const planned = await loadLatestPlannedRun(boundedLimit, queueStatusKeys(queue)).catch(
			(err) => {
				log.warn`planned parse run load failed: ${String(err)}`;
				return null;
			},
		);
		return {
			active: queue.active.map((entry, index) => storedStatusToQueueEntry(entry, index + 1)),
			activeRuns,
			recent: queue.recent.map((entry) => storedStatusToQueueEntry(entry)),
			planned,
		};
	}

	async function buildParseAllowance(queue: ParseQueueSnapshot): Promise<ParseQueueAllowance> {
		const activeTarget = parsePositiveInteger(
			env.PLAN_DRAIN_ACTIVE_TARGET,
			DEFAULT_PLAN_DRAIN_ACTIVE_TARGET,
		);
		const batchSize = parsePositiveInteger(
			env.PLAN_DRAIN_BATCH_SIZE,
			DEFAULT_PLAN_DRAIN_BATCH_SIZE,
		);
		const repoUsageTargetPercent = parsePositiveNumber(
			env.GITHUB_ACTIONS_REPO_USAGE_TARGET_PERCENT,
			DEFAULT_GITHUB_ACTIONS_REPO_USAGE_TARGET_PERCENT,
		);
		const trackedActiveCount = queue.active.length;
		const githubActiveRunCount = queue.activeRuns.length;
		const actionsInUse = Math.max(trackedActiveCount, githubActiveRunCount);
		const availableSlots = Math.max(0, activeTarget - actionsInUse);
		const [repository, estimatedRepoMinutesThisMonth] = await Promise.all([
			loadGitHubRepository().catch(() => null),
			estimateParseWorkflowMinutesThisMonth().catch(() => null),
		]);
		const repoPrivate = typeof repository?.private === 'boolean' ? repository.private : null;
		const standardRunnerMinutesMetered = repoPrivate === null ? null : repoPrivate;
		const loadedBilling = await loadGitHubActionsBilling(repository).catch((err) =>
			emptyBillingSummary(
				repository?.owner?.login ?? env.GITHUB_REPO?.split('/')[0] ?? '',
				repository?.owner?.type === 'Organization'
					? 'Organization'
					: repository?.owner?.type === 'User'
						? 'User'
						: 'unknown',
				errorMessage(err),
			),
		);
		const billing =
			standardRunnerMinutesMetered === false && !loadedBilling.available
				? unmeteredBillingSummary(
						repository?.owner?.login ?? env.GITHUB_REPO?.split('/')[0] ?? '',
						repository?.owner?.type === 'Organization'
							? 'Organization'
							: repository?.owner?.type === 'User'
								? 'User'
								: 'unknown',
					)
				: loadedBilling;
		return {
			repo: repository?.full_name ?? env.GITHUB_REPO ?? null,
			workflowFile: env.GITHUB_WORKFLOW_FILE ?? DEFAULT_GITHUB_WORKFLOW_FILE,
			activeTarget,
			batchSize,
			trackedActiveCount,
			githubActiveRunCount,
			actionsInUse,
			availableSlots,
			repoUsageTargetPercent,
			repoPrivate,
			standardRunnerMinutesMetered,
			monthStartedAt: monthStartIso(),
			estimatedRepoMinutesThisMonth,
			billing,
		};
	}

	async function recordHostedParseEvent(event: ParseStatusEvent): Promise<void> {
		if (!env.PARSE_STATUS) return;
		const response = await parseStatusObject(env.PARSE_STATUS).fetch('https://status/event', {
			method: 'POST',
			headers: { 'content-type': 'application/json; charset=utf-8' },
			body: JSON.stringify(event),
		});
		if (!response.ok) {
			throw new Error(`parse status update failed: ${response.status}`);
		}
	}

	function storedStatusToQueueEntry(stored: StoredParseStatus, position?: number): ParseQueueEntry {
		return {
			kind: stored.kind,
			name: stored.name,
			version: stored.version,
			status: stored.status,
			step: stored.step,
			error: stored.error,
			requestId: stored.requestId,
			workflowId: stored.workflowId,
			githubRunId: stored.githubRunId,
			githubRunUrl: stored.githubRunUrl,
			requestedBy: stored.requestedBy,
			requestedAt: stored.createdAt,
			updatedAt: stored.updatedAt,
			position,
		};
	}

	function planItemKey(kind: string, name: string, version: string): string {
		return `${kind}:${name}:${version}`;
	}

	function queueStatusKeys(queue: StoredParseQueueSnapshot): Set<string> {
		const keys = new Set<string>();
		for (const entry of [...queue.active, ...queue.recent]) {
			keys.add(planItemKey(entry.kind, entry.name, entry.version));
		}
		return keys;
	}

	function planItemFromArtifact(
		item: NonNullable<WorkPlanArtifact['work']>[number],
	): PlannedParseItem | null {
		if (!item.name || !item.version) return null;
		const kind = item.kind === 'std' || item.kind === 'sysroot' ? 'sysroot' : 'crate';
		return {
			kind,
			name: item.name,
			version: item.version,
			channel: item.channel ?? 'default',
			priorityTier: item.priority_tier ?? item.priorityTier ?? 'unknown',
			reason: item.reason ?? '',
			downloadRank: item.download_rank ?? item.downloadRank,
			workId: item.work_id ?? item.workId ?? `${kind}:${item.name}:${item.version}`,
		};
	}

	function planFromArtifact(
		plan: WorkPlanArtifact,
		limit: number,
		excludedKeys = new Set<string>(),
	): PlannedParseRun | null {
		const runId = plan.run_id ?? plan.runId;
		const generatedAt = plan.generated_at ?? plan.generatedAt;
		if (!runId || !generatedAt) return null;
		const work = Array.isArray(plan.work) ? plan.work : [];
		const items = work
			.map(planItemFromArtifact)
			.filter((entry): entry is PlannedParseItem => entry !== null)
			.filter((entry) => !excludedKeys.has(planItemKey(entry.kind, entry.name, entry.version)));
		return {
			runId,
			generatedAt,
			mode: plan.mode ?? 'unknown',
			shardCount: plan.shard_count ?? plan.shardCount ?? 0,
			total: items.length,
			items: items.slice(0, Math.max(1, limit)),
		};
	}

	async function listPlanKeys(maxKeys = 5000): Promise<PlanKeyCandidate[]> {
		const candidates: PlanKeyCandidate[] = [];
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

	async function loadLatestPlannedRun(
		limit: number,
		excludedKeys = new Set<string>(),
	): Promise<PlannedParseRun | null> {
		const plans = await Promise.all(
			(await listPlanKeys()).slice(0, 25).map(async ({ key }) => {
				const raw = await readJson<WorkPlanArtifact>(key);
				return raw ? planFromArtifact(raw, limit, excludedKeys) : null;
			}),
		);
		return (
			plans
				.filter((plan): plan is PlannedParseRun => plan !== null)
				.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0] ?? null
		);
	}

	let publishedCratesCache: Promise<CrateSummaryResult[]> | null = null;
	async function listPublishedCrates(): Promise<CrateSummaryResult[]> {
		if (!publishedCratesCache) {
			publishedCratesCache = (async () => {
				const catalog = await loadCatalogArtifact();
				if (catalog) {
					return orderCatalogSummaries(catalog.crates) satisfies CrateSummaryResult[];
				}
				return [];
			})().catch((err) => {
				publishedCratesCache = null;
				log.warn`published crate catalog load failed: ${String(err)}`;
				return [];
			});
		}
		return publishedCratesCache;
	}

	return {
		async loadSourceFile(
			relativePath: string,
			crateName?: string,
			crateVersion?: string,
			sourceProvider: SourceProviderMode = 'auto',
		) {
			if (!crateName || !crateVersion) {
				return {
					error: 'Source file not available',
					content: null,
					absolutePath: null,
					repoUrl: null,
				};
			}

			const cacheKey = sourceCacheKey(crateName, crateVersion, relativePath, sourceProvider);
			const cachedContent = getCachedSourceFile(cacheKey);
			if (cachedContent !== null) {
				return { error: null, content: cachedContent, absolutePath: null, repoUrl: null };
			}

			// ── Std fast-path ─────────────────────────────────────────
			// std/core/alloc/proc_macro/test aren't on crates.io. Their
			// sources live in rust-lang/rust under `library/{crate}/...`.
			// rustdoc spans already use that form, so we just point at
			// the right git ref and stream the file.
			if (isStdCrate(normalizeCrateName(crateName))) {
				const result = await fetchStdSourceFile(
					relativePath,
					crateVersion,
					SOURCE_MAX_BYTES,
					USER_AGENT,
				);
				if ('content' in result) {
					setCachedSourceFile(cacheKey, result.content);
					return {
						error: null,
						content: result.content,
						absolutePath: null,
						repoUrl: result.blobUrl,
					};
				}
				return { error: result.error, content: null, absolutePath: null, repoUrl: result.blobUrl };
			}

			const sourceAdapterResult = getSourceAdapter('rust');
			if (sourceAdapterResult.isErr()) {
				return {
					error: sourceAdapterResult.error.message,
					content: null,
					absolutePath: null,
					repoUrl: null,
				};
			}

			const registryResult = getRegistry('rust');
			if (registryResult.isErr()) {
				return {
					error: registryResult.error.message,
					content: null,
					absolutePath: null,
					repoUrl: null,
				};
			}

			let metadata: Awaited<ReturnType<typeof registryResult.value.resolve>> | null = null;
			for (const variant of crateNameVariants(crateName)) {
				const resolved = await registryResult.value.resolve(variant, crateVersion);
				if (resolved) {
					metadata = resolved;
					break;
				}
			}
			if (!metadata) {
				return {
					error: 'Source metadata unavailable',
					content: null,
					absolutePath: null,
					repoUrl: null,
				};
			}

			const repoUrl = buildGitHubFileUrl(metadata, relativePath);

			if (
				(sourceProvider === 'auto' || sourceProvider === 'crates-io') &&
				metadata.sourceArchiveUrl
			) {
				const direct = await fetchSourceFileFromArchive(metadata.sourceArchiveUrl, relativePath, {
					maxBytes: SOURCE_MAX_BYTES,
					userAgent: USER_AGENT,
				});
				if (direct.status === 'ok') {
					setCachedSourceFile(cacheKey, direct.content);
					return { error: null, content: direct.content, absolutePath: null, repoUrl };
				}
				if (sourceProvider === 'crates-io') {
					return {
						error: direct.status === 'error' ? direct.message : 'Source file not available',
						content: null,
						absolutePath: null,
						repoUrl: null,
					};
				}
			}

			const providers = sourceAdapterResult.value.getProviders({
				ecosystem: 'rust',
				name: metadata.name,
				version: metadata.version,
				metadata,
			});
			const selectedProviders = source.selectProviders(providers, sourceProvider);
			const files = await fetchSourcesWithProviders(
				selectedProviders,
				{ ecosystem: 'rust', name: metadata.name, version: metadata.version, metadata },
				{
					maxBytes: SOURCE_MAX_BYTES,
					userAgent: USER_AGENT,
					githubToken: env.GITHUB_TOKEN,
				},
			);
			if (!files) {
				return {
					error: 'Source file not available',
					content: null,
					absolutePath: null,
					repoUrl: null,
				};
			}

			const content = source.resolveFromMap(files, relativePath);
			if (content === null) {
				return { error: 'File not found', content: null, absolutePath: null, repoUrl };
			}
			setCachedSourceFile(cacheKey, content);
			return { error: null, content, absolutePath: null, repoUrl };
		},

		async loadCrateGraph(name: string, version: string): Promise<CrateGraph | null> {
			return null;
		},

		async loadTreeMeta(name: string, version: string) {
			const meta = await loadHostedMetaArtifact(name, version);
			return meta ? { kindCounts: meta.kindCounts, roots: meta.roots } : null;
		},

		async loadTreeRootsDirect(name: string, version: string): Promise<TreeNodeDTO[] | null> {
			return (await loadHostedMetaArtifact(name, version))?.roots ?? [];
		},

		async loadTreeChildrenDirect(
			name: string,
			version: string,
			parentId: string,
		): Promise<TreeNodeDTO[] | null> {
			const context = await loadHostedContext(name, version);
			if (!context) return [];
			const rootChildren = context.meta.rootChildren[parentId];
			if (rootChildren !== undefined) return rootChildren;
			return (await loadHostedTreeChildrenFromContext(context, parentId)) ?? [];
		},

		async loadTreeAncestorsDirect(
			name: string,
			version: string,
			nodeId: string,
		): Promise<NodeSummary[] | null> {
			const view = await loadNodeView(name, version, nodeId);
			return view?.ancestors ?? [];
		},

		async loadCrateTree(name: string, version: string): Promise<CrateTree | null> {
			return null;
		},

		async loadCrateIndex(name: string, version: string): Promise<CrateIndex | null> {
			return (await loadHostedMetaArtifact(name, version))?.index ?? null;
		},

		async loadNodeViewDirect(
			name: string,
			version: string,
			nodeId: string,
		): Promise<NodeViewBase | null> {
			return loadNodeView(name, version, nodeId);
		},

		async loadNodeDetail(
			name: string,
			version: string,
			nodeId: string,
		): Promise<NodeDetail | null> {
			const view = await loadNodeView(name, version, nodeId);
			return view?.detail ?? null;
		},

		async loadCrateMap(
			name: string,
			version: string,
			options?: CrateMapOptions,
		): Promise<CrateMapData | null> {
			const context = await loadHostedContext(name, version);
			if (!context) return null;
			return readArtifactJson<CrateMapData>(context.ref, 'crate-map.json');
		},

		async getCrossEdgeData(_nodeId: string): Promise<CrossEdgeData> {
			return { edges: [], nodes: [] };
		},

		async searchNodesDirect(
			crateName: string,
			crateVersion: string,
			queryText: string,
			limit = 200,
			kinds: NodeKind[] = [],
		): Promise<NodeSummary[] | null> {
			const context = await loadHostedContext(crateName, crateVersion);
			if (!context) return [];
			const kindSet = new Set<NodeKind>(kinds);
			const needle = queryText.trim().toLowerCase();
			if (!needle) {
				return (
					(await filterNodesFromKindIndex(context.ref, context.meta, kindSet, limit)) ??
					filterNodesFromShards(context.ref, kindSet, limit)
				);
			}
			const manifest = await loadHostedSearchManifestFromRef(context.ref);
			if (!manifest) return [];
			const queryP = searchPrefix(needle);
			const prefixes = manifest.prefixes.filter((prefix) => prefix.startsWith(queryP));
			const entries: NodeSummary[] = [];
			for (const prefix of prefixes.slice(0, 64)) {
				const shard = await loadHostedSearchShardFromRef(context.ref, prefix);
				if (shard) entries.push(...shard.entries);
			}
			return searchSummaries(entries, queryText, limit, kindSet);
		},

		async getCrateStatus(name: string, version: string) {
			if (!isValidCrateName(name) || !isValidVersion(version)) {
				return { status: 'failed' as const, error: 'Invalid crate name or version' };
			}
			const ref = await resolveRefForArtifact(name, version);
			if (ref) {
				const meta = await readArtifactJson<HostedMetaArtifact>(ref, 'site/meta.json');
				if (meta?.schema_version === 1 && meta.index) return { status: 'ready' as const };
			}
			const hostedStatus = await readHostedParseStatus(name, version);
			if (hostedStatus) return storedStatusToCrateStatus(hostedStatus);
			return {
				status: 'failed' as const,
				error: `No static graph is published for ${name}@${version}.`,
				action: 'docs_unavailable' as const,
			};
		},

		async triggerParse(name: string, version: string, force?: boolean) {
			if (!isValidCrateName(name) || !isValidVersion(version)) {
				return Result.err(new ValidationError({ message: 'Invalid crate name or version' }));
			}
			const normalizedName = normalizeCrateName(name);
			const requestKind = isStdCrate(normalizedName) ? 'sysroot' : 'crate';
			const requestedVersion =
				requestKind === 'sysroot' && version === 'latest' ? 'stable' : version;
			if (force) {
				const authContext = await resolveParseRequestContext({ rateLimit: false });
				if (!authContext.auth?.isAdmin) {
					return Result.err(
						new NotAvailableError({
							message: 'Force parse requires admin access',
						}),
					);
				}
			}
			if (!force) {
				const ref = await resolveRefForArtifact(name, requestedVersion);
				if (ref) {
					const meta = await readArtifactJson<HostedMetaArtifact>(ref, 'site/meta.json');
					if (meta?.schema_version === 1 && meta.index) return Result.ok(undefined);
				}
			}
			const parseContext = await resolveParseRequestContext({ rateLimit: true });
			if (parseContext.configError) return Result.err(parseContext.configError);
			if (parseContext.rateLimitError) return Result.err(parseContext.rateLimitError);
			if (!env.PARSE_REQUESTS) {
				return Result.err(
					new NotAvailableError({
						message: 'Hosted parse queue is not configured',
					}),
				);
			}
			const parseRequest = makeParseRequest(
				name,
				requestedVersion,
				!!force,
				'ui',
				requestKind,
				parseContext.actor,
			);
			const workflowId = parseWorkflowId(parseRequest.requestId);
			await recordHostedParseEvent({
				kind: parseRequest.kind,
				name: parseRequest.name,
				version: parseRequest.version,
				status: 'processing',
				step: 'queued',
				requestId: parseRequest.requestId,
				workflowId,
				requestedBy: parseRequest.requestedBy,
			}).catch((err) => {
				log.warn`parse ledger queue write failed for ${name}@${version}: ${String(err)}`;
			});
			try {
				await env.PARSE_REQUESTS.send(parseRequest);
			} catch (err) {
				await recordHostedParseEvent({
					kind: parseRequest.kind,
					name: parseRequest.name,
					version: parseRequest.version,
					status: 'failed',
					step: 'queue-send',
					error: errorMessage(err),
					requestId: parseRequest.requestId,
					workflowId,
				}).catch(() => {});
				return Result.err(
					new NotAvailableError({
						message: `Hosted parse queue send failed: ${errorMessage(err)}`,
					}),
				);
			}
			return Result.ok(undefined);
		},

		async triggerStdInstall(_name: string, _version: string) {
			return Result.err(
				new NotAvailableError({
					message: 'std crate installation is not available in hosted mode',
				}),
			);
		},

		async searchRegistry(query: string) {
			const needle = query.trim().toLowerCase();
			if (!needle) return [];
			const registryResult = getRegistry('rust');
			if (!registryResult.isErr()) {
				const live = await registryResult.value.search(needle, 20);
				if (live.length > 0) return live.map(registrySummary);
			}
			const crates = await listPublishedCrates();
			return crates
				.map((crate) => {
					const name = crate.name.toLowerCase();
					const id = (crate.id ?? crate.name).toLowerCase();
					const description = crate.description?.toLowerCase() ?? '';
					if (name === needle || id === needle) return { crate, score: 0 };
					if (name.startsWith(needle) || id.startsWith(needle)) return { crate, score: 1 };
					if (name.includes(needle) || id.includes(needle)) return { crate, score: 2 };
					if (description.includes(needle)) return { crate, score: 3 };
					return null;
				})
				.filter((entry): entry is { crate: CrateSummaryResult; score: number } => entry !== null)
				.sort(
					(a, b) =>
						a.score - b.score ||
						a.crate.name.localeCompare(b.crate.name, undefined, { sensitivity: 'base' }),
				)
				.slice(0, 20)
				.map((entry) => entry.crate);
		},

		async getTopCrates(limit = 10) {
			const registryResult = getRegistry('rust');
			if (!registryResult.isErr()) {
				const live = await registryResult.value.listTop(limit);
				if (live.length > 0) return live.map(registrySummary);
			}
			return (await listPublishedCrates()).slice(0, limit);
		},

		async getProcessingCrates(limit = 20) {
			return (await listHostedProcessing(limit)).map((entry) => ({
				id: hyphenateCrateName(entry.name),
				name: entry.name,
				version: entry.version,
				description: entry.step ?? 'Parsing',
			}));
		},

		async getParseQueue(limit = 50): Promise<ParseQueueSnapshot> {
			return buildParseQueueSnapshot(limit);
		},

		async getAdminDashboard(limit = 100): Promise<AdminDashboardData> {
			const queue = await buildParseQueueSnapshot(limit);
			const allowance = await buildParseAllowance(queue);
			return { queue, allowance };
		},

		async getCrateVersions(name: string, limit = 20): Promise<string[]> {
			return listPublishedVersions(name, limit);
		},

		async resolveVersion(name: string, version: string): Promise<string> {
			if (version === 'latest' && isStdCrate(normalizeCrateName(name))) return 'stable';
			const ref = await resolveRefForArtifact(name, version);
			return ref?.version ?? version;
		},
	};
}

/** Build-time entry point imported through the `$provider` alias. */
export function createProvider(event: RequestEvent): DataProvider {
	const env = (event.platform as { env: AppEnv }).env;
	return createCloudflareProvider(env, event.request);
}

/** Hosted mode uses the parser status Durable Object for realtime parse/status events. */
export function handleWsUpgrade(event?: RequestEvent): Response | Promise<Response> {
	if (!event)
		return new Response('Hosted realtime status requires a request event', { status: 500 });
	const env = (event?.platform as { env?: AppEnv } | undefined)?.env;
	if (!env?.PARSE_STATUS) {
		return new Response('Hosted realtime status is not configured', { status: 503 });
	}
	return parseStatusObject(env.PARSE_STATUS).fetch(event.request);
}
