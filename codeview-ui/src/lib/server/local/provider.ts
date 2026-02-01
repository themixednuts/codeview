import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { RequestEvent } from '@sveltejs/kit';
import { decompress } from 'fzstd';
import type { Workspace, CrateGraph, Confidence, EdgeKind, NodeKind, Visibility } from '$lib/graph';
import type { CrateIndex } from '$lib/schema';
import { parseWorkspace } from '$lib/schema';
import { isStdCrate } from '$lib/std-crates';
import { getLogger } from '$lib/log';
import { createCratesIoAdapter } from '../registry/crates-io';
import { getRegistry } from '../registry/index';
import { getParser } from '../parser/index';
import { getSourceAdapter } from '../sources/index';
import { fetchSourcesWithProviders } from '../sources/runner';
import type { CrossEdgeData, DataProvider, CrateStatus, CrateSummaryResult } from '../provider';
import { isValidCrateName, isValidVersion, normalizeCrateName, crateNameVariants } from '../validation';
import { sseResponse, sseStreamResponse } from '../sse-proxy';
import { LocalCache } from './cache';

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

	async function parseCrate(name: string, version: string): Promise<void> {
		log.info`Parsing ${name}@${version}`;
		try {
			// Step 1: Check cache
			const lc = getCache();
			if (lc.hasCrate(name, version)) {
				emitStatus(name, version, { status: 'ready' });
				return;
			}

			// Step 2: Resolving
			emitStatus(name, version, { status: 'processing' }, 'resolving');

			const reg = getRegistry('rust');
			const meta = await reg.resolve(name, version);
			if (!meta) {
				emitStatus(name, version, {
					status: 'failed',
					error: `Package not found: ${name}@${version}`
				});
				return;
			}

			// Step 3: Fetching
			log.info`Fetching rustdoc for ${name}@${version}`;
			emitStatus(name, version, { status: 'processing' }, 'fetching');

			const artifactUrl = meta.artifactUrl ?? `https://docs.rs/crate/${name}/${version}/json`;
			const artifactRes = await fetch(artifactUrl, {
				headers: { 'User-Agent': USER_AGENT }
			});
			if (!artifactRes.ok) {
				emitStatus(name, version, {
					status: 'failed',
					error: `Failed to fetch artifact: ${artifactRes.status} ${artifactRes.statusText}`
				});
				return;
			}

			let artifact: Uint8Array;
			const contentType = artifactRes.headers.get('content-type') ?? '';
			if (contentType.includes('zstd')) {
				const compressed = new Uint8Array(await artifactRes.arrayBuffer());
				artifact = decompress(compressed);
			} else {
				artifact = new Uint8Array(await artifactRes.arrayBuffer());
			}
			log.info`Fetched ${name}@${version}: ${(artifact.byteLength / 1024 / 1024).toFixed(1)} MB`;

			// Step 4: Parsing
			emitStatus(name, version, { status: 'processing' }, 'parsing');

			log.info`Fetching sources for ${name}@${version}`;
			const sourceAdapter = getSourceAdapter('rust');
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
			const parser = getParser('rust');
			const srcFiles = sourceFiles ?? undefined;
			const parseResult = await parser.parse(artifact, name, version, srcFiles);
			log.info`Parsed ${name}@${version}: ${parseResult.graph.nodes.length} nodes, ${(performance.now() - t0).toFixed(0)}ms`;

			// Step 5: Build index + cross-edges
			emitStatus(name, version, { status: 'processing' }, 'indexing');

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

			const crossEdges = parseResult.graph.edges.filter(
				(edge) => cratePrefix(edge.from) !== cratePrefix(edge.to)
			);

			const crossNodeMap = new Map<string, { id: string; name: string; kind: string; visibility: string; is_external?: boolean }>();
			for (const edge of crossEdges) {
				const fromNode = nodeById.get(edge.from);
				const toNode = nodeById.get(edge.to);
				if (fromNode) crossNodeMap.set(fromNode.id, fromNode);
				if (toNode) crossNodeMap.set(toNode.id, toNode);
			}

			const latestCache = new Map<string, string | null>();
			async function getLatestVersion(candidate: string): Promise<string | null> {
				if (latestCache.has(candidate)) return latestCache.get(candidate)!;
				const resolved = await reg.getLatestVersion(candidate);
				latestCache.set(candidate, resolved);
				return resolved;
			}

			async function resolveExternalEntry(ext: {
				id: string;
				name: string;
			}): Promise<CrateIndexEntry | null> {
				const candidates = [
					...crateNameVariants(ext.name),
					...crateNameVariants(ext.id)
				].filter((value, index, all) => value && all.indexOf(value) === index);

				for (const candidate of candidates) {
					const latest = await getLatestVersion(candidate);
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

			// Step 6: Store to SQLite
			emitStatus(name, version, { status: 'processing' }, 'storing');

			const graph = {
				id: parseResult.graph.id,
				name: parseResult.graph.name,
				version: parseResult.graph.version,
				nodes: parseResult.graph.nodes,
				edges: parseResult.graph.edges
			};
			lc.putCrate(name, version, graph, index);

			// Store cross-edges
			const touchedNodes = new Set<string>();
			for (const edge of crossEdges) {
				touchedNodes.add(edge.from);
				touchedNodes.add(edge.to);
			}
			lc.replaceCrossEdges(
				'rust', name, version,
				crossEdges,
				Array.from(crossNodeMap.values())
			);

			// Notify edge listeners
			for (const nodeId of touchedNodes) {
				emitEdgeUpdate(nodeId);
			}

			log.info`Parsed and cached ${name}@${version}`;

			// Step 7: Ready
			emitStatus(name, version, { status: 'ready' });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.error`Failed to parse ${name}@${version}: ${msg}`;
			emitStatus(name, version, { status: 'failed', error: msg });
		}
	}

	return {
		async loadWorkspace() {
			if (cached) return cached;
			const graphPath = process.env.CODEVIEW_GRAPH;
			if (!graphPath) return null;
			try {
				const content = await readFile(graphPath, 'utf-8');
				const raw = JSON.parse(content);
				cached = parseWorkspace(raw) as Workspace;
				return cached;
			} catch (err) {
				console.error('Failed to load workspace:', err);
				return null;
			}
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
				throw new Error(`${name} is a standard library crate and cannot be parsed on-demand`);
			}
			if (!isValidCrateName(name) || !isValidVersion(version)) {
				throw new Error('Invalid crate name or version');
			}

			const lc = getCache();

			if (force) {
				// Clear in-flight promise so a fresh parse runs
				const key = parseKey(name, version);
				inFlight.delete(key);
			} else {
				const current = lc.getStatus('rust', name, version);
				if (current.status === 'processing' || current.status === 'ready') {
					return;
				}

				// Also check graph cache
				if (lc.hasCrate(name, version)) {
					emitStatus(name, version, { status: 'ready' });
					return;
				}
			}

			// Set status atomically BEFORE starting the parse
			emitStatus(name, version, { status: 'processing' }, 'resolving');
			startParse(name, version);
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
				return sseResponse(`data: ${JSON.stringify(status)}\n\n`, signal, { ttl: 500 });
			}

			// For unknown crates, auto-trigger parse and stream updates
			if (status.status === 'unknown' && isValidCrateName(name) && isValidVersion(version)) {
				this.triggerParse(name, version);
			}

			// Stream updates
			return sseStreamResponse((push, close) => {
				// Send current status immediately
				const lc = getCache();
				const current = lc.getStatus('rust', name, version);
				if (current.status !== 'unknown') {
					push(`data: ${JSON.stringify(current)}\n\n`);
					if (current.status === 'ready' || current.status === 'failed') {
						close();
						return () => {};
					}
				}

				const unsubscribe = subscribe(name, version, (s) => {
					push(`data: ${JSON.stringify(s)}\n\n`);
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
				const count = lc.getProcessingCount('rust');
				push(`data: ${JSON.stringify({ type: 'processing', count })}\n\n`);

				const unsubscribe = subscribeProcessing((c) => {
					push(`data: ${JSON.stringify({ type: 'processing', count: c })}\n\n`);
				});
				return unsubscribe;
			}, signal, { ttl: 30_000 });
		},

		async streamEdgeUpdates(nodeId: string, signal: AbortSignal): Promise<Response> {
			return sseStreamResponse((push, _close) => {
				const unsubscribe = subscribeEdge(nodeId, (data) => {
					push(`data: ${JSON.stringify(data)}\n\n`);
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
