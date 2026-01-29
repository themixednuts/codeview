import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { CrateRegistry } from '../crate-registry';
import { getRegistry } from '../registry/index';
import { getParser } from '../parser/index';
import { getSourceAdapter } from '../sources/index';
import { fetchSourcesWithProviders } from '../sources/runner';
import type { Ecosystem } from '../registry/types';

interface ParseCrateParams {
	ecosystem: Ecosystem;
	name: string;
	version: string;
}

interface Env {
	CRATE_REGISTRY: DurableObjectNamespace<CrateRegistry>;
	CRATE_GRAPHS: R2Bucket;
	PARSE_CRATE?: Workflow<{ ecosystem: Ecosystem; name: string; version: string }>;
	GITHUB_TOKEN?: string;
}

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

export class ParseCrateWorkflow extends WorkflowEntrypoint<Env, ParseCrateParams> {
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

		// Step 2: Set status to processing
		await step.do('set-status-processing', async () => {
			await registryStub.setStatus(ecosystem, name, version, 'processing');
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

			// Step 4: Parse + store graph (fetch artifact + sources inside one step)
			await step.do(
				'parse-and-store',
				{ retries: { limit: 2, delay: '2 seconds', backoff: 'exponential' } },
				async () => {
					const parser = getParser(ecosystem);
					const crateName = name.replace(/-/g, '_');
					const artifactUrl =
						metadata.artifactUrl ??
						`https://docs.rs/crate/${name}/${version}/target/doc/${crateName}.json`;

					const artifactRes = await fetch(artifactUrl, {
						headers: { 'User-Agent': USER_AGENT }
					});
					if (!artifactRes.ok) {
						throw new Error(
							`Failed to fetch artifact: ${artifactRes.status} ${artifactRes.statusText}`
						);
					}
					const artifact = await artifactRes.text();

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
							ext.name.replace(/_/g, '-'),
							ext.id.replace(/_/g, '-')
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
					for (const c of parseResult.externalCrates) {
						if (seenExternal.has(c.id)) continue;
						seenExternal.add(c.id);
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

					const graphJson = JSON.stringify(parseResult.graph);
					await this.env.CRATE_GRAPHS.put(r2Key, graphJson, {
						httpMetadata: { contentType: 'application/json' },
						customMetadata: {
							ecosystem,
							name,
							version,
							parsedAt: new Date().toISOString(),
							hasSources: sourceFiles ? 'true' : 'false'
						}
					});

					const indexKey = `${ecosystem}/${name}/${version}/index.json`;
					await this.env.CRATE_GRAPHS.put(indexKey, JSON.stringify(index), {
						httpMetadata: { contentType: 'application/json' },
						customMetadata: {
							ecosystem,
							name,
							version,
							parsedAt: new Date().toISOString()
						}
					});

					await registryStub.replaceCrossEdges(
						ecosystem,
						name,
						version,
						crossEdges,
						Array.from(crossNodeMap.values())
					);

					const parseCrate = this.env.PARSE_CRATE;
					if (parseCrate) {
						try {
							await mapWithConcurrency(filteredExternal, FANOUT_CONCURRENCY, async (entry) => {
								if (!entry.name || entry.name === name) return;
								const status = await registryStub.getStatus(ecosystem, entry.name, entry.version);
								if (status.status !== 'unknown') return;
								await registryStub.setStatus(ecosystem, entry.name, entry.version, 'processing');
								await parseCrate.create({
									params: { ecosystem, name: entry.name, version: entry.version }
								});
							});
						} catch (err) {
							console.warn('Fanout parse scheduling failed:', err);
						}
					}

					return { hasSources: sourceFiles !== null };
				}
			);

			// Step 5: Mark as ready
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
