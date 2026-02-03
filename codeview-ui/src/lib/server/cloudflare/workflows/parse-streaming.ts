/**
 * Streaming parse workflow for large rustdoc JSON files.
 *
 * Uses streaming JSON parsing to handle crates like windows-sys (458K nodes)
 * within Cloudflare's 30-second CPU limit.
 *
 * Architecture:
 * - Fetches zstd-compressed JSON from docs.rs
 * - Streams through ZstdDecompressionStream → JSONParser → StreamingGraphBuilder
 * - Batches writes to R2 during parsing
 * - Resolves edges after streaming is complete
 */

import { Result } from 'better-result';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { CrateRegistry } from '$cloudflare/registry';
import { getRegistry } from '$lib/server/registry/index';
import { getSourceAdapter } from '$lib/server/sources/index';
import { fetchSourcesWithProviders } from '$lib/server/sources/runner';
import type { Ecosystem } from '$lib/server/registry/types';
import { getLogger } from '$lib/log';
import { isStdCrate } from '$lib/std';
import { normalizeCrateName } from '$lib/server/validation';
import {
	createStreamingGraphBuilder,
	type BuilderCheckpoint
} from '$lib/server/parser/streaming';
import type { Node, Edge } from '$lib/graph';
import { JSONParser } from '@streamparser/json-whatwg';
import { type StackElement } from '@streamparser/json';
import { ZstdDecompressionStream } from 'zstd-wasm-decoder/cloudflare';
import { decompress } from 'fzstd';
import { getParser } from '$lib/server/parser/index';

/** Parsed element info from the JSON parser */
interface ParsedElementInfo {
	value?: unknown;
	parent?: unknown;
	key?: string | number;
	stack: StackElement[];
	partial?: boolean;
}

const log = getLogger('workflow:streaming');

interface ParseCrateParams {
	ecosystem: Ecosystem;
	name: string;
	version: string;
	/** Use streaming parser (default: true for large crates) */
	streaming?: boolean;
}

type ServicesEnv = Omit<Env, 'GRAPH_STORE' | 'CRATE_REGISTRY' | 'PARSE_CRATE'> & {
	GRAPH_STORE: DurableObjectNamespace<import('../store').GraphStore>;
	CRATE_REGISTRY: DurableObjectNamespace<CrateRegistry>;
	CRATE_GRAPHS: R2Bucket;
	PARSE_CRATE: Workflow<{ ecosystem: Ecosystem; name: string; version: string }>;
	GITHUB_TOKEN?: string;
};

const USER_AGENT = 'codeview';
const SOURCE_MAX_BYTES = 96 * 1024 * 1024;
const VERSION_LOOKUP_CONCURRENCY = 6;
const FANOUT_CONCURRENCY = 4;

/** Threshold for using streaming parser (in bytes of compressed size) */
const STREAMING_THRESHOLD_BYTES = 5 * 1024 * 1024; // 5MB compressed

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

type CrossEdgeStepResult = {
	edges: Array<{ from: string; to: string; kind: string; confidence: string }>;
	nodes: Array<{ id: string; name: string; kind: string; visibility: string; is_external?: boolean }>;
	externalCrates: CrateIndexEntry[];
	hasSources: boolean;
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

/**
 * Streaming parse workflow.
 *
 * This workflow handles large rustdoc JSON files by streaming the parse
 * process rather than loading the entire file into memory.
 */
export class ParseCrateStreamingWorkflow extends WorkflowEntrypoint<ServicesEnv, ParseCrateParams> {
	async run(event: WorkflowEvent<ParseCrateParams>, step: WorkflowStep) {
		const { ecosystem, name, version, streaming = true } = event.payload;
		const r2Key = `${ecosystem}/${name}/${version}/graph.json`;
		const crateName = name.replace(/-/g, '_');

		const registryStub = this.env.CRATE_REGISTRY.get(
			this.env.CRATE_REGISTRY.idFromName('global')
		);

		// Step 1: Check if graph already exists
		const exists = await step.do('check-existing', async () => {
			const head = await this.env.CRATE_GRAPHS.head(r2Key);
			return head !== null;
		});

		if (exists) {
			await step.do('mark-ready-existing', async () => {
				await registryStub.setStatus(ecosystem, name, version, 'ready');
			});
			return;
		}

		// Step 2: Set resolving status
		await step.do('set-status-resolving', async () => {
			log.debug`${name}@${version} → resolving`;
			await registryStub.setStatus(ecosystem, name, version, 'processing', undefined, 'resolving');
		});

		try {
			// Step 3: Resolve metadata
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

			// Step 4: Check artifact size and decide on streaming vs monolithic
			const artifactMeta = await step.do('check-artifact-size', async () => {
				const artifactUrl = metadata.artifactUrl ?? `https://docs.rs/crate/${name}/${version}/json`;
				const headRes = await fetch(artifactUrl, {
					method: 'HEAD',
					headers: { 'User-Agent': USER_AGENT }
				});
				if (!headRes.ok) {
					throw new Error(`Failed to HEAD artifact: ${headRes.status}`);
				}
				const contentLength = parseInt(headRes.headers.get('content-length') ?? '0', 10);
				const etag = headRes.headers.get('etag');
				const acceptRanges = headRes.headers.get('accept-ranges') === 'bytes';
				return { contentLength, etag, acceptRanges, artifactUrl };
			});

			const useStreaming = streaming && artifactMeta.contentLength > STREAMING_THRESHOLD_BYTES;

			// Step 5: Fetching status
			await step.do('set-status-fetching', async () => {
				log.debug`${name}@${version} → fetching (streaming=${useStreaming})`;
				await registryStub.setStatus(ecosystem, name, version, 'processing', undefined, 'fetching');
			});

			// Step 6: Fetch sources (independent of parsing)
			const sourceFiles = await step.do(
				'fetch-sources',
				{ retries: { limit: 2, delay: '2 seconds', backoff: 'exponential' } },
				async () => {
					const sourceAdapterResult = getSourceAdapter(ecosystem);
					if (sourceAdapterResult.isErr()) return null;
					const sourceAdapter = sourceAdapterResult.value;
					const providers = sourceAdapter.getProviders({
						ecosystem,
						name,
						version,
						metadata
					});
					return await fetchSourcesWithProviders(
						providers,
						{ ecosystem, name, version, metadata },
						{
							maxBytes: SOURCE_MAX_BYTES,
							userAgent: USER_AGENT,
							githubToken: this.env.GITHUB_TOKEN
						}
					);
				}
			);

			// Step 7: Stream parse and store
			await step.do('set-status-parsing', async () => {
				log.debug`${name}@${version} → parsing (streaming)`;
				await registryStub.setStatus(ecosystem, name, version, 'processing', undefined, 'parsing');
			});

			const parseResult = await step.do(
				'stream-parse',
				{ retries: { limit: 2, delay: '2 seconds', backoff: 'exponential' } },
				async () => {
					if (useStreaming) {
						return await this.streamingParse(
							artifactMeta.artifactUrl,
							crateName,
							version
						);
					} else {
						return await this.monolithicParse(
							artifactMeta.artifactUrl,
							crateName,
							version,
							sourceFiles
						);
					}
				}
			);

			// Step 8: Store to R2
			await step.do('set-status-storing', async () => {
				log.debug`${name}@${version} → storing`;
				await registryStub.setStatus(ecosystem, name, version, 'processing', undefined, 'storing');
			});

			await step.do(
				'store-graph',
				{ retries: { limit: 2, delay: '2 seconds', backoff: 'exponential' } },
				async () => {
					await this.storeGraphToR2(
						ecosystem,
						name,
						version,
						parseResult.nodes,
						parseResult.edges,
						parseResult.externalCrates,
						crateName,
						sourceFiles !== null
					);
				}
			);

			// Step 9: Indexing status
			await step.do('set-status-indexing', async () => {
				log.debug`${name}@${version} → indexing`;
				await registryStub.setStatus(ecosystem, name, version, 'processing', undefined, 'indexing');
			});

			// Step 10: Index cross-edges
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

			// Step 11: Fan out parsing for external dependencies
			await step.do('fanout-dependencies', async () => {
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

			// Step 12: Mark ready
			await step.do('set-status-ready', async () => {
				await registryStub.setStatus(ecosystem, name, version, 'ready');
			});

		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			await step.do('set-status-failed', async () => {
				await registryStub.setStatus(ecosystem, name, version, 'failed', errorMessage);
			});
			throw err;
		}
	}

	/**
	 * Streaming parse using the new streaming parser.
	 */
	private async streamingParse(
		artifactUrl: string,
		crateName: string,
		version: string
	): Promise<{
		nodes: Node[];
		edges: Edge[];
		externalCrates: Array<{ id: string; name: string }>;
	}> {
		// Create the graph builder
		const builder = createStreamingGraphBuilder(crateName, {
			skipExternalNodes: true,
			batchSize: 1000
		});

		const callbacks = builder.createParseCallbacks();

		// Fetch the artifact
		const response = await fetch(artifactUrl, {
			headers: { 'User-Agent': USER_AGENT }
		});

		if (!response.ok) {
			throw new Error(`Failed to fetch artifact: ${response.status} ${response.statusText}`);
		}

		if (!response.body) {
			throw new Error('Response has no body');
		}

		// Check if compressed
		const contentType = response.headers.get('content-type') ?? '';
		const isCompressed = contentType.includes('zstd');

		// Create parser TransformStream with path filtering
		const parser = new JSONParser({
			paths: [
				'$.root',
				'$.crate_version',
				'$.index.*',
				'$.paths.*',
				'$.external_crates.*'
			],
			keepStack: false
		});

		// Create the processing pipeline
		let readable: ReadableStream<Uint8Array> = response.body;

		if (isCompressed) {
			const decompressionStream = new ZstdDecompressionStream();
			readable = readable.pipeThrough(decompressionStream);
		}

		// Create text decoder stream and pipe through JSON parser
		const textDecoder = new TextDecoderStream();
		const parsedStream = readable
			.pipeThrough(textDecoder as unknown as TransformStream<Uint8Array, string>)
			.pipeThrough(parser);

		// Process parsed elements from the stream
		const reader = parsedStream.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				const info = value as ParsedElementInfo;
				if (info.value === undefined) continue;

				const stackPath = info.stack.map((s: StackElement) => s.key).join('.');
				const key = info.key;

				if (stackPath === '' && key === 'root') {
					callbacks.onRoot(info.value as number);
				} else if (stackPath === '' && key === 'crate_version') {
					callbacks.onCrateVersion(info.value as string | null);
				} else if (stackPath === 'index' && typeof key === 'string') {
					callbacks.onItem(key, info.value as any);
				} else if (stackPath === 'paths' && typeof key === 'string') {
					callbacks.onPath(key, info.value as any);
				} else if (stackPath === 'external_crates' && typeof key === 'string') {
					callbacks.onExternalCrate(key, info.value as any);
				}
			}
		} finally {
			reader.releaseLock();
		}

		// Finalize the graph
		const result = await builder.finalize();

		log.info`Streaming parse complete: ${String(result.nodes.length)} nodes, ${String(result.edges.length)} edges`;

		return {
			nodes: result.nodes,
			edges: result.edges,
			externalCrates: result.externalCrates
		};
	}

	/**
	 * Monolithic parse for smaller crates (fallback).
	 */
	private async monolithicParse(
		artifactUrl: string,
		crateName: string,
		version: string,
		sourceFiles: Map<string, string> | null
	): Promise<{
		nodes: Node[];
		edges: Edge[];
		externalCrates: Array<{ id: string; name: string }>;
	}> {
		const parserResult = getParser('rust');
		if (parserResult.isErr()) throw parserResult.error;
		const parser = parserResult.value;

		const response = await fetch(artifactUrl, {
			headers: { 'User-Agent': USER_AGENT }
		});

		if (!response.ok) {
			throw new Error(`Failed to fetch artifact: ${response.status} ${response.statusText}`);
		}

		let artifact: Uint8Array;
		const contentType = response.headers.get('content-type') ?? '';
		if (contentType.includes('zstd')) {
			const compressed = new Uint8Array(await response.arrayBuffer());
			artifact = decompress(compressed);
		} else {
			artifact = new Uint8Array(await response.arrayBuffer());
		}

		const srcFiles = sourceFiles ?? undefined;
		const parseResult = await parser.parse(artifact, crateName, version, srcFiles);

		return {
			nodes: parseResult.graph.nodes,
			edges: parseResult.graph.edges,
			externalCrates: parseResult.externalCrates
		};
	}

	/**
	 * Store the parsed graph and related data to R2.
	 */
	private async storeGraphToR2(
		ecosystem: Ecosystem,
		name: string,
		version: string,
		nodes: Node[],
		edges: Edge[],
		externalCrates: Array<{ id: string; name: string }>,
		crateName: string,
		hasSources: boolean
	): Promise<void> {
		const r2Key = `${ecosystem}/${name}/${version}/graph.json`;
		const indexKey = `${ecosystem}/${name}/${version}/index.json`;
		const crossEdgeKey = `${ecosystem}/${name}/${version}/_cross-edges.json`;
		const treeKey = `${ecosystem}/${name}/${version}/tree.json`;

		function cratePrefix(id: string): string {
			return id.split('::')[0] ?? id;
		}

		// Build node lookup
		const nodeById = new Map<string, Node>();
		for (const node of nodes) {
			nodeById.set(node.id, node);
		}

		// Extract cross-crate edges
		const crossEdges = edges.filter((edge) => cratePrefix(edge.from) !== cratePrefix(edge.to));

		const crossNodeMap = new Map<string, { id: string; name: string; kind: string; visibility: string; is_external?: boolean }>();
		for (const edge of crossEdges) {
			const fromNode = nodeById.get(edge.from);
			const toNode = nodeById.get(edge.to);
			if (fromNode) {
				crossNodeMap.set(fromNode.id, {
					id: fromNode.id,
					name: fromNode.name,
					kind: fromNode.kind,
					visibility: fromNode.visibility,
					is_external: fromNode.is_external
				});
			}
			if (toNode) {
				crossNodeMap.set(toNode.id, {
					id: toNode.id,
					name: toNode.name,
					kind: toNode.kind,
					visibility: toNode.visibility,
					is_external: toNode.is_external
				});
			}
		}

		// Resolve external crate versions
		const registryResult = getRegistry(ecosystem);
		if (registryResult.isErr()) throw registryResult.error;
		const registry = registryResult.value;

		const latestCache = new Map<string, string | null>();
		async function getLatestVersion(candidate: string): Promise<string | null> {
			if (latestCache.has(candidate)) return latestCache.get(candidate)!;
			const resolved = await registry.getLatestVersion(candidate);
			latestCache.set(candidate, resolved);
			return resolved;
		}

		const seenExternal = new Set<string>();
		const externalToResolve: Array<{ id: string; name: string }> = [];
		for (const c of externalCrates) {
			if (seenExternal.has(c.id)) continue;
			seenExternal.add(c.id);
			if (isStdCrate(c.name) || isStdCrate(c.id)) continue;
			externalToResolve.push(c);
		}

		const externalEntries = await mapWithConcurrency(
			externalToResolve,
			VERSION_LOOKUP_CONCURRENCY,
			async (ext): Promise<CrateIndexEntry | null> => {
				const candidates = [
					ext.name,
					ext.id,
					normalizeCrateName(ext.name),
					normalizeCrateName(ext.id)
				].filter((value, index, all) => value && all.indexOf(value) === index);

				for (const candidate of candidates) {
					const latest = await getLatestVersion(candidate);
					if (latest) {
						return { id: ext.id, name: candidate, version: latest, is_external: true };
					}
				}
				return null;
			}
		);
		const filteredExternal = externalEntries.filter((e): e is CrateIndexEntry => e !== null);

		// Build index
		const index: CrateIndex = {
			name,
			version,
			crates: [
				{ id: crateName, name, version, is_external: false },
				...filteredExternal
			]
		};

		// Build cross-edge payload
		const crossEdgePayload: CrossEdgeStepResult = {
			edges: crossEdges.map((e) => ({ from: e.from, to: e.to, kind: e.kind, confidence: e.confidence })),
			nodes: Array.from(crossNodeMap.values()),
			externalCrates: filteredExternal,
			hasSources
		};

		// Build tree summary
		const internalNodes = nodes.filter((n) => !n.is_external);
		const internalIds = new Set(internalNodes.map((n) => n.id));
		const treeEdges = edges.filter(
			(e) => (e.kind === 'Contains' || e.kind === 'Defines') && internalIds.has(e.from) && internalIds.has(e.to)
		);
		const treeSummary = {
			nodes: internalNodes.map((n) => ({
				id: n.id,
				name: n.name,
				kind: n.kind,
				visibility: n.visibility,
				...(n.kind === 'Impl' ? {
					impl_trait: n.impl_trait,
					generics: n.generics,
					where_clause: n.where_clause,
					bound_links: n.bound_links
				} : {})
			})),
			edges: treeEdges
		};

		// Build graph payload
		const graph = {
			id: crateName,
			name: crateName,
			version,
			nodes,
			edges
		};

		// Store all to R2
		const parsedAt = new Date().toISOString();

		const graphJsonResult = Result.try(() => JSON.stringify(graph));
		if (graphJsonResult.isErr()) throw graphJsonResult.error;

		const indexJsonResult = Result.try(() => JSON.stringify(index));
		if (indexJsonResult.isErr()) throw indexJsonResult.error;

		const crossEdgeJsonResult = Result.try(() => JSON.stringify(crossEdgePayload));
		if (crossEdgeJsonResult.isErr()) throw crossEdgeJsonResult.error;

		const treeJsonResult = Result.try(() => JSON.stringify(treeSummary));
		if (treeJsonResult.isErr()) throw treeJsonResult.error;

		await Promise.all([
			this.env.CRATE_GRAPHS.put(r2Key, graphJsonResult.value, {
				httpMetadata: { contentType: 'application/json' },
				customMetadata: { ecosystem, name, version, parsedAt, hasSources: hasSources ? 'true' : 'false' }
			}),
			this.env.CRATE_GRAPHS.put(indexKey, indexJsonResult.value, {
				httpMetadata: { contentType: 'application/json' },
				customMetadata: { ecosystem, name, version, parsedAt }
			}),
			this.env.CRATE_GRAPHS.put(crossEdgeKey, crossEdgeJsonResult.value, {
				httpMetadata: { contentType: 'application/json' }
			}),
			this.env.CRATE_GRAPHS.put(treeKey, treeJsonResult.value, {
				httpMetadata: { contentType: 'application/json' },
				customMetadata: { ecosystem, name, version, parsedAt }
			})
		]);

		log.info`Stored graph to R2: ${String(nodes.length)} nodes, ${String(edges.length)} edges`;
	}
}
