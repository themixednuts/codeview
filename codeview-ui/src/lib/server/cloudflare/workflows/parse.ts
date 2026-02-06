import { Result } from 'better-result';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { CrateRegistry } from '$cloudflare/registry';
import type { GraphStore } from '$cloudflare/store';
import { getRegistry } from '$lib/server/registry/index';
import { getSourceAdapter } from '$lib/server/sources/index';
import { fetchSourcesWithProviders } from '$lib/server/sources/runner';
import { parseWithProgressiveStorage } from '$lib/server/parser/streaming/adapter';
import type { Ecosystem } from '$lib/server/registry/types';
import type { Node, Edge } from '$lib/graph';
import { getLogger } from '$lib/log';
import { perf } from '$lib/perf';
import { decodeGzipStream } from '$lib/server/gzip';
import { getContentId } from '$lib/server/content';
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

import { USER_AGENT, SOURCE_MAX_BYTES } from '$lib/server/provider-utils';

const VERSION_LOOKUP_CONCURRENCY = 6;
const FANOUT_CONCURRENCY = 4;
const ENABLE_DEPENDENCY_FANOUT = false;

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

/** Serializable cross-edge data passed between workflow steps. */
type CrossEdgeStepResult = {
	edges: Array<{ from: string; to: string; kind: string; confidence: string }>;
	nodes: CrossEdgeNodeSummary[];
	externalCrates: CrateIndexEntry[];
	hasSources: boolean;
};

type CrossEdgeNode = CrossEdgeStepResult['nodes'][0];

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

export class ParseCrateWorkflow extends WorkflowEntrypoint<ServicesEnv, ParseCrateParams> {
	async run(event: WorkflowEvent<ParseCrateParams>, step: WorkflowStep) {
		const { ecosystem, name, version } = event.payload;
		const treeKey = `${ecosystem}/${name}/${version}/tree.json`;

		const graphStoreStub = this.env.GRAPH_STORE.get(
			this.env.GRAPH_STORE.idFromName(`${ecosystem}/${name}/${version}`)
		);

		const registryStub = this.env.CRATE_REGISTRY.get(
			this.env.CRATE_REGISTRY.idFromName('global')
		);

		// Step 1: Check if the crate already exists (idempotent)
		const exists = await step.do('check-existing', async () => {
			const [head, hasCrate] = await Promise.all([
				this.env.CRATE_GRAPHS.head(treeKey),
				graphStoreStub.hasCrate(ecosystem, name, version)
			]);
			return head !== null || hasCrate;
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
				}
			);

			// Step 4: Fetching — set status
			await step.do('set-status-fetching', async () => {
				log.debug`${name}@${version} → fetching`;
				await registryStub.setStatus(ecosystem, name, version, 'processing', undefined, 'fetching');
			});

			// Step 5: Fetch artifact, parse, and store.
			// Uses streaming progressive JSON parsing for all crates.
			await step.do(
				'fetch-parse-store',
				{ retries: { limit: 2, delay: '2 seconds', backoff: 'exponential' } },
				async () => {
					const artifactUrl =
						metadata.artifactUrl ??
						`https://docs.rs/crate/${name}/${version}/json.gz`;

					const artifactRes = await fetch(artifactUrl, {
						headers: { 'User-Agent': USER_AGENT }
					});
					if (!artifactRes.ok) {
						throw new Error(
							`Failed to fetch artifact: ${artifactRes.status} ${artifactRes.statusText}`
						);
					}

					// docs.rs serves rustdoc JSON as gzip (application/gzip) at /json.gz
					const contentType = artifactRes.headers.get('content-type') ?? '';
					const contentId = getContentId(artifactRes.headers, `${name}@${version}`);
					const contentLength = Number(artifactRes.headers.get('content-length') ?? '0');
					if (!artifactRes.body) {
						throw new Error('Artifact response has no body for streaming');
					}
					let artifactInput: ReadableStream<Uint8Array> = artifactRes.body;
					if (contentType.includes('gzip')) {
						artifactInput = decodeGzipStream(artifactInput);
					}

					const sizeLabel = contentLength > 0
						? `${(contentLength / 1024 / 1024).toFixed(1)} MB compressed`
						: 'unknown size';
					log.debug`${name}@${version} → parsing (${sizeLabel})`;
					await registryStub.setStatus(ecosystem, name, version, 'processing', undefined, 'parsing');

					const sourceAdapterResult = getSourceAdapter(ecosystem);
					if (sourceAdapterResult.isErr()) throw sourceAdapterResult.error;
					const sourceAdapter = sourceAdapterResult.value;
					const providers = sourceAdapter.getProviders({
						ecosystem,
						name,
						version,
						metadata
					});
					// Fetch sources concurrently so parsing can stream immediately.
					const sourceFilesPromise = fetchSourcesWithProviders(
						providers,
						{ ecosystem, name, version, metadata },
						{
							maxBytes: SOURCE_MAX_BYTES,
							userAgent: USER_AGENT,
							githubToken: this.env.GITHUB_TOKEN
						}
					).catch((err) => {
						log.warn`Sources fetch failed for ${name}@${version}: ${String(err)}`;
						return null;
					});

					// Initialize crate in DO (will be updated with tree after parse)
					const initialIndex: CrateIndex = { name, version, crates: [] };
					await graphStoreStub.initCrate(ecosystem, name, version, JSON.stringify(initialIndex));

					// Track node summaries for cross-edge detection
					const nodeSummaries = new Map<string, CrossEdgeNodeSummary>();
					const crossEdgesList: CrossEdgeStepResult['edges'] = [];
					const crossNodeMap = new Map<string, CrossEdgeNodeSummary>();
					const normalizedName = normalizeCrateName(name);

					const cratePrefix = (id: string): string => id.split('::')[0] ?? id;
					const isExternalNode = (id: string): boolean => cratePrefix(id) !== normalizedName;

						// Create storage callbacks that write to the DO
						const storageCallbacks = {
							storeNodes: async (nodes: Node[]) => {
								for (const node of nodes) {
									nodeSummaries.set(node.id, {
										id: node.id,
										name: node.name,
										kind: node.kind,
										visibility: node.visibility,
										is_external: node.is_external
									});
								}
								await graphStoreStub.storeNodes(ecosystem, name, version, nodes);
							},
							storeEdges: async (edgeList: Edge[]) => {
								for (const edge of edgeList) {
									if (cratePrefix(edge.from) !== cratePrefix(edge.to)) {
										crossEdgesList.push({
											from: edge.from,
											to: edge.to,
											kind: edge.kind,
											confidence: edge.confidence
										});
										const fromNode = nodeSummaries.get(edge.from)
											?? summarizeCrossEdgeNode(edge.from, isExternalNode(edge.from)).unwrapOr(null);
										const toNode = nodeSummaries.get(edge.to)
											?? summarizeCrossEdgeNode(edge.to, isExternalNode(edge.to)).unwrapOr(null);
										if (fromNode) crossNodeMap.set(fromNode.id, fromNode);
										if (toNode) crossNodeMap.set(toNode.id, toNode);
									}
								}
								await graphStoreStub.storeEdges(ecosystem, name, version, edgeList);
							}
						};

						// Parse with progressive storage + SSE progress updates
						let lastSequence = -1;
						const result = await perf.timeAsync('parser', `parse ${name}@${version}`, () =>
							parseWithProgressiveStorage(
								artifactInput,
								name,
								storageCallbacks,
								{
								// Keep DO RPC payloads comfortably below workerd's ~32MB limit.
								batchSize: 200,
								skipExternalNodes: true,
								progressInterval: 200,
								snapshotInterval: 20000,
								contentId,
								onProgress: (progress) => {
									// Only broadcast deltas here. Snapshot/full-tree payloads can exceed
									// workerd's RPC serialization limits on very large crates.
									if (progress.type !== 'delta' || !progress.tree) return;
									lastSequence = progress.sequence;
									this.ctx.waitUntil(registryStub.broadcastProgress(ecosystem, name, version, {
										type: 'delta',
										sequence: progress.sequence,
										contentId: progress.contentId,
										nodeCount: progress.nodeCount,
										edgeCount: progress.edgeCount,
										tree: progress.tree
									}).catch(() => {}));
								}
							}
						)
					);

					const sourceFiles = await sourceFilesPromise;

						// Emit completion metadata only. Full tree payloads can exceed
						// workerd's RPC serialization limits.
					this.ctx.waitUntil(registryStub.broadcastProgress(ecosystem, name, version, {
						type: 'complete',
						sequence: lastSequence >= 0 ? lastSequence + 1 : 0,
						contentId,
						nodeCount: result.nodeCount,
						edgeCount: result.edgeCount
					}).catch(() => {}));

					const crossEdges = crossEdgesList;

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

						async function resolveExternalEntry(ext: { id: string; name: string }): Promise<CrateIndexEntry | null> {
							const candidates = [
								ext.name,
								ext.id,
								normalizeCrateName(ext.name),
								normalizeCrateName(ext.id)
							].filter((value, index, all) => value && all.indexOf(value) === index);

							for (const candidate of candidates) {
								const latest = await getLatestVersion(candidate);
								if (latest) {
									return {
										id: ext.id,
										name: candidate,
										version: latest,
										is_external: true
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
							resolveExternalEntry
						);
						const filteredExternal = externalEntries.filter((e): e is CrateIndexEntry => e !== null);

						// Build final index
						const index: CrateIndex = {
							name,
							version,
							crates: [
								{ id: normalizedName, name, version, is_external: false },
								...filteredExternal
							]
						};

						// Finalize crate in DO with counts only.
						// Tree JSON is stored in R2 below to avoid large DO RPC payloads.
						log.debug`${name}@${version} → storing (progressive)`;
						await registryStub.setStatus(ecosystem, name, version, 'processing', undefined, 'storing');
						const treeJson = JSON.stringify(result.tree);
						const indexJson = JSON.stringify(index);

						await graphStoreStub.finalizeCrate(
							ecosystem,
							name,
							version,
							result.nodeCount,
							result.edgeCount,
							null
						);

						// Also store index and tree to R2 for fast access
						const parsedAt = new Date().toISOString();
						const indexKey = `${ecosystem}/${name}/${version}/index.json`;
						const treeKey = `${ecosystem}/${name}/${version}/tree.json`;
						const crossEdgeKey = `${ecosystem}/${name}/${version}/_cross-edges.json`;
							const crossEdgePayload: CrossEdgeStepResult = {
								edges: crossEdges,
								nodes: Array.from(crossNodeMap.values()),
								externalCrates: filteredExternal,
								hasSources: sourceFiles !== null
							};

						await Promise.all([
							this.env.CRATE_GRAPHS.put(indexKey, indexJson, {
								httpMetadata: { contentType: 'application/json' },
								customMetadata: { ecosystem, name, version, parsedAt }
							}),
							this.env.CRATE_GRAPHS.put(treeKey, treeJson, {
								httpMetadata: { contentType: 'application/json' },
								customMetadata: { ecosystem, name, version, parsedAt }
							}),
							this.env.CRATE_GRAPHS.put(crossEdgeKey, JSON.stringify(crossEdgePayload), {
								httpMetadata: { contentType: 'application/json' }
							})
						]);
				}
			);

			// Step 6: Indexing — set status
			await step.do('set-status-indexing', async () => {
				log.debug`${name}@${version} → indexing`;
				await registryStub.setStatus(ecosystem, name, version, 'processing', undefined, 'indexing');
			});

			// Step 7: Index cross-edges into the registry DO
			// Reads cross-edge data from R2 (stored by fetch-parse-store step)
			await step.do(
				'index-cross-edges',
				{ retries: { limit: 2, delay: '2 seconds', backoff: 'exponential' } },
				async () => {
					const crossEdgeKey = `${ecosystem}/${name}/${version}/_cross-edges.json`;
					const obj = await this.env.CRATE_GRAPHS.get(crossEdgeKey);
					if (!obj) {
						log.warn`${name}@${version} no cross-edge data found, skipping`;
						return;
					}
					const crossEdgeData = await obj.json<CrossEdgeStepResult>();
					await registryStub.replaceCrossEdges(
						ecosystem,
						name,
						version,
						crossEdgeData.edges,
						crossEdgeData.nodes
					);
				}
			);

			// Step 8: Fan out parsing for external dependencies
			await step.do('fanout-dependencies', async () => {
				if (!ENABLE_DEPENDENCY_FANOUT) return;
				const crossEdgeKey = `${ecosystem}/${name}/${version}/_cross-edges.json`;
				const obj = await this.env.CRATE_GRAPHS.get(crossEdgeKey);
				if (!obj) return;
				const crossEdgeData = await obj.json<CrossEdgeStepResult>();

				const parseCrate = this.env.PARSE_CRATE;
				if (!parseCrate) return;
				try {
					await mapWithConcurrency(crossEdgeData.externalCrates, FANOUT_CONCURRENCY, async (entry) => {
						if (!entry.name || entry.name === name) return;
						const status = await registryStub.getStatus(ecosystem, entry.name, entry.version);
						if (status.status !== 'unknown') return;
						await Promise.all([
							registryStub.setStatus(ecosystem, entry.name, entry.version, 'processing'),
							parseCrate.create({ params: { ecosystem, name: entry.name, version: entry.version } })
						]);
					});
				} catch (err) {
					log.warn`Fanout parse scheduling failed: ${err}`;
				}
			});

			// Step 9: Mark as ready
			await step.do('set-status-ready', async () => {
				await registryStub.setStatus(ecosystem, name, version, 'ready');
			});
		} catch (err) {
			// On failure: mark status as failed with error message
			const errorMessage = err instanceof Error ? err.message : String(err);
			const action = /Failed to fetch artifact:.*\b404\b/.test(errorMessage)
				? 'docs_unavailable'
				: undefined;
			await step.do('set-status-failed', async () => {
				await registryStub.setStatus(ecosystem, name, version, 'failed', errorMessage, undefined, action);
			});
			throw err;
		}
	}
}
