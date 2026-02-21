import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { CrateRegistry } from '$cloudflare/registry';
import type { GraphStore } from '$cloudflare/store';
import { getRegistry } from '$lib/server/registry/index';
import { parseWithProgressiveStorage } from '$lib/server/parser/streaming/adapter';
import type { Ecosystem } from '$lib/server/registry/types';
import type { Node, Edge } from '$lib/graph';
import { getLogger } from '$lib/log';
import { perf } from '$lib/perf';
import { decodeGzipStream } from '$lib/server/gzip';
import { isStdCrate } from '$lib/std';
import { normalizeCrateName } from '$lib/server/validation';
import { summarizeCrossEdgeNode, type CrossEdgeNodeSummary } from '$lib/server/cross-edges';

const log = getLogger('workflow');

interface ParseCrateParams {
	ecosystem: Ecosystem;
	name: string;
	version: string;
}

/**
 * Typed env for the codeview-services worker (see workers/wrangler.toml).
 * Narrows the global Env with typed DO/Workflow generics and secrets.
 * Run `bun run cf:types:services` to regenerate the source-of-truth types.
 */
type ServicesEnv = Omit<Env, 'GRAPH_STORE' | 'CRATE_REGISTRY' | 'PARSE_CRATE'> & {
	GRAPH_STORE: DurableObjectNamespace<GraphStore>;
	CRATE_REGISTRY: DurableObjectNamespace<CrateRegistry>;
	CRATE_GRAPHS: R2Bucket;
	PARSE_CRATE: Workflow<{ ecosystem: Ecosystem; name: string; version: string }>;
	GITHUB_TOKEN?: string;
};

import { USER_AGENT } from '$lib/server/provider-utils';

const VERSION_LOOKUP_CONCURRENCY = 6;
const FANOUT_CONCURRENCY = 4;
const ENABLE_DEPENDENCY_FANOUT = false;
const HOSTED_PARSE_BATCH_SIZE = 120;
const HOSTED_PARSE_YIELD_INTERVAL = 40;
const PARSE_STATUS_HEARTBEAT_MS = 15_000;
const nowMs = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());

type CrateIndexEntry = {
	id: string;
	name: string;
	version: string;
	is_external?: boolean;
};

type CrateIndex = {
	name: string;
	version: string;
	crates: CrateIndexEntry[];
};

type CrossEdgeNode = CrossEdgeNodeSummary;

type ParseStoreResult = {
	externalCrates: CrateIndexEntry[];
};

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

	export class ParseCrateWorkflow extends WorkflowEntrypoint<ServicesEnv, ParseCrateParams> {
	async run(event: WorkflowEvent<ParseCrateParams>, step: WorkflowStep) {
		const { ecosystem, name, version } = event.payload;
		const workflowInstanceId = event.instanceId;
		const treeKey = `${ecosystem}/${name}/${version}/tree.json`;
		log.info`workflow.run.start crate=${name}@${version} instance=${workflowInstanceId}`;

		const graphStoreStub = this.env.GRAPH_STORE.get(
			this.env.GRAPH_STORE.idFromName(`${ecosystem}/${name}/${version}`),
		);

		const registryStub = this.env.CRATE_REGISTRY.get(this.env.CRATE_REGISTRY.idFromName('global'));

		// Step 1: Check if the crate already exists (idempotent)
		const exists = await step.do('check-existing', async () => {
			const indexKey = `${ecosystem}/${name}/${version}/index.json`;
			const [treeHead, indexHead] = await Promise.all([
				this.env.CRATE_GRAPHS.head(treeKey),
				this.env.CRATE_GRAPHS.head(indexKey),
			]);
			return treeHead !== null && indexHead !== null;
		});

		if (exists) {
			await step.do('mark-ready-existing', async () => {
				await registryStub.setStatus(ecosystem, name, version, 'ready');
			});
			return;
		}

		// Step 2: Resolving — set status
		await step.do('set-status-resolving', async () => {
			log.debug`${name}@${version} → resolving`;
			await registryStub.setStatus(ecosystem, name, version, 'processing', undefined, 'resolving');
		});

		try {
			// Step 3: Resolve metadata from registry (e.g. crates.io)
			const metadata = await step.do(
				'resolve-metadata',
				{ retries: { limit: 2, delay: '1 second', backoff: 'exponential' } },
				async () => {
					const registryResult = getRegistry(ecosystem);
					if (registryResult.isErr()) throw registryResult.error;
					const meta = await registryResult.value.resolve(name, version);
					if (!meta) throw new Error(`Package not found: ${name}@${version}`);
					return meta;
				},
			);

			// Step 4: Fetching — set status
			await step.do('set-status-fetching', async () => {
				log.debug`${name}@${version} → fetching`;
				await registryStub.setStatus(ecosystem, name, version, 'processing', undefined, 'fetching');
			});

			// Step 5: Fetch artifact, parse, and store.
			// Uses streaming progressive JSON parsing for all crates.
			const parseStore = await step.do(
				'fetch-parse-store',
				async (): Promise<ParseStoreResult> => {
					const parseSession = `${Date.now()}-${crypto.randomUUID()}`;
					let lastParseHeartbeatAt = nowMs();
					log.info`parse.phase.start crate=${name}@${version} instance=${workflowInstanceId} session=${parseSession}`;
					await Promise.all([
						graphStoreStub.deleteCrate(ecosystem, name, version),
						registryStub.beginCrossEdgeIngest(ecosystem, name, version),
					]);

					const artifactUrl =
						metadata.artifactUrl ?? `https://docs.rs/crate/${name}/${version}/json.gz`;

					const artifactRes = await fetch(artifactUrl, {
						headers: { 'User-Agent': USER_AGENT },
					});
					if (!artifactRes.ok) {
						throw new Error(
							`Failed to fetch artifact: ${artifactRes.status} ${artifactRes.statusText}`,
						);
					}

					// docs.rs serves rustdoc JSON as gzip (application/gzip) at /json.gz
					const contentType = artifactRes.headers.get('content-type') ?? '';
					const contentLength = Number(artifactRes.headers.get('content-length') ?? '0');
					if (!artifactRes.body) {
						throw new Error('Artifact response has no body for streaming');
					}
					let artifactInput: ReadableStream<Uint8Array> = artifactRes.body;
					if (contentType.includes('gzip')) {
						artifactInput = decodeGzipStream(artifactInput);
					}

					const sizeLabel =
						contentLength > 0
							? `${(contentLength / 1024 / 1024).toFixed(1)} MB compressed`
							: 'unknown size';
					log.debug`${name}@${version} → parsing (${sizeLabel})`;
					await registryStub.setStatus(
						ecosystem,
						name,
						version,
						'processing',
						undefined,
						'parsing',
					);

					// Initialize crate in DO (will be updated with tree after parse)
					const initialIndex: CrateIndex = { name, version, crates: [] };
					await graphStoreStub.initCrate(
						ecosystem,
						name,
						version,
						JSON.stringify(initialIndex),
						parseSession,
					);

					// Track node summaries for cross-edge detection
					const nodeSummaries = new Map<string, CrossEdgeNodeSummary>();
					const pendingCrossEdges: Array<{
						from: string;
						to: string;
						kind: string;
						confidence: string;
					}> = [];
					const crossNodeMap = new Map<string, CrossEdgeNode>();
					const CROSS_EDGE_FLUSH_BATCH = 600;
					const CROSS_NODE_FLUSH_BATCH = 1000;
					const crossEdgeIngest = {
						calls: 0,
						totalMs: 0,
						maxMs: 0,
						totalEdges: 0,
						slowCalls: 0,
					};
					const normalizedName = normalizeCrateName(name);

					const cratePrefix = (id: string): string => id.split('::')[0] ?? id;
					const isExternalNode = (id: string): boolean => cratePrefix(id) !== normalizedName;

					const flushCrossEdgeBatch = async (force = false): Promise<void> => {
						if (!force && pendingCrossEdges.length < CROSS_EDGE_FLUSH_BATCH) return;
						if (pendingCrossEdges.length === 0) return;
						const batchSize = pendingCrossEdges.length;
						const startedAt = nowMs();
						await registryStub.appendCrossEdgeBatch(
							ecosystem,
							name,
							version,
							pendingCrossEdges,
							[],
						);
						const elapsedMs = nowMs() - startedAt;
						crossEdgeIngest.calls += 1;
						crossEdgeIngest.totalMs += elapsedMs;
						crossEdgeIngest.totalEdges += batchSize;
						if (elapsedMs > crossEdgeIngest.maxMs) {
							crossEdgeIngest.maxMs = elapsedMs;
						}
						if (elapsedMs >= 250) {
							crossEdgeIngest.slowCalls += 1;
						}
						if (force || elapsedMs >= 250 || crossEdgeIngest.calls % 50 === 0) {
							log.info`parse.cross-edge.flush crate=${name}@${version} call=${String(crossEdgeIngest.calls)} batchEdges=${String(batchSize)} elapsedMs=${elapsedMs.toFixed(1)} totalEdges=${String(crossEdgeIngest.totalEdges)}`;
						}
						pendingCrossEdges.length = 0;
					};

					// Create storage callbacks that write to the DO
					const storageCallbacks = {
						storeNodes: async (nodes: Node[]) => {
							for (const node of nodes) {
								nodeSummaries.set(node.id, {
									id: node.id,
									name: node.name,
									kind: node.kind,
									visibility: node.visibility,
									is_external: node.is_external,
								});
							}
							await graphStoreStub.storeNodes(ecosystem, name, version, nodes, parseSession);
						},
						storeEdges: async (edgeList: Edge[]) => {
							for (const edge of edgeList) {
								if (cratePrefix(edge.from) !== cratePrefix(edge.to)) {
									pendingCrossEdges.push({
										from: edge.from,
										to: edge.to,
										kind: edge.kind,
										confidence: edge.confidence,
									});
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
							await flushCrossEdgeBatch();
							await graphStoreStub.storeEdges(ecosystem, name, version, edgeList, parseSession);
						},
					};

					// Parse with progressive storage + progress count updates
					const parseStartedAt = nowMs();
					const result = await perf.timeAsync('parser', `parse ${name}@${version}`, () =>
						parseWithProgressiveStorage(artifactInput, name, storageCallbacks, {
							// Keep DO RPC payloads comfortably below workerd's ~32MB limit.
							batchSize: HOSTED_PARSE_BATCH_SIZE,
							yieldInterval: HOSTED_PARSE_YIELD_INTERVAL,
							skipExternalNodes: true,
							// Hosted parse path: minimize in-memory parser state to avoid workerd memory blowups.
							retainItemIndex: false,
							dedupeEdgesInMemory: false,
							// Keep parse path low-memory; root-reachable tree canonicalization happens on read path.
							pruneOrphanTreeNodes: false,
							onProgress: (progress) => {
								if (progress.type !== 'delta') return;
								const now = nowMs();
								if (now - lastParseHeartbeatAt >= PARSE_STATUS_HEARTBEAT_MS) {
									lastParseHeartbeatAt = now;
									this.ctx.waitUntil(
										registryStub.touchProcessing(ecosystem, name, version, 'parsing').catch(() => {}),
									);
								}
								this.ctx.waitUntil(
									registryStub
										.broadcastProgress(ecosystem, name, version, {
											type: 'delta',
											nodeCount: progress.nodeCount,
											edgeCount: progress.edgeCount,
										})
										.catch(() => {}),
								);
							},
						}),
					);
					const parseElapsedMs = nowMs() - parseStartedAt;
					log.info`parse.stream.done crate=${name}@${version} instance=${workflowInstanceId} session=${parseSession} parseMs=${parseElapsedMs.toFixed(1)} nodes=${String(result.nodeCount)} edges=${String(result.edgeCount)} pendingCrossEdges=${String(pendingCrossEdges.length)}`;
					log.info`parse.cross-edge.force-flush.start crate=${name}@${version} instance=${workflowInstanceId} session=${parseSession} pendingEdges=${String(pendingCrossEdges.length)}`;
					await flushCrossEdgeBatch(true);
					log.info`parse.cross-edge.force-flush.done crate=${name}@${version} instance=${workflowInstanceId} session=${parseSession}`;
					const crossNodes = Array.from(crossNodeMap.values());
					const crossNodeIngestStartedAt = nowMs();
					for (let i = 0; i < crossNodes.length; i += CROSS_NODE_FLUSH_BATCH) {
						const chunk = crossNodes.slice(i, i + CROSS_NODE_FLUSH_BATCH);
						const chunkStartedAt = nowMs();
						await registryStub.appendCrossEdgeBatch(
							ecosystem,
							name,
							version,
							[],
							chunk,
						);
						const chunkElapsedMs = nowMs() - chunkStartedAt;
						if (chunkElapsedMs >= 250 || i === 0 || i + CROSS_NODE_FLUSH_BATCH >= crossNodes.length) {
							log.info`parse.cross-node.flush crate=${name}@${version} chunkStart=${String(i)} chunkSize=${String(chunk.length)} elapsedMs=${chunkElapsedMs.toFixed(1)}`;
						}
					}
					const crossNodeElapsedMs = nowMs() - crossNodeIngestStartedAt;
					const crossAvgMs =
						crossEdgeIngest.calls > 0 ? crossEdgeIngest.totalMs / crossEdgeIngest.calls : 0;
					log.info`parse.phase.done crate=${name}@${version} instance=${workflowInstanceId} session=${parseSession} parseMs=${parseElapsedMs.toFixed(1)} nodes=${String(result.nodeCount)} edges=${String(result.edgeCount)} crossEdgeCalls=${String(crossEdgeIngest.calls)} crossEdgeAvgMs=${crossAvgMs.toFixed(1)} crossEdgeMaxMs=${crossEdgeIngest.maxMs.toFixed(1)} crossEdgeSlowCalls=${String(crossEdgeIngest.slowCalls)} crossNodeCount=${String(crossNodes.length)} crossNodeMs=${crossNodeElapsedMs.toFixed(1)}`;

					// Emit complete event (counts only — sidebar uses lazy RPC for tree)
					this.ctx.waitUntil(
						registryStub
							.broadcastProgress(ecosystem, name, version, {
								type: 'complete',
								nodeCount: result.nodeCount,
								edgeCount: result.edgeCount,
								totalItems: result.nodeCount,
							})
							.catch(() => {}),
					);

					// Resolve external crates
					const registryResult2 = getRegistry(ecosystem);
					if (registryResult2.isErr()) throw registryResult2.error;
					const registry = registryResult2.value;
					const latestCache = new Map<string, string | null>();

					async function getLatestVersion(candidate: string): Promise<string | null> {
						if (latestCache.has(candidate)) return latestCache.get(candidate)!;
						const resolved = await registry.getLatestVersion(candidate);
						latestCache.set(candidate, resolved);
						return resolved;
					}

					async function resolveExternalEntry(ext: {
						id: string;
						name: string;
					}): Promise<CrateIndexEntry | null> {
						const candidates = [
							ext.name,
							ext.id,
							normalizeCrateName(ext.name),
							normalizeCrateName(ext.id),
						].filter((value, index, all) => value && all.indexOf(value) === index);

						for (const candidate of candidates) {
							const latest = await getLatestVersion(candidate);
							if (latest) {
								return {
									id: ext.id,
									name: candidate,
									version: latest,
									is_external: true,
								};
							}
						}
						return null;
					}

					const externalCrates: { id: string; name: string }[] = [];
					const seenExternal = new Set<string>();
					for (const c of result.externalCrates) {
						if (seenExternal.has(c.id)) continue;
						seenExternal.add(c.id);
						if (isStdCrate(c.name) || isStdCrate(c.id)) continue;
						externalCrates.push({ id: c.id, name: c.name });
					}
					const externalEntries = await mapWithConcurrency(
						externalCrates,
						VERSION_LOOKUP_CONCURRENCY,
						resolveExternalEntry,
					);
					const filteredExternal = externalEntries.filter((e): e is CrateIndexEntry => e !== null);

					// Build final index
					const index: CrateIndex = {
						name,
						version,
						crates: [
							{ id: normalizedName, name, version, is_external: false },
							...filteredExternal,
						],
					};

					// Finalize crate in DO with counts only.
					// Tree JSON is stored in R2 below to avoid large DO RPC payloads.
					log.debug`${name}@${version} → storing (progressive)`;
					await registryStub.setStatus(
						ecosystem,
						name,
						version,
						'processing',
						undefined,
						'storing',
					);
					const treeJson = JSON.stringify(result.tree);
					const indexJson = JSON.stringify(index);
					const toJsonStream = (label: string, value: string): ReadableStream<Uint8Array> => {
						const encoder = new TextEncoder();
						const CHUNK_SIZE = 256 * 1024;
						let expectedLength = 0;
						for (let i = 0; i < value.length; i += CHUNK_SIZE) {
							const end = Math.min(i + CHUNK_SIZE, value.length);
							expectedLength += encoder.encode(value.slice(i, end)).byteLength;
						}

						const stream = new FixedLengthStream(expectedLength);
						this.ctx.waitUntil(
							(async () => {
								const drainStartedAt = nowMs();
								const writer = stream.writable.getWriter();
								try {
									for (let i = 0; i < value.length; i += CHUNK_SIZE) {
										const end = Math.min(i + CHUNK_SIZE, value.length);
										await writer.write(encoder.encode(value.slice(i, end)));
									}
									await writer.close();
									const drainElapsedMs = nowMs() - drainStartedAt;
									log.debug`parse.r2-stream-drain crate=${name}@${version} session=${parseSession} target=${label} bytes=${String(expectedLength)} callbackMs=${drainElapsedMs.toFixed(1)}`;
								} catch (err) {
									await writer.abort(err);
									throw err;
								}
							})(),
						);
						return stream.readable;
					};

					const finalizeStartedAt = nowMs();
					log.info`parse.finalize.start crate=${name}@${version} instance=${workflowInstanceId} session=${parseSession}`;

					await graphStoreStub.finalizeCrate(
						ecosystem,
						name,
						version,
						result.nodeCount,
						result.edgeCount,
						null,
						parseSession,
					);

					// Also store index and tree to R2 for fast access
					const parsedAt = new Date().toISOString();
					const indexKey = `${ecosystem}/${name}/${version}/index.json`;
					const treeKey = `${ecosystem}/${name}/${version}/tree.json`;

					await Promise.all([
						this.env.CRATE_GRAPHS.put(indexKey, toJsonStream('index.json', indexJson), {
							httpMetadata: { contentType: 'application/json' },
							customMetadata: { ecosystem, name, version, parsedAt },
						}),
						this.env.CRATE_GRAPHS.put(treeKey, toJsonStream('tree.json', treeJson), {
							httpMetadata: { contentType: 'application/json' },
							customMetadata: { ecosystem, name, version, parsedAt },
						}),
					]);
					result.tree.nodes.length = 0;
					result.tree.edges.length = 0;
					const finalizeElapsedMs = nowMs() - finalizeStartedAt;
					log.info`parse.finalize.done crate=${name}@${version} instance=${workflowInstanceId} session=${parseSession} finalizeMs=${finalizeElapsedMs.toFixed(1)} indexBytes=${String(indexJson.length)} treeBytes=${String(treeJson.length)}`;

					return {
						externalCrates: filteredExternal,
					};
				},
			);

			// Step 6: Indexing — set status
			await step.do('set-status-indexing', async () => {
				log.debug`${name}@${version} → indexing`;
				await registryStub.setStatus(ecosystem, name, version, 'processing', undefined, 'indexing');
			});

			// Step 7: Fan out parsing for external dependencies
			await step.do('fanout-dependencies', async () => {
				if (!ENABLE_DEPENDENCY_FANOUT) return;

				try {
					await mapWithConcurrency(
						parseStore.externalCrates,
						FANOUT_CONCURRENCY,
						async (entry) => {
							if (!entry.name || entry.name === name) return;
							await registryStub.requestParse(ecosystem, entry.name, entry.version, {
								source: 'workflow.fanout-dependencies',
							});
						},
					);
				} catch (err) {
					log.warn`Fanout parse scheduling failed: ${err}`;
				}
			});

			// Step 8: Mark as ready
			await step.do('set-status-ready', async () => {
				await registryStub.setStatus(ecosystem, name, version, 'ready');
			});
		} catch (err) {
			// On failure: mark status as failed with error message
			const errorMessage = err instanceof Error ? err.message : String(err);
			log.error`workflow failed ${name}@${version} instance=${workflowInstanceId}: ${errorMessage}`;
			const action = /Failed to fetch artifact:.*\b404\b/.test(errorMessage)
				? 'docs_unavailable'
				: undefined;
			await step.do('cleanup-partial-data', async () => {
				await Promise.allSettled([
					graphStoreStub.deleteCrate(ecosystem, name, version),
					registryStub.beginCrossEdgeIngest(ecosystem, name, version),
				]);
			});
			await step.do('set-status-failed', async () => {
				log.warn`set-status-failed ${name}@${version} error=${errorMessage} action=${action ?? 'none'}`;
				await registryStub.setStatus(
					ecosystem,
					name,
					version,
					'failed',
					errorMessage,
					undefined,
					action,
				);
			});
			throw err;
		}
		finally {
			log.info`workflow.run.end crate=${name}@${version} instance=${workflowInstanceId}`;
		}
	}
}
