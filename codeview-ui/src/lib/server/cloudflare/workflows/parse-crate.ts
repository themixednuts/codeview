import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { decompress } from 'fzstd';
import type { CrateRegistry } from '$cloudflare/crate-registry';
import { getRegistry } from '$lib/server/registry/index';
import { getParser } from '$lib/server/parser/index';
import { getSourceAdapter } from '$lib/server/sources/index';
import { fetchSourcesWithProviders } from '$lib/server/sources/runner';
import type { Ecosystem } from '$lib/server/registry/types';
import { getLogger } from '$lib/log';
import { isStdCrate } from '$lib/std-crates';
import { normalizeCrateName } from '$lib/server/validation';

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
	GRAPH_STORE: DurableObjectNamespace<import('../graph-store').GraphStore>;
	CRATE_REGISTRY: DurableObjectNamespace<CrateRegistry>;
	CRATE_GRAPHS: R2Bucket;
	PARSE_CRATE: Workflow<{ ecosystem: Ecosystem; name: string; version: string }>;
	GITHUB_TOKEN?: string;
};

const USER_AGENT = 'codeview';
const SOURCE_MAX_BYTES = 96 * 1024 * 1024;
const VERSION_LOOKUP_CONCURRENCY = 6;
const FANOUT_CONCURRENCY = 4;

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

export class ParseCrateWorkflow extends WorkflowEntrypoint<ServicesEnv, ParseCrateParams> {
	async run(event: WorkflowEvent<ParseCrateParams>, step: WorkflowStep) {
		const { ecosystem, name, version } = event.payload;
		const r2Key = `${ecosystem}/${name}/${version}/graph.json`;

		const registryStub = this.env.CRATE_REGISTRY.get(
			this.env.CRATE_REGISTRY.idFromName('global')
		);

		// Step 1: Check if graph already exists in R2 (idempotent)
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
					const registry = getRegistry(ecosystem);
					const meta = await registry.resolve(name, version);
					if (!meta) throw new Error(`Package not found: ${name}@${version}`);
					return meta;
				}
			);

			// Step 4: Fetching — set status
			await step.do('set-status-fetching', async () => {
				log.debug`${name}@${version} → fetching`;
				await registryStub.setStatus(ecosystem, name, version, 'processing', undefined, 'fetching');
			});

			// Step 5: Fetch artifact, parse, and store to R2.
			// Returns only the lightweight cross-edge data for the next step.
			const crossEdgeData = await step.do(
				'fetch-parse-store',
				{ retries: { limit: 2, delay: '2 seconds', backoff: 'exponential' } },
				async () => {
					const parser = getParser(ecosystem);
					const artifactUrl =
						metadata.artifactUrl ??
						`https://docs.rs/crate/${name}/${version}/json`;

					const artifactRes = await fetch(artifactUrl, {
						headers: { 'User-Agent': USER_AGENT }
					});
					if (!artifactRes.ok) {
						throw new Error(
							`Failed to fetch artifact: ${artifactRes.status} ${artifactRes.statusText}`
						);
					}

					// docs.rs serves rustdoc JSON as zstd-compressed (application/zstd)
					let artifact: Uint8Array;
					const contentType = artifactRes.headers.get('content-type') ?? '';
					if (contentType.includes('zstd')) {
						const compressed = new Uint8Array(await artifactRes.arrayBuffer());
						artifact = decompress(compressed);
					} else {
						artifact = new Uint8Array(await artifactRes.arrayBuffer());
					}

					log.debug`${name}@${version} → parsing`;
					await registryStub.setStatus(ecosystem, name, version, 'processing', undefined, 'parsing');

					const sourceAdapter = getSourceAdapter(ecosystem);
					const providers = sourceAdapter.getProviders({
						ecosystem,
						name,
						version,
						metadata
					});
					const sourceFiles = await fetchSourcesWithProviders(
						providers,
						{ ecosystem, name, version, metadata },
						{
							maxBytes: SOURCE_MAX_BYTES,
							userAgent: USER_AGENT,
							githubToken: this.env.GITHUB_TOKEN
						}
					);

					const srcFiles = sourceFiles ?? undefined;
					const parseResult = await parser.parse(artifact, name, version, srcFiles);

					function cratePrefix(id: string): string {
						return id.split('::')[0] ?? id;
					}

					const nodeById = new Map<string, { id: string; name: string; kind: string; visibility: string; is_external?: boolean }>();
					for (const rawNode of parseResult.graph.nodes as Array<{
						id: string;
						name?: string;
						kind?: string;
						visibility?: string;
						is_external?: boolean;
					}>) {
						if (!rawNode?.id) continue;
						const fallbackName = rawNode.id.split('::').pop() ?? rawNode.id;
						nodeById.set(rawNode.id, {
							id: rawNode.id,
							name: rawNode.name ?? fallbackName,
							kind: rawNode.kind ?? 'Module',
							visibility: rawNode.visibility ?? 'Unknown',
							is_external: rawNode.is_external
						});
					}

					const crossEdges = (parseResult.graph.edges as Array<{
						from: string;
						to: string;
						kind: string;
						confidence: string;
					}>).filter((edge) => cratePrefix(edge.from) !== cratePrefix(edge.to));

					const crossNodeMap = new Map<string, { id: string; name: string; kind: string; visibility: string; is_external?: boolean }>();
					for (const edge of crossEdges) {
						const fromNode = nodeById.get(edge.from);
						const toNode = nodeById.get(edge.to);
						if (fromNode) crossNodeMap.set(fromNode.id, fromNode);
						if (toNode) crossNodeMap.set(toNode.id, toNode);
					}

					const registry = getRegistry(ecosystem);
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

					// Std-lib crates are part of the Rust toolchain and not published
					// on crates.io — skip them during external crate resolution.
					const externalCrates: { id: string; name: string }[] = [];
					const seenExternal = new Set<string>();
					for (const c of parseResult.externalCrates) {
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

					const index: CrateIndex = {
						name,
						version,
						crates: [
							{
								id: parseResult.graph.id,
								name,
								version,
								is_external: false
							},
							...filteredExternal
						]
					};

					// Store graph + index + cross-edge data to R2 (all independent)
					log.debug`${name}@${version} → storing`;
					await registryStub.setStatus(ecosystem, name, version, 'processing', undefined, 'storing');
					const parsedAt = new Date().toISOString();
					const graphJson = JSON.stringify(parseResult.graph);
					const indexKey = `${ecosystem}/${name}/${version}/index.json`;
					const crossEdgeKey = `${ecosystem}/${name}/${version}/_cross-edges.json`;
					const crossEdgePayload: CrossEdgeStepResult = {
						edges: crossEdges,
						nodes: Array.from(crossNodeMap.values()),
						externalCrates: filteredExternal,
						hasSources: sourceFiles !== null
					};

					await Promise.all([
						this.env.CRATE_GRAPHS.put(r2Key, graphJson, {
							httpMetadata: { contentType: 'application/json' },
							customMetadata: {
								ecosystem,
								name,
								version,
								parsedAt,
								hasSources: sourceFiles ? 'true' : 'false'
							}
						}),
						this.env.CRATE_GRAPHS.put(indexKey, JSON.stringify(index), {
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
						console.warn(`[workflow] ${name}@${version} no cross-edge data found, skipping`);
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
					console.warn('Fanout parse scheduling failed:', err);
				}
			});

			// Step 9: Mark as ready
			await step.do('set-status-ready', async () => {
				await registryStub.setStatus(ecosystem, name, version, 'ready');
			});
		} catch (err) {
			// On failure: mark status as failed with error message
			const errorMessage = err instanceof Error ? err.message : String(err);
			await step.do('set-status-failed', async () => {
				await registryStub.setStatus(ecosystem, name, version, 'failed', errorMessage);
			});
			throw err;
		}
	}
}
