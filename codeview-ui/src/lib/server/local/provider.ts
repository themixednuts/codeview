import { Result } from 'better-result';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { RequestEvent } from '@sveltejs/kit';
import { decompress } from 'fzstd';
import type { Workspace, CrateGraph, Confidence, EdgeKind, NodeKind, Visibility } from '$lib/graph';
import type { CrateIndex } from '$lib/schema';
import { parseWorkspace } from '$lib/schema';
import { isStdCrate, STD_JSON_CRATES } from '$lib/std-crates';
import { getLogger } from '$lib/log';
import { createCratesIoAdapter } from '../registry/crates-io';
import { getRegistry } from '../registry/index';
import { getParser } from '../parser/index';
import { getSourceAdapter } from '../sources/index';
import { fetchSourcesWithProviders } from '../sources/runner';
import type { CrossEdgeData, DataProvider, CrateStatus, CrateSummaryResult } from '../provider';
import { ValidationError, NotAvailableError } from '../errors';
import { isValidCrateName, isValidVersion, normalizeCrateName, crateNameVariants } from '../validation';
import { sseResponse, sseStreamResponse } from '../sse-proxy';
import { LocalCache } from './cache';
import { WorkflowEntrypoint, runWorkflow } from './workflow';
import type { WorkflowStep, WorkflowEvent } from './workflow';
import { findStdJson, installStdDocs, detectSysroot } from './sysroot';

const log = getLogger('local');

const USER_AGENT = 'codeview';
const SOURCE_MAX_BYTES = 96 * 1024 * 1024;
const VERSION_LOOKUP_CONCURRENCY = 6;

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

		const fullStatus: CrateStatus = {
			...status,
			...(step ? { step } : {}),
		};

		const key = statusKey(name, version);
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
			const artifact = await step.do(
				'fetch-artifact',
				{ retries: { limit: 2, delayMs: 3000, backoff: 'exponential' } },
				async () => {
					const artifactUrl = meta.artifactUrl ?? `https://docs.rs/crate/${name}/${version}/json`;
					const artifactRes = await fetch(artifactUrl, {
						headers: { 'User-Agent': USER_AGENT }
					});
					if (!artifactRes.ok) {
						throw new Error(
							`Failed to fetch artifact: ${artifactRes.status} ${artifactRes.statusText}`
						);
					}

					const contentType = artifactRes.headers.get('content-type') ?? '';
					if (contentType.includes('zstd')) {
						const compressed = new Uint8Array(await artifactRes.arrayBuffer());
						return decompress(compressed);
					}
					return new Uint8Array(await artifactRes.arrayBuffer());
				}
			);
			log.info`Fetched ${name}@${version}: ${(artifact.byteLength / 1024 / 1024).toFixed(1)} MB`;

			// parse-rustdoc: parse JSON → graph
			const parseResult = await step.do(
				'parse-rustdoc',
				{ retries: { limit: 1, delayMs: 1000, backoff: 'linear' } },
				async () => {
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
					const sourceFiles = await fetchSourcesWithProviders(
						providers,
						{ ecosystem: 'rust', name, version, metadata: meta },
						{ maxBytes: SOURCE_MAX_BYTES, userAgent: USER_AGENT }
					);
					log.info`Sources for ${name}@${version}: ${sourceFiles ? sourceFiles.size + ' files' : 'none'}`;

					log.info`Parsing rustdoc for ${name}@${version}`;
					const t0 = performance.now();
					const parserResult = getParser('rust');
					if (parserResult.isErr()) throw parserResult.error;
					const parser = parserResult.value;
					const srcFiles = sourceFiles ?? undefined;
					const result = await parser.parse(artifact, name, version, srcFiles);
					log.info`Parsed ${name}@${version}: ${result.graph.nodes.length} nodes, ${(performance.now() - t0).toFixed(0)}ms`;
					return result;
				}
			);

			// set-status-indexing
			await step.do('set-status-indexing', async () => {
				emitStatus(name, version, { status: 'processing' }, 'indexing');
			});

			// index-cross-edges: build cross-crate edge index + resolve external versions
			const { crossEdgesList, crossNodeList, index } = await step.do(
				'index-cross-edges',
				{ retries: { limit: 1, delayMs: 1000, backoff: 'linear' } },
				async () => {
					function cratePrefix(id: string): string {
						return id.split('::')[0] ?? id;
					}

					const nodeById = new Map<string, { id: string; name: string; kind: string; visibility: string; is_external?: boolean }>();
					for (const node of parseResult.graph.nodes) {
						nodeById.set(node.id, {
							id: node.id,
							name: node.name,
							kind: node.kind,
							visibility: node.visibility,
							is_external: node.is_external
						});
					}

					const edgesOut = parseResult.graph.edges.filter(
						(edge) => cratePrefix(edge.from) !== cratePrefix(edge.to)
					);

					const nodeMap = new Map<string, { id: string; name: string; kind: string; visibility: string; is_external?: boolean }>();
					for (const edge of edgesOut) {
						const fromNode = nodeById.get(edge.from);
						const toNode = nodeById.get(edge.to);
						if (fromNode) nodeMap.set(fromNode.id, fromNode);
						if (toNode) nodeMap.set(toNode.id, toNode);
					}

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
					const filteredExternal = externalEntries.filter(
						(e): e is CrateIndexEntry => e !== null
					);

					const idx: CrateIndex = {
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

					return {
						crossEdgesList: edgesOut,
						crossNodeList: Array.from(nodeMap.values()),
						index: idx
					};
				}
			);

			// store-graph: write to SQLite
			await step.do(
				'store-graph',
				{ retries: { limit: 2, delayMs: 1000, backoff: 'linear' } },
				async () => {
					emitStatus(name, version, { status: 'processing' }, 'storing');

					const lc = getCache();
					const graph = {
						id: parseResult.graph.id,
						name: parseResult.graph.name,
						version: parseResult.graph.version,
						nodes: parseResult.graph.nodes,
						edges: parseResult.graph.edges
					};
					lc.putCrate(name, version, graph, index);

					lc.replaceCrossEdges(
						'rust', name, version,
						crossEdgesList,
						crossNodeList
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

			// read-json
			const artifact = await step.do('read-json', async () => {
				emitStatus(name, version, { status: 'processing' }, 'fetching');
				const content = await readFile(stdInfo.jsonPath!, 'utf-8');
				return content;
			});
			log.info`Read std JSON for ${name}@${version}: ${(artifact.length / 1024 / 1024).toFixed(1)} MB`;

			// parse-rustdoc
			const parseResult = await step.do('parse-rustdoc', async () => {
				log.info`Parsing rustdoc for std crate ${name}@${version}`;
				emitStatus(name, version, { status: 'processing' }, 'parsing');
				const t0 = performance.now();
				const parserResult = getParser('rust');
				if (parserResult.isErr()) throw parserResult.error;
				const parser = parserResult.value;
				const result = await parser.parse(artifact, name, version);
				log.info`Parsed ${name}@${version}: ${result.graph.nodes.length} nodes, ${(performance.now() - t0).toFixed(0)}ms`;
				return result;
			});

			// store-graph
			await step.do('store-graph', async () => {
				emitStatus(name, version, { status: 'processing' }, 'storing');
				const lc = getCache();
				const graph = {
					id: parseResult.graph.id,
					name: parseResult.graph.name,
					version: parseResult.graph.version,
					nodes: parseResult.graph.nodes,
					edges: parseResult.graph.edges,
				};
				const index: CrateIndex = {
					name,
					version,
					crates: [{ id: parseResult.graph.id, name, version, is_external: false }],
				};
				lc.putCrate(name, version, graph, index);
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

		async loadSourceFile(file: string) {
			const workspaceRoot = process.env.CODEVIEW_WORKSPACE;
			if (!workspaceRoot) {
				return { error: 'CODEVIEW_WORKSPACE not set', content: null };
			}

			const fullPath = join(workspaceRoot, file);
			const resolved = resolve(fullPath);

			if (!resolved.startsWith(resolve(workspaceRoot))) {
				return { error: 'Path outside workspace', content: null };
			}

			try {
				const content = await readFile(resolved, 'utf-8');
				return { error: null, content };
			} catch {
				return { error: 'File not found', content: null };
			}
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
				if (lc.hasCrate(name, version)) return { status: 'ready' };
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
				if (lc.hasCrate(name, version)) return { status: 'ready' };
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
			}, signal, { ttl: 30_000 });
		},

		async streamEdgeUpdates(nodeId: string, signal: AbortSignal): Promise<Response> {
			return sseStreamResponse((push, _close) => {
				const unsubscribe = subscribeEdge(nodeId, (data) => {
					const json = Result.try(() => JSON.stringify(data)).unwrapOr('{}');
					push(`data: ${json}\n\n`);
				});
				return unsubscribe;
			}, signal, { ttl: 5_000 });
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
		}
	};
}

/** Build-time entry point — imported via the `$provider` alias (see vite.config.js). */
export function createProvider(_event: RequestEvent): DataProvider {
	return createLocalProvider();
}
