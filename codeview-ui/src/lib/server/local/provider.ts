import { Result } from 'better-result';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { RequestEvent } from '@sveltejs/kit';
import type {
	Workspace,
	CrateGraph,
	Confidence,
	EdgeKind,
	NodeKind,
	Visibility,
	Node,
	Edge,
} from '$lib/graph';
import type { CrateIndex, CrateTree, NodeDetail, NodeSummary, TreeNodeDTO } from '$lib/schema';
import { buildCrateMapData, type CrateMapData, type CrateMapOptions } from '$lib/graph/crate-map';
import { parseWorkspace } from '$lib/schema';
import { isStdCrate, STD_JSON_CRATES } from '$lib/std';
import { getLogger } from '$lib/log';
import { perf } from '$lib/perf';
import { decodeGzipStream } from '$lib/server/gzip';
import { summarizeCrossEdgeNode, type CrossEdgeNodeSummary } from '$lib/server/cross-edges';
import { createCratesIoAdapter } from '../registry/cratesio';
import { getRegistry } from '../registry/index';
import { parseWithRustBinary, type ParseProgress } from '../parsing/parse-rustdoc';
import { fetchSourceFileFromArchive } from '../parser/archive';
import { getSourceAdapter } from '../sources/index';
import { fetchSourcesWithProviders } from '../sources/runner';
import type {
	CrossEdgeData,
	DataProvider,
	LocalWorkspaceProvider,
	CrateStatus,
	CrateSummaryResult,
} from '../provider';
import { ValidationError, NotAvailableError } from '../errors';
import {
	isValidCrateName,
	isValidVersion,
	normalizeCrateName,
	hyphenateCrateName,
	crateNameVariants,
} from '../validation';
import { emit, broadcastProgress, createHandlers, type LocalProviderInternals } from './ws';
import {
	USER_AGENT,
	SOURCE_MAX_BYTES,
	statusAction,
	source,
	fetchStdSourceFile,
	type SourceProviderMode,
} from '../provider-utils';
import { LocalCache } from './cache';
import { WorkflowEntrypoint, runWorkflow } from './workflow';
import type { WorkflowStep, WorkflowEvent } from './workflow';
import { findStdJson, installStdDocs, detectSysroot } from './sysroot';

const log = getLogger('local');

const VERSION_LOOKUP_CONCURRENCY = 6;

/** Convert a full Node to a NodeSummary (drop heavy fields like docs/source). */
function nodeToSummary(n: Node): NodeSummary {
	return {
		id: n.id,
		name: n.name,
		kind: n.kind,
		visibility: n.visibility,
		is_external: n.is_external,
		is_deprecated: n.is_deprecated,
		...(n.kind === 'Impl'
			? {
					impl_trait: n.impl_trait,
					impl_category: n.impl_category,
					generics: n.generics,
				}
			: {}),
	};
}

/** Build a GitHub file URL from a repository URL, version, and file path. */
function buildGitHubFileUrl(
	repositoryUrl: string | undefined,
	version: string,
	filePath: string,
): string | null {
	if (!repositoryUrl) return null;
	try {
		const url = new URL(repositoryUrl);
		if (!url.hostname.includes('github.com')) return null;
		const path = url.pathname.replace(/\.git$/, '').replace(/\/+$/, '');
		const normalizedFile = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
		return `https://github.com${path}/blob/v${version}/${normalizedFile}`;
	} catch {
		return null;
	}
}

type CrateIndexEntry = {
	id: string;
	name: string;
	version: string;
	is_external?: boolean;
};

type WorkspaceCrate = Workspace['crates'][number];

function sameCrateName(left: string, right: string): boolean {
	return normalizeCrateName(left) === normalizeCrateName(right);
}

function findWorkspaceCrate(
	workspace: Workspace | null,
	name: string,
	version?: string,
): WorkspaceCrate | null {
	if (!workspace) return null;
	return (
		workspace.crates.find((crate) => {
			const nameMatches = sameCrateName(crate.id, name) || sameCrateName(crate.name, name);
			const versionMatches =
				version === undefined || version === 'latest' || crate.version === version;
			return nameMatches && versionMatches;
		}) ?? null
	);
}

function findCrateIndexEntry(crates: CrateIndexEntry[], name: string): CrateIndexEntry | null {
	return (
		crates.find((crate) => sameCrateName(crate.id, name) || sameCrateName(crate.name, name)) ?? null
	);
}

async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	if (items.length === 0) return [];
	const results: R[] = new Array(items.length);
	let nextIndex = 0;

	async function runWorker() {
		while (nextIndex < items.length) {
			const current = nextIndex;
			nextIndex += 1;
			results[current] = await fn(items[current]);
		}
	}

	const workers = Array.from({ length: Math.min(limit, items.length) }, () => runWorker());
	await Promise.all(workers);
	return results;
}

let providerInternals: LocalProviderInternals | null = null;

/** Expose internals for Vite dev plugin (WS upgrades bypass SvelteKit routes in dev). */
export function getProviderInternals(): LocalProviderInternals | null {
	return providerInternals;
}

export function createLocalProvider(): DataProvider {
	let cached: Workspace | null = null;
	const registry = createCratesIoAdapter();
	const sourceFileCache = new Map<string, string>();
	const SOURCE_FILE_CACHE_MAX = 512;

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

	// Lazy-init cache to avoid bun:sqlite import at module level on CF
	let cache: LocalCache | null = null;
	let cachePromise: Promise<LocalCache> | null = null;
	async function getCache(): Promise<LocalCache> {
		if (cache) return cache;
		if (!cachePromise) {
			cachePromise = LocalCache.create()
				.then((created) => {
					cache = created;
					return created;
				})
				.finally(() => {
					cachePromise = null;
				});
		}
		return cachePromise;
	}

	// In-flight parse deduplication
	const inFlight = new Map<string, Promise<void>>();

	function parseKey(name: string, version: string): string {
		return `${normalizeCrateName(name)}:${version}`;
	}

	function startParse(name: string, version: string): void {
		const key = parseKey(name, version);
		if (inFlight.has(key)) return;
		const promise = parseCrate(name, version).finally(() => {
			inFlight.delete(key);
		});
		inFlight.set(key, promise);
	}

	async function emitStatus(
		name: string,
		version: string,
		status: CrateStatus,
		step?: string,
	): Promise<void> {
		const lc = await getCache();
		lc.setStatus(
			'rust',
			name,
			version,
			status.status as 'unknown' | 'processing' | 'ready' | 'failed',
			status.error,
			step,
		);

		const fullStatus: CrateStatus = {
			...status,
			...(step ? { step } : {}),
		};

		emit.status(name, version, fullStatus);

		const count = lc.getProcessingCount('rust');
		emit.processing('rust', { type: 'processing', count });
	}

	async function emitWorkspaceReady(
		requestedName: string,
		requestedVersion: string,
		workspaceCrate: WorkspaceCrate,
	): Promise<void> {
		const emitted = new Set<string>();
		const emitOnce = async (name: string, version: string) => {
			const key = `${name}:${version}`;
			if (emitted.has(key)) return;
			emitted.add(key);
			await emitStatus(name, version, { status: 'ready' });
		};

		await emitOnce(requestedName, requestedVersion);
		await emitOnce(workspaceCrate.name, workspaceCrate.version);
		await emitOnce(workspaceCrate.id, workspaceCrate.version);
	}

	function emitEdgeUpdate(nodeId: string): void {
		emit.edges(nodeId, { type: 'cross-edges', nodeId });
	}

	// ── Workflow-based parse pipeline ──

	type ParseCrateParams = {
		name: string;
		version: string;
	};

	class ParseCrateWorkflow extends WorkflowEntrypoint<ParseCrateParams> {
		async run(event: WorkflowEvent<ParseCrateParams>, step: WorkflowStep): Promise<void> {
			const { name, version } = event.payload;
			log.info`Parsing ${name}@${version}`;

			// check-existing: bail early if already cached
			const cached = await step.do('check-existing', async () => {
				const lc = await getCache();
				return lc.hasCrate(name, version);
			});
			if (cached) {
				await emitStatus(name, version, { status: 'ready' });
				return;
			}

			// set-status-resolving
			await step.do('set-status-resolving', async () => {
				await emitStatus(name, version, { status: 'processing' }, 'resolving');
			});

			// resolve-metadata: registry lookup
			const meta = await step.do(
				'resolve-metadata',
				{ retries: { limit: 2, delayMs: 2000, backoff: 'exponential' } },
				async () => {
					const regResult = getRegistry('rust');
					if (regResult.isErr()) throw regResult.error;
					const resolved = await regResult.value.resolve(name, version);
					if (!resolved) {
						throw new Error(`Package not found: ${name}@${version}`);
					}
					return resolved;
				},
			);
			const resolvedName = meta.name;
			const resolvedVersion = meta.version;
			const resolvedCrateName = normalizeCrateName(resolvedName);

			// set-status-fetching
			await step.do('set-status-fetching', async () => {
				log.info`Fetching rustdoc for ${resolvedName}@${resolvedVersion}`;
				await emitStatus(name, version, { status: 'processing' }, 'fetching');
			});

			// fetch-artifact: download + decompress
			const artifactResult = await step.do(
				'fetch-artifact',
				{ retries: { limit: 2, delayMs: 3000, backoff: 'exponential' } },
				async () => {
					const artifactUrl =
						meta.artifactUrl ?? `https://docs.rs/crate/${resolvedName}/${resolvedVersion}/json.gz`;
					const artifactRes = await fetch(artifactUrl, {
						headers: { 'User-Agent': USER_AGENT },
					});
					if (!artifactRes.ok) {
						throw new Error(
							`Failed to fetch artifact: ${artifactRes.status} ${artifactRes.statusText}`,
						);
					}

					const contentType = artifactRes.headers.get('content-type') ?? '';
					const contentLength = Number(artifactRes.headers.get('content-length') ?? '0');
					if (!artifactRes.body) {
						throw new Error('Artifact response has no body for streaming');
					}
					let input: ReadableStream<Uint8Array> = artifactRes.body;
					if (contentType.includes('gzip')) {
						input = decodeGzipStream(artifactRes.body);
					}
					const sizeLabel =
						contentLength > 0
							? `${(contentLength / 1024 / 1024).toFixed(1)} MB compressed`
							: 'unknown size';
					return { input, sizeLabel };
				},
			);
			log.info`Fetched ${resolvedName}@${resolvedVersion}: ${artifactResult.sizeLabel}`;

			// Track cross-edge data during parsing (for both paths)
			const crossEdgesList: Edge[] = [];
			const crossNodeMap = new Map<string, CrossEdgeNodeSummary>();
			const externalCratesFound: Array<{ id: string; name: string }> = [];

			function cratePrefix(id: string): string {
				return id.split('::')[0] ?? id;
			}
			const isExternalNode = (id: string): boolean => cratePrefix(id) !== resolvedCrateName;

			// parse-rustdoc: parse JSON → graph with progressive storage
			const parseResult = await step.do(
				'parse-rustdoc',
				{ retries: { limit: 1, delayMs: 1000, backoff: 'linear' } },
				async () => {
					log.info`Parsing rustdoc for ${resolvedName}@${resolvedVersion}`;
					await emitStatus(name, version, { status: 'processing' }, 'parsing');
					const t0 = performance.now();

					// Fetch sources in parallel with parsing to avoid blocking progress.
					log.info`Fetching sources for ${resolvedName}@${resolvedVersion}`;
					const sourceAdapterResult = getSourceAdapter('rust');
					if (sourceAdapterResult.isErr()) throw sourceAdapterResult.error;
					const sourceAdapter = sourceAdapterResult.value;
					const providers = sourceAdapter.getProviders({
						ecosystem: 'rust',
						name: resolvedName,
						version: resolvedVersion,
						metadata: meta,
					});
					const sourceFilesPromise = fetchSourcesWithProviders(
						providers,
						{ ecosystem: 'rust', name: resolvedName, version: resolvedVersion, metadata: meta },
						{ maxBytes: SOURCE_MAX_BYTES, userAgent: USER_AGENT },
					).catch((err) => {
						log.warn`Sources fetch failed for ${resolvedName}@${resolvedVersion}: ${String(err)}`;
						return null;
					});

					const lc = await getCache();

					// Initialize crate entry (will be finalized after parsing)
					const tempIndex: CrateIndex = {
						name: resolvedName,
						version: resolvedVersion,
						crates: [],
					};
					lc.initCrate(resolvedName, resolvedVersion, tempIndex);

					// Track node summaries for cross-edge detection
					const nodeSummaries = new Map<string, CrossEdgeNodeSummary>();

					const result = await parseWithRustBinary(
						artifactResult.input,
						resolvedName,
						{
							storeNodes: (nodes) => {
								// Store to DB
								lc.insertNodes(resolvedName, resolvedVersion, nodes);
								// Track summaries for cross-edge detection
								for (const node of nodes) {
									nodeSummaries.set(node.id, {
										id: node.id,
										name: node.name,
										kind: node.kind,
										visibility: node.visibility,
										is_external: node.is_external,
									});
								}
							},
							storeEdges: (edges) => {
								// Store to DB
								lc.insertEdges(resolvedName, resolvedVersion, edges);
								// Track cross-crate edges
								for (const edge of edges) {
									if (cratePrefix(edge.from) !== cratePrefix(edge.to)) {
										crossEdgesList.push(edge);
										const fromNode =
											nodeSummaries.get(edge.from) ??
											summarizeCrossEdgeNode(edge.from, isExternalNode(edge.from)).unwrapOr(null);
										const toNode =
											nodeSummaries.get(edge.to) ??
											summarizeCrossEdgeNode(edge.to, isExternalNode(edge.to)).unwrapOr(null);
										if (fromNode) crossNodeMap.set(fromNode.id, fromNode);
										if (toNode) crossNodeMap.set(toNode.id, toNode);
									}
								}
							},
						},
						{
							onProgress: (progress) => {
								broadcastProgress('rust', name, version, progress);
							},
							onFinalizingStart: () => {
								void emitStatus(name, version, { status: 'processing' }, 'finalizing');
							},
						},
					);

					await emitStatus(name, version, { status: 'processing' }, 'storing');

					// Finalize crate with tree (orphan-filtered by adapter)
					log.info`Finalize tree ${resolvedName}@${resolvedVersion}: ${result.tree.nodes.length}n ${result.tree.edges.length}e`;
					lc.finalizeCrate(
						resolvedName,
						resolvedVersion,
						result.tree,
						result.nodeCount,
						result.edgeCount,
					);

					// Collect external crates
					externalCratesFound.push(...result.externalCrates);

					const sourceFiles = await sourceFilesPromise;
					log.info`Sources for ${resolvedName}@${resolvedVersion}: ${sourceFiles ? sourceFiles.size + ' files' : 'none'}`;

					log.info`Parsed ${resolvedName}@${resolvedVersion}: ${result.nodeCount} nodes, ${(performance.now() - t0).toFixed(0)}ms`;

					return {
						tree: result.tree,
						externalCrates: result.externalCrates.map((ec) => ({
							...ec,
							version: null,
							nodes: [] as Node[],
						})),
						nodeCount: result.nodeCount,
						edgeCount: result.edgeCount,
					};
				},
			);

			// set-status-indexing
			await step.do('set-status-indexing', async () => {
				await emitStatus(name, version, { status: 'processing' }, 'indexing');
			});

			// index-cross-edges: resolve external crate versions
			const index = await step.do(
				'index-cross-edges',
				{ retries: { limit: 1, delayMs: 1000, backoff: 'linear' } },
				async () => {
					const regResult2 = getRegistry('rust');
					if (regResult2.isErr()) throw regResult2.error;
					const reg = regResult2.value;
					const latestCacheLocal = new Map<string, string | null>();

					async function getLatestVersionLocal(candidate: string): Promise<string | null> {
						if (latestCacheLocal.has(candidate)) return latestCacheLocal.get(candidate)!;
						const resolved = await reg.getLatestVersion(candidate);
						latestCacheLocal.set(candidate, resolved);
						return resolved;
					}

					async function resolveExternalEntry(ext: {
						id: string;
						name: string;
					}): Promise<CrateIndexEntry | null> {
						const candidates = [
							...crateNameVariants(ext.name),
							...crateNameVariants(ext.id),
						].filter((value, idx, all) => value && all.indexOf(value) === idx);

						for (const candidate of candidates) {
							const latest = await getLatestVersionLocal(candidate);
							if (latest) {
								return { id: ext.id, name: candidate, version: latest, is_external: true };
							}
						}
						return null;
					}

					const seenExternal = new Set<string>();
					const uniqueExternal: { id: string; name: string }[] = [];
					for (const c of externalCratesFound) {
						if (seenExternal.has(c.id)) continue;
						seenExternal.add(c.id);
						if (isStdCrate(c.name) || isStdCrate(c.id)) continue;
						uniqueExternal.push(c);
					}

					const externalEntries = await mapWithConcurrency(
						uniqueExternal,
						VERSION_LOOKUP_CONCURRENCY,
						resolveExternalEntry,
					);
					const filteredExternal = externalEntries.filter((e): e is CrateIndexEntry => e !== null);

					return {
						name: resolvedName,
						version: resolvedVersion,
						crates: [
							{
								id: resolvedCrateName,
								name: resolvedName,
								version: resolvedVersion,
								is_external: false,
							},
							...filteredExternal,
						],
					} satisfies CrateIndex;
				},
			);

			// store-graph: finalize progressive storage
			await step.do(
				'store-graph',
				{ retries: { limit: 2, delayMs: 1000, backoff: 'linear' } },
				async () => {
					await emitStatus(name, version, { status: 'processing' }, 'storing');
					const lc = await getCache();

					// Update index only — nodes/edges were already stored during progressive parsing.
					// Do NOT call initCrate() here: it deletes all nodes/edges.
					lc.updateIndex(resolvedName, resolvedVersion, index);
					lc.finalizeCrate(
						resolvedName,
						resolvedVersion,
						parseResult.tree,
						parseResult.nodeCount,
						parseResult.edgeCount,
					);

					// Store cross-edge index
					lc.replaceCrossEdges(
						'rust',
						resolvedName,
						resolvedVersion,
						crossEdgesList,
						Array.from(crossNodeMap.values()),
					);
				},
			);

			// fanout-dependencies: trigger parses for external crates
			await step.do('fanout-dependencies', async () => {
				const touchedNodes = new Set<string>();
				for (const edge of crossEdgesList) {
					touchedNodes.add(edge.from);
					touchedNodes.add(edge.to);
				}
				for (const nodeId of touchedNodes) {
					emitEdgeUpdate(nodeId);
				}
				log.info`Parsed and cached ${resolvedName}@${resolvedVersion}`;
			});

			// set-status-ready
			await step.do('set-status-ready', async () => {
				await emitStatus(name, version, { status: 'ready' });
			});
		}
	}

	async function parseCrate(name: string, version: string): Promise<void> {
		const workflow = new ParseCrateWorkflow();
		const result = await runWorkflow(
			workflow,
			{ name, version },
			{
				onStepStart(stepName) {
					log.info`[workflow] step started: ${stepName} for ${name}@${version}`;
				},
				onStepError(stepName, error, attempt) {
					log.error`[workflow] step "${stepName}" failed (attempt ${String(attempt)}): ${error.message}`;
				},
			},
		);

		if (result.isErr()) {
			const err = result.error;
			log.error`Failed to parse ${name}@${version}: ${err.message} (step: ${err.failedStep})`;
			const action =
				err.failedStep === 'fetch-artifact' && /\b404\b/.test(err.message)
					? ('docs_unavailable' as const)
					: undefined;
			await emitStatus(
				name,
				version,
				{ status: 'failed', error: err.message, ...(action ? { action } : {}) },
				err.failedStep,
			);
		}
	}

	// ── Std crate parse pipeline ──

	type ParseStdCrateParams = {
		name: string;
		version: string;
		installConsent: boolean;
	};

	class ParseStdCrateWorkflow extends WorkflowEntrypoint<ParseStdCrateParams> {
		async run(event: WorkflowEvent<ParseStdCrateParams>, step: WorkflowStep): Promise<void> {
			const { name, version, installConsent } = event.payload;
			log.info`Parsing std crate ${name}@${version} (installConsent=${String(installConsent)})`;

			// check-existing
			const cached = await step.do('check-existing', async () => {
				const lc = await getCache();
				return lc.hasCrate(name, version);
			});
			if (cached) {
				await emitStatus(name, version, { status: 'ready' });
				return;
			}

			// set-status-resolving
			await step.do('set-status-resolving', async () => {
				await emitStatus(name, version, { status: 'processing' }, 'resolving');
			});

			// detect-sysroot: find JSON path
			const stdInfo = await step.do('detect-sysroot', async () => {
				return findStdJson(name, version);
			});

			// If not available and we have install consent, install the component
			if (!stdInfo.available && installConsent) {
				await step.do('install-component', async () => {
					await emitStatus(name, version, { status: 'processing' }, 'fetching');
					const toolchain = versionToToolchainForInstall(version);
					await installStdDocs(toolchain);
				});

				// Re-check after install
				const afterInstall = await step.do('recheck-sysroot', async () => {
					return findStdJson(name, version);
				});
				if (!afterInstall.available) {
					throw new Error(`rust-docs-json installed but ${name}.json not found`);
				}
				stdInfo.available = afterInstall.available;
				stdInfo.jsonPath = afterInstall.jsonPath;
			}

			if (!stdInfo.available || !stdInfo.jsonPath) {
				throw new Error(`Std JSON not available for ${name}@${version}`);
			}

			const crossEdgesList: Edge[] = [];
			const crossNodeMap = new Map<string, CrossEdgeNodeSummary>();
			const nodeSummaries = new Map<string, CrossEdgeNodeSummary>();
			const normalizedName = normalizeCrateName(name);
			const cratePrefix = (id: string): string => id.split('::')[0] ?? id;
			const isExternalNode = (id: string): boolean => cratePrefix(id) !== normalizedName;

			// read-json
			const artifactInfo = await step.do('read-json', async () => {
				await emitStatus(name, version, { status: 'processing' }, 'fetching');
				const file = Bun.file(stdInfo.jsonPath!);
				const sizeLabel = `${(file.size / 1024 / 1024).toFixed(1)} MB`;
				const contentId = `${file.size}:${file.lastModified ?? 0}`;
				return { stream: file.stream(), sizeLabel, contentId };
			});
			log.info`Read std JSON for ${name}@${version}: ${artifactInfo.sizeLabel}`;

			// parse-rustdoc
			const parseResult = await step.do('parse-rustdoc', async () => {
				log.info`Parsing rustdoc for std crate ${name}@${version}`;
				await emitStatus(name, version, { status: 'processing' }, 'parsing');
				const t0 = performance.now();

				const lc = await getCache();
				const tempIndex: CrateIndex = { name, version, crates: [] };
				lc.initCrate(name, version, tempIndex);
				const result = await perf.timeAsync('parser', `parse ${name}@${version}`, () =>
					parseWithRustBinary(
						artifactInfo.stream,
						name,
						{
							storeNodes: (nodes) => {
								lc.insertNodes(name, version, nodes);
								for (const node of nodes) {
									nodeSummaries.set(node.id, {
										id: node.id,
										name: node.name,
										kind: node.kind,
										visibility: node.visibility,
										is_external: node.is_external,
									});
								}
							},
							storeEdges: (edges) => {
								lc.insertEdges(name, version, edges);
								for (const edge of edges) {
									if (cratePrefix(edge.from) !== cratePrefix(edge.to)) {
										crossEdgesList.push(edge);
										const fromNode =
											nodeSummaries.get(edge.from) ??
											summarizeCrossEdgeNode(edge.from, isExternalNode(edge.from)).unwrapOr(null);
										const toNode =
											nodeSummaries.get(edge.to) ??
											summarizeCrossEdgeNode(edge.to, isExternalNode(edge.to)).unwrapOr(null);
										if (fromNode) crossNodeMap.set(fromNode.id, fromNode);
										if (toNode) crossNodeMap.set(toNode.id, toNode);
									}
								}
							},
						},
						{
							onProgress: (progress: ParseProgress) => {
								broadcastProgress('rust', name, version, progress);
							},
							onFinalizingStart: () => {
								void emitStatus(name, version, { status: 'processing' }, 'finalizing');
							},
						},
					),
				);

				log.info`Parsed ${name}@${version}: ${result.nodeCount} nodes, ${(performance.now() - t0).toFixed(0)}ms`;
				return result;
			});

			// store-graph
			await step.do('store-graph', async () => {
				await emitStatus(name, version, { status: 'processing' }, 'storing');
				const lc = await getCache();
				const index: CrateIndex = {
					name,
					version,
					crates: [{ id: normalizedName, name, version, is_external: false }],
				};
				// Update index only — nodes/edges were already stored during progressive parsing.
				lc.updateIndex(name, version, index);
				lc.finalizeCrate(
					name,
					version,
					parseResult.tree,
					parseResult.nodeCount,
					parseResult.edgeCount,
				);
				lc.replaceCrossEdges(
					'rust',
					name,
					version,
					crossEdgesList,
					Array.from(crossNodeMap.values()),
				);
			});

			await step.do('fanout-dependencies', async () => {
				const touchedNodes = new Set<string>();
				for (const edge of crossEdgesList) {
					touchedNodes.add(edge.from);
					touchedNodes.add(edge.to);
				}
				for (const nodeId of touchedNodes) {
					emitEdgeUpdate(nodeId);
				}
			});

			// set-status-ready
			await step.do('set-status-ready', async () => {
				log.info`Parsed and cached std crate ${name}@${version}`;
				await emitStatus(name, version, { status: 'ready' });
			});
		}
	}

	function versionToToolchainForInstall(version: string): string {
		if (version === 'nightly' || version === 'stable' || version === 'beta') return version;
		if (version.includes('-nightly')) return 'nightly';
		if (version.includes('-beta')) return 'beta';
		return 'stable';
	}

	function startStdParse(name: string, version: string, installConsent: boolean): void {
		const key = parseKey(name, version);
		if (inFlight.has(key)) return;
		const promise = parseStdCrate(name, version, installConsent).finally(() => {
			inFlight.delete(key);
		});
		inFlight.set(key, promise);
	}

	async function parseStdCrate(
		name: string,
		version: string,
		installConsent: boolean,
	): Promise<void> {
		const workflow = new ParseStdCrateWorkflow();
		const result = await runWorkflow(
			workflow,
			{ name, version, installConsent },
			{
				onStepStart(stepName) {
					log.info`[std-workflow] step started: ${stepName} for ${name}@${version}`;
				},
				onStepError(stepName, error, attempt) {
					log.error`[std-workflow] step "${stepName}" failed (attempt ${String(attempt)}): ${error.message}`;
				},
			},
		);

		if (result.isErr()) {
			const err = result.error;
			log.error`Failed to parse std ${name}@${version}: ${err.message} (step: ${err.failedStep})`;
			await emitStatus(name, version, { status: 'failed', error: err.message }, err.failedStep);
		}
	}

	async function autoTriggerStdCrates(
		crates: Array<{ name: string; version: string; is_external?: boolean }>,
	): Promise<void> {
		const lc = await getCache();
		for (const c of crates) {
			if (!isStdCrate(c.name) || !STD_JSON_CRATES.includes(c.name)) continue;
			if (lc.hasCrate(c.name, c.version)) continue;
			const key = parseKey(c.name, c.version);
			if (inFlight.has(key)) continue;
			// Fire-and-forget: try to parse from sysroot (no install consent)
			findStdJson(c.name, c.version)
				.then((info) => {
					if (info.available) {
						log.info`Auto-triggering std crate parse: ${c.name}@${c.version}`;
						startStdParse(c.name, c.version, false);
					}
				})
				.catch(() => {
					// Silently ignore — sysroot detection failure is non-fatal
				});
		}
	}

	let loadingPromise: Promise<Workspace | null> | null = null;

	async function loadWorkspace(): Promise<Workspace | null> {
		if (cached) return cached;
		if (loadingPromise) return loadingPromise;
		loadingPromise = (async () => {
			const graphPath = process.env.CODEVIEW_GRAPH;
			if (!graphPath) return null;
			const readResult = await Result.tryPromise(() => readFile(graphPath, 'utf-8'));
			if (readResult.isErr()) {
				log.error`Failed to read workspace file: ${readResult.error}`;
				return null;
			}
			const parseResult = Result.try(() => JSON.parse(readResult.value));
			if (parseResult.isErr()) {
				log.error`Failed to parse workspace JSON`;
				return null;
			}
			cached = parseWorkspace(parseResult.value) as Workspace;
			return cached;
		})().finally(() => {
			loadingPromise = null;
		});
		return loadingPromise;
	}

	async function getWorkspaceCrate(name: string, version?: string) {
		return findWorkspaceCrate(await loadWorkspace(), name, version);
	}

	const provider: DataProvider & LocalWorkspaceProvider = {
		async loadWorkspace() {
			return loadWorkspace();
		},

		async loadSourceFile(
			file: string,
			crateName?: string,
			crateVersion?: string,
			sourceProvider: SourceProviderMode = 'auto',
		) {
			const workspaceRoot = process.env.CODEVIEW_WORKSPACE;
			if (workspaceRoot) {
				const fullPath = join(workspaceRoot, file);
				const resolved = resolve(fullPath);
				if (!resolved.startsWith(resolve(workspaceRoot))) {
					return {
						error: 'Path outside workspace',
						content: null,
						absolutePath: null,
						repoUrl: null,
					};
				}
				const localResult = await Result.tryPromise(() => readFile(resolved, 'utf-8'));
				if (localResult.isOk()) {
					return {
						error: null,
						content: localResult.value,
						absolutePath: resolved.replace(/\\/g, '/'),
						repoUrl: null,
					};
				}
			}

			if (!crateName || !crateVersion) {
				return { error: 'File not found', content: null, absolutePath: null, repoUrl: null };
			}

			const cacheKey = sourceCacheKey(crateName, crateVersion, file, sourceProvider);
			const cachedContent = getCachedSourceFile(cacheKey);
			if (cachedContent !== null) {
				return { error: null, content: cachedContent, absolutePath: null, repoUrl: null };
			}

			// ── Std fast-path ─────────────────────────────────────────
			// std/core/alloc/proc_macro/test aren't on crates.io. rustdoc
			// spans use `library/{crate}/...` paths — we stream those
			// straight from rust-lang/rust on GitHub.
			if (isStdCrate(normalizeCrateName(crateName))) {
				const result = await fetchStdSourceFile(file, crateVersion, SOURCE_MAX_BYTES, USER_AGENT);
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

			let metadata: Awaited<ReturnType<typeof registry.resolve>> | null = null;
			for (const variant of crateNameVariants(crateName)) {
				const resolved = await registry.resolve(variant, crateVersion);
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

			const repoUrl = buildGitHubFileUrl(metadata.repositoryUrl, metadata.version, file);

			if (
				(sourceProvider === 'auto' || sourceProvider === 'crates-io') &&
				metadata.sourceArchiveUrl
			) {
				const direct = await fetchSourceFileFromArchive(metadata.sourceArchiveUrl, file, {
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
				{ maxBytes: SOURCE_MAX_BYTES, userAgent: USER_AGENT },
			);
			if (!files) {
				return {
					error: 'Source file not available',
					content: null,
					absolutePath: null,
					repoUrl: null,
				};
			}

			const content = source.resolveFromMap(files, file);
			if (content === null) {
				return { error: 'File not found', content: null, absolutePath: null, repoUrl: null };
			}
			setCachedSourceFile(cacheKey, content);
			return { error: null, content, absolutePath: null, repoUrl };
		},

		async loadCrateGraph(name: string, _version: string) {
			// Check workspace first
			const ws = await loadWorkspace();
			const found = findWorkspaceCrate(ws, name, _version);
			if (found) return found;

			// Check local cache for external crates
			const lc = await getCache();
			return lc.getGraph(name, _version);
		},

		async loadCrateMap(
			name: string,
			version: string,
			options?: CrateMapOptions,
		): Promise<CrateMapData | null> {
			const graph = await this.loadCrateGraph(name, version);
			if (!graph) return null;
			return buildCrateMapData({ nodes: graph.nodes, edges: graph.edges }, name, options ?? {});
		},

		async loadCrateTree(name: string, _version: string) {
			const lc = await getCache();
			const tree = lc.getTree(name, _version);
			log.info`loadCrateTree(local) name=${name} version=${_version} hit=${tree ? 'yes' : 'no'}${tree ? ` nodes=${tree.nodes.length} edges=${tree.edges.length}` : ''}`;
			return tree;
		},

		async loadCrateIndex(name: string, version: string): Promise<CrateIndex | null> {
			const ws = await loadWorkspace();
			if (ws) {
				// Check if crate is in workspace
				const workspaceCrate = findWorkspaceCrate(ws, name, version);
				if (workspaceCrate) {
					const crates: Array<{
						id: string;
						name: string;
						version: string;
						is_external?: boolean;
					}> = ws.crates.map((c) => ({
						id: c.id,
						name: c.name,
						version: c.version,
					}));
					for (const ext of ws.external_crates) {
						const extVersion = ext.version ?? (isStdCrate(ext.name) ? 'stable' : 'latest');
						crates.push({
							id: ext.id,
							name: ext.name,
							version: extVersion,
							is_external: true,
						});
					}
					const current = findCrateIndexEntry(crates, name);

					// Fire-and-forget: auto-trigger std crate parsing for available sysroot JSON
					void autoTriggerStdCrates(crates);

					return {
						name: current?.name ?? workspaceCrate.name,
						version: current?.version ?? workspaceCrate.version,
						crates,
					};
				}
			}

			// Check local cache for external crates
			const lc = await getCache();
			return lc.getIndex(name, version);
		},

		async loadNodeDetail(
			name: string,
			version: string,
			nodeId: string,
		): Promise<NodeDetail | null> {
			const lc = await getCache();

			// Load node and its edges
			const node = lc.getNodeById(name, version, nodeId);
			if (!node) return null;

			const nodeEdges = lc.getEdgesForNode(name, version, nodeId);

			// Collect all edges - start with direct edges
			const allEdges = [...nodeEdges];
			const edgeSet = new Set(nodeEdges.map((e) => `${e.from}|${e.to}|${e.kind}`));

			// For types with impl blocks, follow Defines edges to get impl -> method edges
			// This enables showing methods in the detail view
			const isTypeNode = ['Struct', 'Enum', 'Union', 'Trait', 'TraitAlias', 'TypeAlias'].includes(
				node.kind,
			);
			if (isTypeNode) {
				const implIds: string[] = [];
				for (const edge of nodeEdges) {
					if (edge.kind === 'Defines' && edge.from === nodeId) {
						implIds.push(edge.to);
					}
				}

				// Load edges from impl blocks (to get Contains/Defines -> Function edges)
				for (const implId of implIds) {
					const implEdges = lc.getEdgesForNode(name, version, implId);
					for (const edge of implEdges) {
						const key = `${edge.from}|${edge.to}|${edge.kind}`;
						if (!edgeSet.has(key)) {
							allEdges.push(edge);
							edgeSet.add(key);
						}
					}
				}
			}

			// Get related nodes (targets of all edges including impl methods)
			const relatedIds = new Set<string>();
			for (const edge of allEdges) {
				if (edge.from !== nodeId) relatedIds.add(edge.from);
				if (edge.to !== nodeId) relatedIds.add(edge.to);
			}

			// Load related nodes with full data
			const relatedNodes: Node[] = [];
			for (const id of relatedIds) {
				const related = lc.getNodeById(name, version, id);
				if (related) {
					relatedNodes.push(related);
				}
			}

			return {
				node,
				edges: allEdges,
				relatedNodes,
			};
		},

		async loadTreeRootsDirect(name: string, version: string): Promise<TreeNodeDTO[] | null> {
			const lc = await getCache();
			const results = lc.getTreeRootsDirect(name, version);
			return results.map(({ node, hasChildren }) => ({
				node: nodeToSummary(node),
				hasChildren,
			}));
		},

		async loadTreeChildrenDirect(
			name: string,
			version: string,
			parentId: string,
		): Promise<TreeNodeDTO[] | null> {
			const lc = await getCache();
			const results = lc.getTreeChildrenDirect(name, version, parentId);
			return results.map(({ node, hasChildren }) => ({
				node: nodeToSummary(node),
				hasChildren,
			}));
		},

		async loadTreeAncestorsDirect(
			name: string,
			version: string,
			nodeId: string,
		): Promise<NodeSummary[] | null> {
			const lc = await getCache();
			const nodes = lc.getTreeAncestorsDirect(name, version, nodeId);
			return nodes.map(nodeToSummary);
		},

		async getCrossEdgeData(nodeId: string): Promise<CrossEdgeData> {
			const lc = await getCache();
			const result = lc.getCrossEdgeData('rust', nodeId);
			return {
				edges: result.edges.map((edge) => ({
					...edge,
					kind: edge.kind as EdgeKind,
					confidence: edge.confidence as Confidence,
				})),
				nodes: result.nodes.map((node) => ({
					...node,
					kind: node.kind as NodeKind,
					// node.visibility is already a typed Visibility (cache
					// parses the canonical key form back on read), so no
					// cast needed.
				})),
			};
		},

		async getCrateStatus(name: string, version: string): Promise<CrateStatus> {
			const normalizedName = normalizeCrateName(name);
			const requestedVersion =
				isStdCrate(normalizedName) && version === 'latest' ? 'stable' : version;
			if (isStdCrate(normalizedName)) {
				// Check cache first
				const lc = await getCache();
				if (lc.hasCrate(name, requestedVersion)) {
					await emitStatus(name, requestedVersion, { status: 'ready' });
					return { status: 'ready' };
				}
				const dbStatus = lc.getStatus('rust', name, requestedVersion);
				if (dbStatus.status !== 'unknown') {
					const action = statusAction.classify(dbStatus);
					return action ? { ...dbStatus, action } : dbStatus;
				}

				// Check sysroot availability
				try {
					const stdInfo = await findStdJson(name, requestedVersion);
					if (stdInfo.available) return { status: 'unknown' }; // auto-triggerable

					// Mismatch — needs user consent to install
					return {
						status: 'failed',
						error: `Rust docs for ${requestedVersion} are not installed locally. Available: ${stdInfo.installedVersion ?? 'none'}`,
						action: 'install_std_docs',
						installedVersion: stdInfo.installedVersion,
					};
				} catch {
					return { status: 'failed', error: `Failed to detect local Rust docs for ${name}` };
				}
			}

			const workspaceCrate = await getWorkspaceCrate(name, version);
			if (workspaceCrate) {
				try {
					await emitWorkspaceReady(name, version, workspaceCrate);
				} catch {
					/* status cache is best-effort for workspace graph data */
				}
				return { status: 'ready' };
			}

			// Check SQLite status first
			try {
				const lc = await getCache();
				const dbStatus = lc.getStatus('rust', name, version);
				if (dbStatus.status !== 'unknown') {
					const action = statusAction.classify(dbStatus);
					return action ? { ...dbStatus, action } : dbStatus;
				}

				// Check if graph exists in cache
				if (lc.hasCrate(name, version)) {
					await emitStatus(name, version, { status: 'ready' });
					return { status: 'ready' };
				}
			} catch {}

			// Auto-trigger parse for unknown external crates (mirrors Cloudflare behavior)
			if (isValidCrateName(name) && isValidVersion(version)) {
				await emitStatus(name, version, { status: 'processing' }, 'resolving');
				startParse(name, version);
				return { status: 'processing' };
			}

			return { status: 'unknown' };
		},

		async triggerParse(name: string, version: string, force?: boolean) {
			const normalizedName = normalizeCrateName(name);
			const requestedVersion =
				isStdCrate(normalizedName) && version === 'latest' ? 'stable' : version;
			if (isStdCrate(normalizedName)) {
				// Check if sysroot JSON is available (no install consent)
				const stdInfo = await findStdJson(name, requestedVersion);
				if (!stdInfo.available) {
					return Result.err(
						new NotAvailableError({
							message: `${name}@${requestedVersion} is not available locally`,
						}),
					);
				}
				const lc = await getCache();
				if (!force && lc.hasCrate(name, requestedVersion)) {
					await emitStatus(name, requestedVersion, { status: 'ready' });
					return Result.ok(undefined);
				}
				await emitStatus(name, requestedVersion, { status: 'processing' }, 'resolving');
				startStdParse(name, requestedVersion, false);
				return Result.ok(undefined);
			}
			if (!isValidCrateName(name) || !isValidVersion(version)) {
				return Result.err(new ValidationError({ message: 'Invalid crate name or version' }));
			}

			const workspaceCrate = await getWorkspaceCrate(name, version);
			if (workspaceCrate) {
				await emitWorkspaceReady(name, version, workspaceCrate);
				return Result.ok(undefined);
			}

			const lc = await getCache();

			if (force) {
				// Clear in-flight promise so a fresh parse runs
				const key = parseKey(name, version);
				inFlight.delete(key);
			} else {
				const current = lc.getStatus('rust', name, version);
				if (current.status === 'processing' || current.status === 'ready') {
					return Result.ok(undefined);
				}

				// Also check graph cache
				if (lc.hasCrate(name, version)) {
					await emitStatus(name, version, { status: 'ready' });
					return Result.ok(undefined);
				}
			}

			// Set status atomically BEFORE starting the parse
			await emitStatus(name, version, { status: 'processing' }, 'resolving');
			startParse(name, version);
			return Result.ok(undefined);
		},

		async ensureParsed(name: string, version: string): Promise<void> {
			const normalizedName = normalizeCrateName(name);
			const requestedVersion =
				isStdCrate(normalizedName) && version === 'latest' ? 'stable' : version;
			if (isStdCrate(normalizedName)) {
				const lc = await getCache();
				if (lc.hasCrate(name, requestedVersion)) return;
				const key = parseKey(name, requestedVersion);
				let promise = inFlight.get(key);
				if (!promise) {
					await emitStatus(name, requestedVersion, { status: 'processing' }, 'resolving');
					startStdParse(name, requestedVersion, false);
					promise = inFlight.get(key);
				}
				if (promise) {
					await Promise.race([promise, new Promise<void>((r) => setTimeout(r, 15_000))]);
				}
				return;
			}

			const workspaceCrate = await getWorkspaceCrate(name, version);
			if (workspaceCrate) {
				await emitWorkspaceReady(name, version, workspaceCrate);
				return;
			}

			const lc = await getCache();
			// Already finalized?
			if (lc.hasCrate(name, version)) return;

			const key = parseKey(name, version);

			// Already in flight? Just await it.
			let promise = inFlight.get(key);
			if (!promise) {
				// Not in flight and not parsed — trigger if valid
				if (!isValidCrateName(name) || !isValidVersion(version)) return;
				await emitStatus(name, version, { status: 'processing' }, 'resolving');
				startParse(name, version);
				promise = inFlight.get(key);
			}

			if (promise) {
				// Wait for completion or timeout (large crates get partial data via streaming)
				await Promise.race([promise, new Promise<void>((r) => setTimeout(r, 15_000))]);
			}
		},

		async triggerStdInstall(name: string, version: string) {
			const normalizedName = normalizeCrateName(name);
			const requestedVersion = version === 'latest' ? 'stable' : version;
			if (!isStdCrate(normalizedName)) {
				return Result.err(
					new ValidationError({ message: `${name} is not a standard library crate` }),
				);
			}
			const lc = await getCache();
			if (lc.hasCrate(name, requestedVersion)) {
				await emitStatus(name, requestedVersion, { status: 'ready' });
				return Result.ok(undefined);
			}
			await emitStatus(name, requestedVersion, { status: 'processing' }, 'resolving');
			startStdParse(name, requestedVersion, true);
			return Result.ok(undefined);
		},

		async searchRegistry(query: string): Promise<CrateSummaryResult[]> {
			const results = await registry.search(query);
			return results.map((r) => ({
				id: hyphenateCrateName(r.name),
				name: r.name,
				version: r.version,
				description: r.description,
			}));
		},

		async getTopCrates(limit = 10): Promise<CrateSummaryResult[]> {
			const results = await registry.listTop(limit);
			return results.map((r) => ({
				id: hyphenateCrateName(r.name),
				name: r.name,
				version: r.version,
				description: r.description,
			}));
		},

		async getProcessingCrates(limit = 20): Promise<CrateSummaryResult[]> {
			const lc = await getCache();
			return lc.getProcessingCrates('rust', limit);
		},

		async getCrateVersions(name: string, limit = 100): Promise<string[]> {
			const localVersion = (await getWorkspaceCrate(name))?.version;
			// Try both hyphen and underscore variants for registry lookup
			let registryVersions: string[] = [];
			for (const variant of crateNameVariants(name)) {
				registryVersions = await registry.listVersions(variant, limit);
				if (registryVersions.length > 0) break;
			}
			if (localVersion && !registryVersions.includes(localVersion)) {
				return [localVersion, ...registryVersions];
			}
			return registryVersions.length > 0 ? registryVersions : localVersion ? [localVersion] : [];
		},

		async resolveVersion(name: string, version: string): Promise<string> {
			if (version === 'latest' && isStdCrate(normalizeCrateName(name))) return 'stable';
			if (version === 'latest') {
				const versions = await this.getCrateVersions(name, 1);
				if (versions.length > 0) return versions[0];
			}
			return version;
		},
	};

	providerInternals = {
		getCache,
		getCrateStatus: (name: string, version: string) => provider.getCrateStatus(name, version),
	};

	return provider;
}

/** Build-time entry point — imported via the `$provider` alias (see vite.config.js). */
let _singleton: DataProvider | null = null;
export function createProvider(_event: RequestEvent): DataProvider {
	if (!_singleton) _singleton = createLocalProvider();
	return _singleton;
}

/**
 * Handle WebSocket upgrade for local mode.
 * Called from the /api/events/ws route.
 */
export function handleWsUpgrade(event: RequestEvent): Response {
	log.info`handleWsUpgrade called platform=${String(typeof event.platform)} keys=${event.platform ? Object.keys(event.platform).join(',') : 'none'}`;
	const server = event.platform?.server;
	if (!server) {
		log.warn`handleWsUpgrade: no server on platform`;
		return new Response('No Bun server available for WebSocket upgrade', { status: 500 });
	}

	if (!providerInternals) {
		log.warn`handleWsUpgrade: provider not initialized`;
		return new Response('Provider not initialized', { status: 500 });
	}

	const handlers = createHandlers(providerInternals);
	log.info`handleWsUpgrade: attempting upgrade`;
	const upgraded = server.upgrade(event.request, { data: handlers });
	if (!upgraded) {
		log.warn`handleWsUpgrade: upgrade returned false`;
		return new Response('WebSocket upgrade failed', { status: 400 });
	}
	log.info`handleWsUpgrade: upgrade success`;
	// Bun handles the 101 response internally
	return new Response(null, { status: 101 });
}
