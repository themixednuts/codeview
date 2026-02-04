import { Result } from 'better-result';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { RequestEvent } from '@sveltejs/kit';
import type { Workspace, CrateGraph, Confidence, EdgeKind, NodeKind, Visibility, Node, Edge } from '$lib/graph';
import type { CrateIndex, CrateTree, NodeDetail, NodeSummary } from '$lib/schema';
import { parseWorkspace } from '$lib/schema';
import { isStdCrate, STD_JSON_CRATES } from '$lib/std';
import { getLogger } from '$lib/log';
import { perf } from '$lib/perf';
import { decodeGzipStream } from '$lib/server/gzip';
import { summarizeCrossEdgeNode, type CrossEdgeNodeSummary } from '$lib/server/cross-edges';
import { getContentId } from '$lib/server/content';
import { createCratesIoAdapter } from '../registry/cratesio';
import { getRegistry } from '../registry/index';
import { parseWithProgressiveStorage, type ParseProgress } from '../parser/streaming/adapter';
import { fetchSourceFileFromArchive } from '../parser/archive';
import { getSourceAdapter } from '../sources/index';
import { fetchSourcesWithProviders } from '../sources/runner';
import type { SourceProviderGroup } from '../sources/types';
import type { CrossEdgeData, DataProvider, CrateStatus, CrateSummaryResult } from '../provider';
import { ValidationError, NotAvailableError } from '../errors';
import { isValidCrateName, isValidVersion, normalizeCrateName, crateNameVariants } from '../validation';
import { sseResponse, sseStreamResponse } from '../sse';
import { SharedEventStream } from '../shared-events';
import { LocalCache } from './cache';
import { WorkflowEntrypoint, runWorkflow } from './workflow';
import type { WorkflowStep, WorkflowEvent } from './workflow';
import { findStdJson, installStdDocs, detectSysroot } from './sysroot';

const log = getLogger('local');

const USER_AGENT = 'codeview';
const SOURCE_MAX_BYTES = 96 * 1024 * 1024;
const VERSION_LOOKUP_CONCURRENCY = 6;

function sourcePathCandidates(path: string): string[] {
	const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
	const withSrc = normalized.startsWith('src/') ? normalized : `src/${normalized}`;
	const withoutSrc = normalized.startsWith('src/') ? normalized.slice('src/'.length) : normalized;
	const values = [normalized, withSrc, withoutSrc];
	return values.filter((v, i, all) => v.length > 0 && all.indexOf(v) === i);
}

function resolveSourceFileFromMap(files: Map<string, string>, file: string): string | null {
	for (const candidate of sourcePathCandidates(file)) {
		const exact = files.get(candidate);
		if (exact !== undefined) return exact;
	}
	for (const candidate of sourcePathCandidates(file)) {
		const suffix = `/${candidate}`;
		for (const [path, content] of files) {
			const normalizedPath = path.replace(/\\/g, '/');
			if (normalizedPath === candidate || normalizedPath.endsWith(suffix)) return content;
		}
	}
	return null;
}

function selectSourceProviders(
	group: SourceProviderGroup,
	mode: 'auto' | 'crates-io' | 'github'
): SourceProviderGroup {
	if (mode === 'auto') return group;
	if (mode === 'crates-io') {
		return {
			...group,
			main: group.main.filter((provider) => provider.id === 'crate-archive'),
			fallbacks: []
		};
	}
	return {
		...group,
		main: [],
		fallbacks: group.fallbacks.filter((provider) => provider.id.startsWith('github-'))
	};
}

type CrateIndexEntry = {
	id: string;
	name: string;
	version: string;
	is_external?: boolean;
};

async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>
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

export function createLocalProvider(): DataProvider {
	let cached: Workspace | null = null;
	const registry = createCratesIoAdapter();
	const sourceFileCache = new Map<string, string>();
	const SOURCE_FILE_CACHE_MAX = 512;
	
	// Shared event stream for multiplexed SSE (single connection per client)
	const sharedEvents = new SharedEventStream(log);

	function sourceCacheKey(
		crateName: string,
		crateVersion: string,
		file: string,
		sourceProvider: 'auto' | 'crates-io' | 'github'
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
	function getCache(): LocalCache {
		if (!cache) cache = new LocalCache();
		return cache;
	}

	// In-memory listeners for SSE push (source of truth is SQLite via LocalCache)
	const listeners = new Map<string, Set<(status: CrateStatus) => void>>();
	const processingListeners = new Set<(count: number) => void>();
	const edgeListeners = new Map<string, Set<(data: { type: string; nodeId: string }) => void>>();
	const progressListeners = new Map<string, Set<(progress: ParseProgress) => void>>();
	const progressState = new Map<string, { sequence: number; contentId?: string; snapshot?: CrateTree }>();

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

	function statusKey(name: string, version: string): string {
		return `${normalizeCrateName(name)}:${version}`;
	}

	function emitStatus(name: string, version: string, status: CrateStatus, step?: string): void {
		const lc = getCache();
		lc.setStatus('rust', name, version, status.status as 'unknown' | 'processing' | 'ready' | 'failed', status.error, step);
		const key = statusKey(name, version);
		if (status.status === 'processing' && step === 'resolving') {
			// New parse cycle for this crate/version: drop any stale progress snapshot state.
			progressState.delete(key);
		}

		const fullStatus: CrateStatus = {
			...status,
			...(step ? { step } : {}),
		};

		const subs = listeners.get(key);
		if (subs) {
			for (const fn of subs) {
				try { fn(fullStatus); } catch {}
			}
		}
		// Broadcast processing count change
		const count = lc.getProcessingCount('rust');
		for (const fn of processingListeners) {
			try { fn(count); } catch {}
		}
	}

	function emitEdgeUpdate(nodeId: string): void {
		const subs = edgeListeners.get(nodeId);
		if (!subs) return;
		for (const fn of subs) {
			try { fn({ type: 'cross-edges', nodeId }); } catch {}
		}
	}

	function emitProgress(name: string, version: string, progress: ParseProgress): void {
		const key = statusKey(name, version);
		const subs = progressListeners.get(key);
		if (!subs) return;
		for (const fn of subs) {
			try { fn(progress); } catch {}
		}
	}

	function subscribeProgress(
		name: string,
		version: string,
		cb: (progress: ParseProgress) => void
	): () => void {
		const key = statusKey(name, version);
		let subs = progressListeners.get(key);
		if (!subs) {
			subs = new Set();
			progressListeners.set(key, subs);
		}
		subs.add(cb);
		return () => {
			subs!.delete(cb);
			if (subs!.size === 0) progressListeners.delete(key);
		};
	}

	function subscribe(
		name: string,
		version: string,
		cb: (status: CrateStatus) => void
	): () => void {
		const key = statusKey(name, version);
		let subs = listeners.get(key);
		if (!subs) {
			subs = new Set();
			listeners.set(key, subs);
		}
		subs.add(cb);
		return () => {
			subs!.delete(cb);
			if (subs!.size === 0) listeners.delete(key);
		};
	}

	function subscribeProcessing(cb: (count: number) => void): () => void {
		processingListeners.add(cb);
		return () => { processingListeners.delete(cb); };
	}

	function subscribeEdge(nodeId: string, cb: (data: { type: string; nodeId: string }) => void): () => void {
		let subs = edgeListeners.get(nodeId);
		if (!subs) {
			subs = new Set();
			edgeListeners.set(nodeId, subs);
		}
		subs.add(cb);
		return () => {
			subs!.delete(cb);
			if (subs!.size === 0) edgeListeners.delete(nodeId);
		};
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
				const lc = getCache();
				return lc.hasCrate(name, version);
			});
			if (cached) {
				emitStatus(name, version, { status: 'ready' });
				return;
			}

			// set-status-resolving
			await step.do('set-status-resolving', async () => {
				emitStatus(name, version, { status: 'processing' }, 'resolving');
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
				}
			);

			// set-status-fetching
			await step.do('set-status-fetching', async () => {
				log.info`Fetching rustdoc for ${name}@${version}`;
				emitStatus(name, version, { status: 'processing' }, 'fetching');
			});

			// fetch-artifact: download + decompress
			const artifactResult = await step.do(
				'fetch-artifact',
				{ retries: { limit: 2, delayMs: 3000, backoff: 'exponential' } },
				async () => {
					const artifactUrl = meta.artifactUrl ?? `https://docs.rs/crate/${name}/${version}/json.gz`;
					const artifactRes = await fetch(artifactUrl, {
						headers: { 'User-Agent': USER_AGENT }
					});
					if (!artifactRes.ok) {
						throw new Error(
							`Failed to fetch artifact: ${artifactRes.status} ${artifactRes.statusText}`
						);
					}

					const contentType = artifactRes.headers.get('content-type') ?? '';
					const contentLength = Number(artifactRes.headers.get('content-length') ?? '0');
					const contentId = getContentId(artifactRes.headers, `${name}@${version}`);
					if (!artifactRes.body) {
						throw new Error('Artifact response has no body for streaming');
					}
					let input: ReadableStream<Uint8Array> = artifactRes.body;
					if (contentType.includes('gzip')) {
						input = decodeGzipStream(artifactRes.body);
					}
					const sizeLabel = contentLength > 0
						? `${(contentLength / 1024 / 1024).toFixed(1)} MB compressed`
						: 'unknown size';
					return { input, sizeLabel, contentId };
				}
			);
			log.info`Fetched ${name}@${version}: ${artifactResult.sizeLabel}`;

			// Track cross-edge data during parsing (for both paths)
			const crossEdgesList: Edge[] = [];
			const crossNodeMap = new Map<string, CrossEdgeNodeSummary>();
			const externalCratesFound: Array<{ id: string; name: string }> = [];

			function cratePrefix(id: string): string {
				return id.split('::')[0] ?? id;
			}
			const normalizedName = name.replace(/-/g, '_');
			const isExternalNode = (id: string): boolean => cratePrefix(id) !== normalizedName;

			// parse-rustdoc: parse JSON → graph with progressive storage
			const parseResult = await step.do(
				'parse-rustdoc',
				{ retries: { limit: 1, delayMs: 1000, backoff: 'linear' } },
				async () => {
					log.info`Parsing rustdoc for ${name}@${version}`;
					emitStatus(name, version, { status: 'processing' }, 'parsing');
					const t0 = performance.now();

					// Fetch sources in parallel with parsing to avoid blocking progress.
					log.info`Fetching sources for ${name}@${version}`;
					const sourceAdapterResult = getSourceAdapter('rust');
					if (sourceAdapterResult.isErr()) throw sourceAdapterResult.error;
					const sourceAdapter = sourceAdapterResult.value;
					const providers = sourceAdapter.getProviders({
						ecosystem: 'rust',
						name,
						version,
						metadata: meta
					});
					const sourceFilesPromise = fetchSourcesWithProviders(
						providers,
						{ ecosystem: 'rust', name, version, metadata: meta },
						{ maxBytes: SOURCE_MAX_BYTES, userAgent: USER_AGENT }
					).catch((err) => {
						log.warn`Sources fetch failed for ${name}@${version}: ${String(err)}`;
						return null;
					});

					const lc = getCache();
					const crateName = name.replace(/-/g, '_');

					// Initialize crate entry (will be finalized after parsing)
					const tempIndex: CrateIndex = { name, version, crates: [] };
					lc.initCrate(name, version, tempIndex);

					// Track node summaries for cross-edge detection
					const nodeSummaries = new Map<string, CrossEdgeNodeSummary>();
					// Accumulate deltas so we can periodically materialize a full tree for cache reads.
					const treeAccumulator: CrateTree = { nodes: [], edges: [] };

					const result = await parseWithProgressiveStorage(
						artifactResult.input,
						name,
						{
							storeNodes: (nodes) => {
								// Store to DB
								lc.insertNodes(name, version, nodes);
								// Track summaries for cross-edge detection
								for (const node of nodes) {
									nodeSummaries.set(node.id, {
										id: node.id,
										name: node.name,
										kind: node.kind,
										visibility: node.visibility,
										is_external: node.is_external
									});
								}
							},
							storeEdges: (edges) => {
								// Store to DB
								lc.insertEdges(name, version, edges);
								// Track cross-crate edges
								for (const edge of edges) {
									if (cratePrefix(edge.from) !== cratePrefix(edge.to)) {
										crossEdgesList.push(edge);
										const fromNode = nodeSummaries.get(edge.from)
											?? summarizeCrossEdgeNode(edge.from, isExternalNode(edge.from)).unwrapOr(null);
										const toNode = nodeSummaries.get(edge.to)
											?? summarizeCrossEdgeNode(edge.to, isExternalNode(edge.to)).unwrapOr(null);
										if (fromNode) crossNodeMap.set(fromNode.id, fromNode);
										if (toNode) crossNodeMap.set(toNode.id, toNode);
									}
								}
							}
						},
						{
							batchSize: 200,
							skipExternalNodes: true,
							onProgress: (progress) => {
								// Emit delta updates to SSE listeners
								emitProgress(name, version, progress);
								// Also update tree in DB periodically for UI to fetch
								if (progress.tree) {
									if (progress.type === 'snapshot') {
										treeAccumulator.nodes.length = 0;
										treeAccumulator.edges.length = 0;
										for (const node of progress.tree.nodes) treeAccumulator.nodes.push(node);
										for (const edge of progress.tree.edges) treeAccumulator.edges.push(edge);
									} else {
										for (const node of progress.tree.nodes) treeAccumulator.nodes.push(node);
										for (const edge of progress.tree.edges) treeAccumulator.edges.push(edge);
									}
									if (progress.nodeCount > 0) {
										lc.finalizeCrate(name, version, treeAccumulator, progress.nodeCount, progress.edgeCount);
									}
								}
								const key = statusKey(name, version);
								const existing = progressState.get(key);
								progressState.set(key, {
									sequence: progress.sequence,
									contentId: progress.contentId ?? existing?.contentId,
									snapshot: progress.type === 'snapshot' && progress.tree
										? { nodes: progress.tree.nodes.slice(), edges: progress.tree.edges.slice() }
										: existing?.snapshot
								});
							},
							progressInterval: 200,
							snapshotInterval: 20000,
							contentId: artifactResult.contentId
						}
					);

					// Finalize crate with tree
					lc.finalizeCrate(name, version, result.tree, result.nodeCount, result.edgeCount);

					// Collect external crates
					externalCratesFound.push(...result.externalCrates);

					const sourceFiles = await sourceFilesPromise;
					log.info`Sources for ${name}@${version}: ${sourceFiles ? sourceFiles.size + ' files' : 'none'}`;

					log.info`Parsed ${name}@${version}: ${result.nodeCount} nodes, ${(performance.now() - t0).toFixed(0)}ms`;

					return {
						graph: { id: crateName, name: crateName, version, nodes: [] as Node[], edges: [] as Edge[] },
						externalCrates: result.externalCrates.map(ec => ({ ...ec, version: null, nodes: [] as Node[] })),
						nodeCount: result.nodeCount,
						edgeCount: result.edgeCount
					};
				}
			);

			// set-status-indexing
			await step.do('set-status-indexing', async () => {
				emitStatus(name, version, { status: 'processing' }, 'indexing');
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

					async function resolveExternalEntry(ext: { id: string; name: string }): Promise<CrateIndexEntry | null> {
						const candidates = [
							...crateNameVariants(ext.name),
							...crateNameVariants(ext.id)
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
						resolveExternalEntry
					);
					const filteredExternal = externalEntries.filter((e): e is CrateIndexEntry => e !== null);

					const crateName = name.replace(/-/g, '_');
					return {
						name,
						version,
						crates: [
							{ id: crateName, name, version, is_external: false },
							...filteredExternal
						]
					} satisfies CrateIndex;
				}
			);

			// store-graph: finalize progressive storage
			await step.do(
				'store-graph',
				{ retries: { limit: 2, delayMs: 1000, backoff: 'linear' } },
				async () => {
					emitStatus(name, version, { status: 'processing' }, 'storing');
					const lc = getCache();

					// Update index (nodes/edges already stored during parsing)
					lc.initCrate(name, version, index);
					// Restore tree and counts
					const tree = lc.getTree(name, version);
					if (tree) {
						lc.finalizeCrate(name, version, tree, parseResult.nodeCount, parseResult.edgeCount);
					}

					// Store cross-edge index
					lc.replaceCrossEdges(
						'rust', name, version,
						crossEdgesList,
						Array.from(crossNodeMap.values())
					);
				}
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
				log.info`Parsed and cached ${name}@${version}`;
			});

			// set-status-ready
			await step.do('set-status-ready', async () => {
				emitStatus(name, version, { status: 'ready' });
			});
		}
	}

	async function parseCrate(name: string, version: string): Promise<void> {
		const workflow = new ParseCrateWorkflow();
		const result = await runWorkflow(workflow, { name, version }, {
			onStepStart(stepName) {
				log.info`[workflow] step started: ${stepName} for ${name}@${version}`;
			},
			onStepError(stepName, error, attempt) {
				log.error`[workflow] step "${stepName}" failed (attempt ${String(attempt)}): ${error.message}`;
			}
		});

		if (result.isErr()) {
			const err = result.error;
			log.error`Failed to parse ${name}@${version}: ${err.message} (step: ${err.failedStep})`;
			emitStatus(name, version, { status: 'failed', error: err.message }, err.failedStep);
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
				const lc = getCache();
				return lc.hasCrate(name, version);
			});
			if (cached) {
				emitStatus(name, version, { status: 'ready' });
				return;
			}

			// set-status-resolving
			await step.do('set-status-resolving', async () => {
				emitStatus(name, version, { status: 'processing' }, 'resolving');
			});

			// detect-sysroot: find JSON path
			const stdInfo = await step.do('detect-sysroot', async () => {
				return findStdJson(name, version);
			});

			// If not available and we have install consent, install the component
			if (!stdInfo.available && installConsent) {
				await step.do('install-component', async () => {
					emitStatus(name, version, { status: 'processing' }, 'fetching');
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
			const normalizedName = name.replace(/-/g, '_');
			const cratePrefix = (id: string): string => id.split('::')[0] ?? id;
			const isExternalNode = (id: string): boolean => cratePrefix(id) !== normalizedName;

			// read-json
			const artifactInfo = await step.do('read-json', async () => {
				emitStatus(name, version, { status: 'processing' }, 'fetching');
				const file = Bun.file(stdInfo.jsonPath!);
				const sizeLabel = `${(file.size / 1024 / 1024).toFixed(1)} MB`;
				const contentId = `${file.size}:${file.lastModified ?? 0}`;
				return { stream: file.stream(), sizeLabel, contentId };
			});
			log.info`Read std JSON for ${name}@${version}: ${artifactInfo.sizeLabel}`;

			// parse-rustdoc
			const parseResult = await step.do('parse-rustdoc', async () => {
				log.info`Parsing rustdoc for std crate ${name}@${version}`;
				emitStatus(name, version, { status: 'processing' }, 'parsing');
				const t0 = performance.now();

				const lc = getCache();
				const tempIndex: CrateIndex = { name, version, crates: [] };
				lc.initCrate(name, version, tempIndex);
				const treeAccumulator: CrateTree = { nodes: [], edges: [] };

				const result = await perf.timeAsync('parser', `parse ${name}@${version}`, () =>
					parseWithProgressiveStorage(
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
									is_external: node.is_external
								});
							}
						},
							storeEdges: (edges) => {
								lc.insertEdges(name, version, edges);
								for (const edge of edges) {
								if (cratePrefix(edge.from) !== cratePrefix(edge.to)) {
									crossEdgesList.push(edge);
									const fromNode = nodeSummaries.get(edge.from)
										?? summarizeCrossEdgeNode(edge.from, isExternalNode(edge.from)).unwrapOr(null);
									const toNode = nodeSummaries.get(edge.to)
										?? summarizeCrossEdgeNode(edge.to, isExternalNode(edge.to)).unwrapOr(null);
									if (fromNode) crossNodeMap.set(fromNode.id, fromNode);
									if (toNode) crossNodeMap.set(toNode.id, toNode);
								}
							}
						}
					},
					{
							batchSize: 200,
							skipExternalNodes: true,
							progressInterval: 200,
							snapshotInterval: 20000,
							contentId: artifactInfo.contentId,
							onProgress: (progress: ParseProgress) => {
								emitProgress(name, version, progress);
								if (progress.tree) {
									if (progress.type === 'snapshot') {
										treeAccumulator.nodes.length = 0;
										treeAccumulator.edges.length = 0;
										for (const node of progress.tree.nodes) treeAccumulator.nodes.push(node);
										for (const edge of progress.tree.edges) treeAccumulator.edges.push(edge);
									} else {
										for (const node of progress.tree.nodes) treeAccumulator.nodes.push(node);
										for (const edge of progress.tree.edges) treeAccumulator.edges.push(edge);
									}
									if (progress.nodeCount > 0) {
										lc.finalizeCrate(name, version, treeAccumulator, progress.nodeCount, progress.edgeCount);
									}
								}
								const key = statusKey(name, version);
								const existing = progressState.get(key);
								progressState.set(key, {
									sequence: progress.sequence,
									contentId: progress.contentId ?? existing?.contentId,
									snapshot: progress.type === 'snapshot' && progress.tree
										? { nodes: progress.tree.nodes.slice(), edges: progress.tree.edges.slice() }
										: existing?.snapshot
								});
							}
						}
					)
				);

				log.info`Parsed ${name}@${version}: ${result.nodeCount} nodes, ${(performance.now() - t0).toFixed(0)}ms`;
				return result;
			});

			// store-graph
			await step.do('store-graph', async () => {
				emitStatus(name, version, { status: 'processing' }, 'storing');
				const lc = getCache();
				const index: CrateIndex = {
					name,
					version,
					crates: [{ id: normalizedName, name, version, is_external: false }]
				};
				lc.initCrate(name, version, index);
				lc.finalizeCrate(name, version, parseResult.tree, parseResult.nodeCount, parseResult.edgeCount);
				lc.replaceCrossEdges(
					'rust', name, version,
					crossEdgesList,
					Array.from(crossNodeMap.values())
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
				emitStatus(name, version, { status: 'ready' });
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

	async function parseStdCrate(name: string, version: string, installConsent: boolean): Promise<void> {
		const workflow = new ParseStdCrateWorkflow();
		const result = await runWorkflow(workflow, { name, version, installConsent }, {
			onStepStart(stepName) {
				log.info`[std-workflow] step started: ${stepName} for ${name}@${version}`;
			},
			onStepError(stepName, error, attempt) {
				log.error`[std-workflow] step "${stepName}" failed (attempt ${String(attempt)}): ${error.message}`;
			}
		});

		if (result.isErr()) {
			const err = result.error;
			log.error`Failed to parse std ${name}@${version}: ${err.message} (step: ${err.failedStep})`;
			emitStatus(name, version, { status: 'failed', error: err.message }, err.failedStep);
		}
	}

	function autoTriggerStdCrates(crates: Array<{ name: string; version: string; is_external?: boolean }>): void {
		const lc = getCache();
		for (const c of crates) {
			if (!isStdCrate(c.name) || !STD_JSON_CRATES.includes(c.name)) continue;
			if (lc.hasCrate(c.name, c.version)) continue;
			const key = parseKey(c.name, c.version);
			if (inFlight.has(key)) continue;
			// Fire-and-forget: try to parse from sysroot (no install consent)
			findStdJson(c.name, c.version).then((info) => {
				if (info.available) {
					log.info`Auto-triggering std crate parse: ${c.name}@${c.version}`;
					startStdParse(c.name, c.version, false);
				}
			}).catch(() => {
				// Silently ignore — sysroot detection failure is non-fatal
			});
		}
	}

	return {
		async loadWorkspace() {
			if (cached) return cached;
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
		},

		async loadSourceFile(
			file: string,
			crateName?: string,
			crateVersion?: string,
			sourceProvider: 'auto' | 'crates-io' | 'github' = 'auto'
		) {
			const workspaceRoot = process.env.CODEVIEW_WORKSPACE;
			if (workspaceRoot) {
				const fullPath = join(workspaceRoot, file);
				const resolved = resolve(fullPath);
				if (!resolved.startsWith(resolve(workspaceRoot))) {
					return { error: 'Path outside workspace', content: null };
				}
				const localResult = await Result.tryPromise(() => readFile(resolved, 'utf-8'));
				if (localResult.isOk()) {
					return { error: null, content: localResult.value };
				}
			}

			if (!crateName || !crateVersion) {
				return { error: 'File not found', content: null };
			}

			const cacheKey = sourceCacheKey(crateName, crateVersion, file, sourceProvider);
			const cachedContent = getCachedSourceFile(cacheKey);
			if (cachedContent !== null) {
				return { error: null, content: cachedContent };
			}

			const sourceAdapterResult = getSourceAdapter('rust');
			if (sourceAdapterResult.isErr()) {
				return { error: sourceAdapterResult.error.message, content: null };
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
				return { error: 'Source metadata unavailable', content: null };
			}

			if ((sourceProvider === 'auto' || sourceProvider === 'crates-io') && metadata.sourceArchiveUrl) {
				const direct = await fetchSourceFileFromArchive(metadata.sourceArchiveUrl, file, {
					maxBytes: SOURCE_MAX_BYTES,
					userAgent: USER_AGENT
				});
				if (direct.status === 'ok') {
					setCachedSourceFile(cacheKey, direct.content);
					return { error: null, content: direct.content };
				}
				if (sourceProvider === 'crates-io') {
					return { error: direct.status === 'error' ? direct.message : 'Source file not available', content: null };
				}
			}

			const providers = sourceAdapterResult.value.getProviders({
				ecosystem: 'rust',
				name: metadata.name,
				version: metadata.version,
				metadata
			});
			const selectedProviders = selectSourceProviders(providers, sourceProvider);
			const files = await fetchSourcesWithProviders(
				selectedProviders,
				{ ecosystem: 'rust', name: metadata.name, version: metadata.version, metadata },
				{ maxBytes: SOURCE_MAX_BYTES, userAgent: USER_AGENT }
			);
			if (!files) {
				return { error: 'Source file not available', content: null };
			}

			const content = resolveSourceFileFromMap(files, file);
			if (content === null) {
				return { error: 'File not found', content: null };
			}
			setCachedSourceFile(cacheKey, content);
			return { error: null, content };
		},

		async loadCrateGraph(name: string, _version: string) {
			// Check workspace first
			const ws = await this.loadWorkspace();
			if (ws) {
				const found = ws.crates.find((c) => c.name === name || c.id === name);
				if (found) return found;
			}

			// Check local cache for external crates
			const lc = getCache();
			return lc.getGraph(name, _version);
		},

		async loadCrateTree(name: string, _version: string) {
			const lc = getCache();
			const tree = lc.getTree(name, _version);
			log.info`loadCrateTree(local) name=${name} version=${_version} hit=${tree ? 'yes' : 'no'}${tree ? ` nodes=${tree.nodes.length} edges=${tree.edges.length}` : ''}`;
			return tree;
		},

		async loadCrateIndex(name: string, version: string): Promise<CrateIndex | null> {
			const ws = await this.loadWorkspace();
			if (ws) {
				// Check if crate is in workspace
				const inWorkspace = ws.crates.some(
					(c) => c.id === name || c.name === name
				);
				if (inWorkspace) {
					const crates: Array<{
						id: string;
						name: string;
						version: string;
						is_external?: boolean;
					}> = ws.crates.map((c) => ({
						id: c.id,
						name: c.name,
						version: c.version
					}));
					for (const ext of ws.external_crates) {
						const extVersion =
							ext.version ?? (isStdCrate(ext.name) ? 'stable' : 'latest');
						crates.push({
							id: ext.id,
							name: ext.name,
							version: extVersion,
							is_external: true
						});
					}
					const current = crates.find(
						(c) => c.id === name || c.name === name
					);

					// Fire-and-forget: auto-trigger std crate parsing for available sysroot JSON
					autoTriggerStdCrates(crates);

					return {
						name: current?.name ?? name,
						version: current?.version ?? version,
						crates
					};
				}
			}

			// Check local cache for external crates
			const lc = getCache();
			return lc.getIndex(name, version);
		},

		async loadNodeDetail(name: string, version: string, nodeId: string): Promise<NodeDetail | null> {
			const lc = getCache();

			// Load node and its edges
			const node = lc.getNodeById(name, version, nodeId);
			if (!node) return null;

			const nodeEdges = lc.getEdgesForNode(name, version, nodeId);

			// Get related nodes (targets of edges)
			const relatedIds = new Set<string>();
			for (const edge of nodeEdges) {
				if (edge.from !== nodeId) relatedIds.add(edge.from);
				if (edge.to !== nodeId) relatedIds.add(edge.to);
			}

			// Load related nodes
			const relatedNodes: NodeSummary[] = [];
			for (const id of relatedIds) {
				const related = lc.getNodeById(name, version, id);
				if (related) {
					relatedNodes.push({
						id: related.id,
						name: related.name,
						kind: related.kind,
						visibility: related.visibility,
						is_external: related.is_external
					});
				}
			}

			return {
				node,
				edges: nodeEdges,
				relatedNodes
			};
		},

		async getCrossEdgeData(nodeId: string): Promise<CrossEdgeData> {
			const lc = getCache();
			const result = lc.getCrossEdgeData('rust', nodeId);
			return {
				edges: result.edges.map((edge) => ({
					...edge,
					kind: edge.kind as EdgeKind,
					confidence: edge.confidence as Confidence
				})),
				nodes: result.nodes.map((node) => ({
					...node,
					kind: node.kind as NodeKind,
					visibility: node.visibility as Visibility
				}))
			};
		},

		async getCrateStatus(name: string, version: string): Promise<CrateStatus> {
			if (isStdCrate(name)) {
				// Check cache first
				const lc = getCache();
				if (lc.hasCrate(name, version)) {
					emitStatus(name, version, { status: 'ready' });
					return { status: 'ready' };
				}
				const dbStatus = lc.getStatus('rust', name, version);
				if (dbStatus.status !== 'unknown') return dbStatus;

				// Check sysroot availability
				try {
					const stdInfo = await findStdJson(name, version);
					if (stdInfo.available) return { status: 'unknown' }; // auto-triggerable

					// Mismatch — needs user consent to install
					return {
						status: 'failed',
						error: `std ${version} not installed. Available: ${stdInfo.installedVersion ?? 'none'}`,
						action: 'install_std_docs',
						installedVersion: stdInfo.installedVersion,
					};
				} catch {
					return { status: 'failed', error: `Failed to detect sysroot for ${name}` };
				}
			}

			// Check SQLite status first
			try {
				const lc = getCache();
				const dbStatus = lc.getStatus('rust', name, version);
				if (dbStatus.status !== 'unknown') return dbStatus;

				// Check if graph exists in cache
				if (lc.hasCrate(name, version)) {
					emitStatus(name, version, { status: 'ready' });
					return { status: 'ready' };
				}
			} catch {}

			// Check workspace
			const ws = await this.loadWorkspace();
			if (ws) {
				const found = ws.crates.some(
					(c) => c.name === name || c.id === name
				);
				if (found) return { status: 'ready' };
			}

			return { status: 'unknown' };
		},

		async triggerParse(name: string, version: string, force?: boolean) {
			if (isStdCrate(name)) {
				// Check if sysroot JSON is available (no install consent)
				const stdInfo = await findStdJson(name, version);
				if (!stdInfo.available) {
					return Result.err(new NotAvailableError({ message: `${name}@${version} not available in sysroot` }));
				}
				const lc = getCache();
				if (!force && lc.hasCrate(name, version)) {
					emitStatus(name, version, { status: 'ready' });
					return Result.ok(undefined);
				}
				emitStatus(name, version, { status: 'processing' }, 'resolving');
				startStdParse(name, version, false);
				return Result.ok(undefined);
			}
			if (!isValidCrateName(name) || !isValidVersion(version)) {
				return Result.err(new ValidationError({ message: 'Invalid crate name or version' }));
			}

			const lc = getCache();

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
					emitStatus(name, version, { status: 'ready' });
					return Result.ok(undefined);
				}
			}

			// Set status atomically BEFORE starting the parse
			emitStatus(name, version, { status: 'processing' }, 'resolving');
			startParse(name, version);
			return Result.ok(undefined);
		},

		async triggerStdInstall(name: string, version: string) {
			if (!isStdCrate(name)) {
				return Result.err(new ValidationError({ message: `${name} is not a standard library crate` }));
			}
			const lc = getCache();
			if (lc.hasCrate(name, version)) {
				emitStatus(name, version, { status: 'ready' });
				return Result.ok(undefined);
			}
			emitStatus(name, version, { status: 'processing' }, 'resolving');
			startStdParse(name, version, true);
			return Result.ok(undefined);
		},

		async searchRegistry(query: string): Promise<CrateSummaryResult[]> {
			const results = await registry.search(query);
			return results.map((r) => ({
				name: r.name,
				version: r.version,
				description: r.description
			}));
		},

		async getTopCrates(limit = 10): Promise<CrateSummaryResult[]> {
			const results = await registry.listTop(limit);
			return results.map((r) => ({
				name: r.name,
				version: r.version,
				description: r.description
			}));
		},

		async getProcessingCrates(limit = 20): Promise<CrateSummaryResult[]> {
			const lc = getCache();
			return lc.getProcessingCrates('rust', limit);
		},

		async streamCrateStatus(
			name: string,
			version: string,
			signal: AbortSignal
		): Promise<Response> {
			const status = await this.getCrateStatus(name, version);

			// Terminal states — single event
			if (status.status === 'ready' || status.status === 'failed') {
				const statusJson = Result.try(() => JSON.stringify(status)).unwrapOr('{"status":"unknown"}');
				return sseResponse(`data: ${statusJson}\n\n`, signal, { ttl: 500 });
			}

			// For unknown crates, auto-trigger parse and stream updates
			if (status.status === 'unknown' && isValidCrateName(name) && isValidVersion(version)) {
				const triggerResult = await this.triggerParse(name, version);
				if (triggerResult.isErr()) {
					// Std crates and other non-parseable crates — return unknown status
					const statusJson = Result.try(() => JSON.stringify(status)).unwrapOr('{"status":"unknown"}');
					return sseResponse(`data: ${statusJson}\n\n`, signal, { ttl: 500 });
				}
			}

			// Stream updates
			return sseStreamResponse((push, close) => {
				// Send current status immediately
				const lc = getCache();
				const current = lc.getStatus('rust', name, version);
				if (current.status !== 'unknown') {
					const json = Result.try(() => JSON.stringify(current)).unwrapOr('{"status":"unknown"}');
					push(`data: ${json}\n\n`);
					if (current.status === 'ready' || current.status === 'failed') {
						close();
						return () => {};
					}
				}

				const unsubscribe = subscribe(name, version, (s) => {
					const json = Result.try(() => JSON.stringify(s)).unwrapOr('{"status":"unknown"}');
					push(`data: ${json}\n\n`);
					if (s.status === 'ready' || s.status === 'failed') {
						close();
					}
				});
				return unsubscribe;
			}, signal);
		},

		async streamProcessingStatus(_ecosystem: string, signal: AbortSignal): Promise<Response> {
			return sseStreamResponse((push, _close) => {
				// Send current count immediately
				const lc = getCache();
				const cnt = lc.getProcessingCount('rust');
				const json = Result.try(() => JSON.stringify({ type: 'processing', count: cnt })).unwrapOr('{"type":"processing","count":0}');
				push(`data: ${json}\n\n`);

				const unsubscribe = subscribeProcessing((c) => {
					const json = Result.try(() => JSON.stringify({ type: 'processing', count: c })).unwrapOr('{"type":"processing","count":0}');
					push(`data: ${json}\n\n`);
				});
				return unsubscribe;
			}, signal, { ttl: 300_000 });
		},

		async streamEdgeUpdates(nodeId: string, signal: AbortSignal): Promise<Response> {
			return sseStreamResponse((push, _close) => {
				const unsubscribe = subscribeEdge(nodeId, (data) => {
					const json = Result.try(() => JSON.stringify(data)).unwrapOr('{}');
					push(`data: ${json}\n\n`);
				});
				return unsubscribe;
			}, signal, { ttl: 120_000 });
		},

		async streamParseProgress(
			name: string,
			version: string,
			signal: AbortSignal,
			options?: { since?: number; contentId?: string | null }
		): Promise<Response> {
			return sseStreamResponse((push, close) => {
				// Send current tree if available
				const lc = getCache();
				const key = statusKey(name, version);
				const state = progressState.get(key);
				const stateSequence = state?.sequence ?? -1;
				const contentMatches = !options?.contentId || options.contentId === state?.contentId;
				const shouldSendSnapshot = Boolean(state?.snapshot)
					&& (!contentMatches || options?.since === undefined || options.since < stateSequence);
				const status = lc.getStatus('rust', name, version).status;
				const tree = shouldSendSnapshot
					? state?.snapshot
					: (status === 'processing' ? null : lc.getTree(name, version));
				if (tree) {
					const json = Result.try(() => JSON.stringify({
						type: 'snapshot',
						sequence: state?.sequence,
						contentId: state?.contentId,
						tree,
						nodeCount: tree.nodes.length,
						edgeCount: tree.edges.length
					})).unwrapOr('{}');
					push(`data: ${json}\n\n`);
				}

				const unsubscribeProgress = subscribeProgress(name, version, (progress) => {
					const json = Result.try(() => JSON.stringify(progress)).unwrapOr('{}');
					push(`data: ${json}\n\n`);
				});

				// Also listen for status changes to close stream when ready
				const unsubscribeStatus = subscribe(name, version, (status) => {
					if (status.status === 'ready' || status.status === 'failed') {
						// Send final tree
						const finalTree = lc.getTree(name, version);
						if (finalTree) {
							const latest = progressState.get(key);
							const json = Result.try(() => JSON.stringify({
								type: 'complete',
								sequence: latest?.sequence,
								contentId: latest?.contentId,
								tree: finalTree,
								nodeCount: finalTree.nodes.length,
								edgeCount: finalTree.edges.length
							})).unwrapOr('{}');
							push(`data: ${json}\n\n`);
						}
						close();
					}
				});

				return () => {
					unsubscribeProgress();
					unsubscribeStatus();
				};
			}, signal, { ttl: 300_000 }); // Keep stream stable during long parses
		},

		async getCrateVersions(name: string, limit = 20): Promise<string[]> {
			const ws = await this.loadWorkspace();
			const localVersion = ws?.crates.find(
				(c) => c.id === name || c.name === name
			)?.version;
			// Try both hyphen and underscore variants for registry lookup
			let registryVersions: string[] = [];
			for (const variant of crateNameVariants(name)) {
				registryVersions = await registry.listVersions(variant, limit);
				if (registryVersions.length > 0) break;
			}
			if (localVersion && !registryVersions.includes(localVersion)) {
				return [localVersion, ...registryVersions];
			}
			return registryVersions.length > 0
				? registryVersions
				: localVersion
					? [localVersion]
					: [];
		},

		// Shared event stream for multiplexed SSE
		streamSharedEvents: sharedEvents,

		async getLatestProgress(
			ecosystem: string,
			name: string,
			version: string
		): Promise<unknown> {
			const key = `${ecosystem}:${name}:${version}`;
			const state = progressState.get(key);
			if (!state?.snapshot) return null;
			return {
				type: 'snapshot',
				sequence: state.sequence,
				contentId: state.contentId,
				tree: state.snapshot,
				nodeCount: state.snapshot.nodes.length,
				edgeCount: state.snapshot.edges.length
			};
		}
	};
}

/** Build-time entry point — imported via the `$provider` alias (see vite.config.js). */
export function createProvider(_event: RequestEvent): DataProvider {
	return createLocalProvider();
}
