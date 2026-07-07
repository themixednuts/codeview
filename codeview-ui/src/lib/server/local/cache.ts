/// <reference types="@types/bun" />
import { Result } from 'better-result';
import { formatToMillis, type MigrationMeta } from 'drizzle-orm/migrator';
import type { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core/dialect';
import type { SQLiteSession } from 'drizzle-orm/sqlite-core/session';
import { and, count, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { crateGraphs, crateStatus, crossEdges, nodeIndex, nodeDetails, edges } from '../db/schema';
import { normalizeCrateName } from '../validation';
import type { CrateGraph, Node, Edge, Visibility } from '$lib/graph';
import type { CrateIndex, CrateTree } from '$lib/schema';
import { getLogger } from '$lib/log';
import { visibilityKey, parseVisibilityKey } from '$lib/display-names';
import { buildCrateTree } from '$lib/node-summary';
import type { drizzle as bunSqliteDrizzle } from 'drizzle-orm/bun-sqlite';

const log = getLogger('cache');

type LocalSqliteDatabase = ReturnType<typeof bunSqliteDrizzle>;

type SqliteModules = {
	Database: new (path: string) => any;
	drizzle: (config: { client: any }) => LocalSqliteDatabase;
};

/**
 * Keep SQLite runtime modules lazy and local-only. Cloudflare hosted mode must
 * never load native SQLite; Vite+ dev currently runs SSR under Node, while the
 * compiled local app can still run under Bun.
 */
async function loadSqliteModules(): Promise<SqliteModules> {
	if (typeof Bun !== 'undefined') {
		const { Database } = await import('bun:sqlite');
		const { drizzle } = await import('drizzle-orm/bun-sqlite');
		return { Database, drizzle };
	}

	const { default: Database } = await import('better-sqlite3');
	const { drizzle } = await import('drizzle-orm/better-sqlite3');
	return { Database, drizzle: drizzle as unknown as SqliteModules['drizzle'] };
}

const sqlModules = import.meta.glob('../db/migrations/*/migration.sql', {
	query: '?raw',
	eager: true,
	import: 'default',
}) as Record<string, string>;

const migrations: MigrationMeta[] = Object.entries(sqlModules)
	.map(([path, sql]) => {
		const folderName = path.split('/').at(-2)!;
		return {
			sql: sql.split('--> statement-breakpoint'),
			bps: true,
			folderMillis: formatToMillis(folderName.slice(0, 14)),
			hash: createHash('sha256').update(sql).digest('hex'),
		};
	})
	.sort((a, b) => a.folderMillis - b.folderMillis);

const CACHE_DIR = join(homedir(), '.codeview');
const CACHE_DB = join(CACHE_DIR, 'cache.sqlite');

type CrateStatusValue = 'unknown' | 'processing' | 'ready' | 'failed';

export interface CrateStatusResult {
	status: CrateStatusValue;
	error?: string;
	step?: string;
}

/** LRU in-memory cache for parsed CrateGraphs. Avoids re-reading + re-parsing
 *  the same large JSON blob when multiple server functions need the same graph
 *  within a short window (e.g. getCrateTree + getNodeDetail on page load). */
const GRAPH_CACHE_MAX = 4;
const graphCache = new Map<string, CrateGraph>();

function getCachedGraph(key: string): CrateGraph | undefined {
	const val = graphCache.get(key);
	if (val) {
		// Move to end (most recently used)
		graphCache.delete(key);
		graphCache.set(key, val);
	}
	return val;
}

function setCachedGraph(key: string, graph: CrateGraph): void {
	graphCache.delete(key);
	graphCache.set(key, graph);
	// Evict oldest if over limit
	if (graphCache.size > GRAPH_CACHE_MAX) {
		const oldest = graphCache.keys().next().value!;
		graphCache.delete(oldest);
	}
}

export class LocalCache {
	private db: LocalSqliteDatabase;
	private stepMap = new Map<string, string>();

	static async create(): Promise<LocalCache> {
		return new LocalCache(await loadSqliteModules());
	}

	private norm(name: string): string {
		return normalizeCrateName(name);
	}

	private constructor({ Database, drizzle }: SqliteModules) {
		mkdirSync(CACHE_DIR, { recursive: true });
		const client = new Database(CACHE_DB);
		client.exec('PRAGMA journal_mode = WAL;');
		client.exec('PRAGMA busy_timeout = 5000;');
		this.db = drizzle({ client });
		const { dialect, session } = this.db as unknown as {
			dialect: SQLiteSyncDialect;
			session: SQLiteSession<'sync', unknown>;
		};
		dialect.migrate(migrations, session);

		// Reset zombie statuses from a crashed/killed parse process.
		// Keep "failed" rows so users see what failed and can retry explicitly.
		const zombies = this.db
			.select({
				name: crateStatus.name,
				version: crateStatus.version,
				lastStep: crateStatus.lastStep,
			})
			.from(crateStatus)
			.where(eq(crateStatus.status, 'processing'))
			.all();
		if (zombies.length > 0) {
			for (const z of zombies) {
				log.debug`Cleaning zombie: ${z.name}@${z.version} (was on step: ${z.lastStep ?? 'unknown'})`;
			}
			this.db.delete(crateStatus).where(eq(crateStatus.status, 'processing')).run();
		}
	}

	// ── Crate graph storage ──

	hasCrate(name: string, version: string): boolean {
		const n = this.norm(name);
		const row = this.db
			.select({ name: crateGraphs.name })
			.from(crateGraphs)
			.where(
				and(
					eq(crateGraphs.ecosystem, 'rust'),
					eq(crateGraphs.name, n),
					eq(crateGraphs.version, version),
				),
			)
			.get();
		return row !== undefined;
	}

	/**
	 * Reconstruct full graph from nodeDetails + edges tables.
	 * For large crates, prefer getTree() + getNodeById() for progressive loading.
	 */
	getGraph(name: string, version: string): CrateGraph | null {
		const t0 = performance.now();
		const n = this.norm(name);
		const cacheKey = `${n}@${version}`;

		const cached = getCachedGraph(cacheKey);
		if (cached) {
			log.info`getGraph ${cacheKey}: mem-cache hit`;
			return cached;
		}

		// Check if crate exists
		const meta = this.db
			.select({ nodeCount: crateGraphs.nodeCount, edgeCount: crateGraphs.edgeCount })
			.from(crateGraphs)
			.where(
				and(
					eq(crateGraphs.ecosystem, 'rust'),
					eq(crateGraphs.name, n),
					eq(crateGraphs.version, version),
				),
			)
			.get();
		if (!meta) return null;

		// Load all nodes
		const t1 = performance.now();
		const nodeRows = this.db
			.select({ nodeJson: nodeDetails.nodeJson })
			.from(nodeDetails)
			.where(
				and(
					eq(nodeDetails.ecosystem, 'rust'),
					eq(nodeDetails.crateName, n),
					eq(nodeDetails.crateVersion, version),
				),
			)
			.all();

		const nodes: Node[] = [];
		for (const row of nodeRows) {
			const result = Result.try(() => JSON.parse(row.nodeJson) as Node);
			if (result.isOk()) nodes.push(result.value);
		}

		// Load all edges
		const t2 = performance.now();
		const edgeRows = this.db
			.select({
				fromId: edges.fromId,
				toId: edges.toId,
				kind: edges.kind,
				confidence: edges.confidence,
				isGlob: edges.isGlob,
			})
			.from(edges)
			.where(
				and(eq(edges.ecosystem, 'rust'), eq(edges.crateName, n), eq(edges.crateVersion, version)),
			)
			.all();

		const graphEdges: Edge[] = edgeRows.map((row) => ({
			from: row.fromId,
			to: row.toId,
			kind: row.kind as Edge['kind'],
			confidence: row.confidence as Edge['confidence'],
			is_glob: row.isGlob ? true : undefined,
		}));

		const t3 = performance.now();
		const g: CrateGraph = {
			id: n,
			name: n,
			version,
			nodes,
			edges: graphEdges,
		};

		setCachedGraph(cacheKey, g);
		log.info`getGraph ${cacheKey}: nodes=${(t2 - t1).toFixed(0)}ms, edges=${(t3 - t2).toFixed(0)}ms, ${String(nodes.length)}n ${String(graphEdges.length)}e`;
		return g;
	}

	/**
	 * Get a single node by ID - efficient for progressive loading.
	 */
	getNodeById(name: string, version: string, nodeId: string): Node | null {
		const n = this.norm(name);
		const row = this.db
			.select({ nodeJson: nodeDetails.nodeJson })
			.from(nodeDetails)
			.where(
				and(
					eq(nodeDetails.ecosystem, 'rust'),
					eq(nodeDetails.crateName, n),
					eq(nodeDetails.crateVersion, version),
					eq(nodeDetails.nodeId, nodeId),
				),
			)
			.get();
		if (!row) return null;
		const result = Result.try(() => JSON.parse(row.nodeJson) as Node);
		return result.isOk() ? result.value : null;
	}

	/**
	 * Get edges for a specific node - efficient for progressive loading.
	 */
	getEdgesForNode(name: string, version: string, nodeId: string): Edge[] {
		const n = this.norm(name);
		const outgoingRows = this.db
			.select({
				fromId: edges.fromId,
				toId: edges.toId,
				kind: edges.kind,
				confidence: edges.confidence,
				isGlob: edges.isGlob,
			})
			.from(edges)
			.where(
				and(
					eq(edges.ecosystem, 'rust'),
					eq(edges.crateName, n),
					eq(edges.crateVersion, version),
					eq(edges.fromId, nodeId),
				),
			)
			.all();

		const incomingRows = this.db
			.select({
				fromId: edges.fromId,
				toId: edges.toId,
				kind: edges.kind,
				confidence: edges.confidence,
				isGlob: edges.isGlob,
			})
			.from(edges)
			.where(
				and(
					eq(edges.ecosystem, 'rust'),
					eq(edges.crateName, n),
					eq(edges.crateVersion, version),
					eq(edges.toId, nodeId),
				),
			)
			.all();

		const rowsByKey = new Map<string, (typeof outgoingRows)[number]>();
		for (const row of [...outgoingRows, ...incomingRows]) {
			rowsByKey.set(
				`${row.fromId}\u0000${row.toId}\u0000${row.kind}\u0000${row.confidence}\u0000${String(row.isGlob)}`,
				row,
			);
		}
		const edgeRows = Array.from(rowsByKey.values()).sort((a, b) => {
			if (a.fromId !== b.fromId) return a.fromId < b.fromId ? -1 : 1;
			if (a.toId !== b.toId) return a.toId < b.toId ? -1 : 1;
			if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
			return 0;
		});

		return edgeRows.map((row) => ({
			from: row.fromId,
			to: row.toId,
			kind: row.kind as Edge['kind'],
			confidence: row.confidence as Edge['confidence'],
			is_glob: row.isGlob ? true : undefined,
		}));
	}

	getIndex(name: string, version: string): CrateIndex | null {
		const n = this.norm(name);
		const row = this.db
			.select({ indexJson: crateGraphs.indexJson })
			.from(crateGraphs)
			.where(
				and(
					eq(crateGraphs.ecosystem, 'rust'),
					eq(crateGraphs.name, n),
					eq(crateGraphs.version, version),
				),
			)
			.get();
		if (!row) return null;
		const result = Result.try(() => JSON.parse(row.indexJson) as CrateIndex);
		if (result.isErr()) {
			log.error`Failed to parse cached index for ${n}@${version}`;
			return null;
		}
		return result.value;
	}

	getTree(name: string, version: string): CrateTree | null {
		const n = this.norm(name);
		const row = this.db
			.select({ treeJson: crateGraphs.treeJson })
			.from(crateGraphs)
			.where(
				and(
					eq(crateGraphs.ecosystem, 'rust'),
					eq(crateGraphs.name, n),
					eq(crateGraphs.version, version),
				),
			)
			.get();
		const treeJson = row?.treeJson;
		if (!treeJson) return null;
		const result = Result.try(() => JSON.parse(treeJson) as CrateTree);
		if (result.isErr()) {
			log.error`Failed to parse cached tree for ${n}@${version}`;
			return null;
		}
		return result.value;
	}

	// ── Progressive crate storage ──

	/**
	 * Initialize crate metadata entry (call before batch inserts).
	 */
	initCrate(name: string, version: string, index: CrateIndex): void {
		const n = this.norm(name);
		const now = Date.now();
		this.db
			.insert(crateGraphs)
			.values({
				ecosystem: 'rust',
				name: n,
				version,
				indexJson: JSON.stringify(index),
				treeJson: null,
				nodeCount: 0,
				edgeCount: 0,
				parsedAt: now,
			})
			.onConflictDoUpdate({
				target: [crateGraphs.ecosystem, crateGraphs.name, crateGraphs.version],
				set: {
					indexJson: JSON.stringify(index),
					treeJson: null,
					nodeCount: 0,
					edgeCount: 0,
					parsedAt: now,
				},
			})
			.run();

		// Clear any existing nodes/edges for this crate
		this.db
			.delete(nodeDetails)
			.where(
				and(
					eq(nodeDetails.ecosystem, 'rust'),
					eq(nodeDetails.crateName, n),
					eq(nodeDetails.crateVersion, version),
				),
			)
			.run();
		this.db
			.delete(edges)
			.where(
				and(eq(edges.ecosystem, 'rust'), eq(edges.crateName, n), eq(edges.crateVersion, version)),
			)
			.run();
	}

	/**
	 * Update only the index JSON for a crate without clearing nodes/edges.
	 * Used after progressive parsing has already stored nodes/edges.
	 */
	updateIndex(name: string, version: string, index: CrateIndex): void {
		const n = this.norm(name);
		this.db
			.update(crateGraphs)
			.set({ indexJson: JSON.stringify(index) })
			.where(
				and(
					eq(crateGraphs.ecosystem, 'rust'),
					eq(crateGraphs.name, n),
					eq(crateGraphs.version, version),
				),
			)
			.run();
	}

	/**
	 * Batch insert nodes - call multiple times during streaming parse.
	 */
	insertNodes(name: string, version: string, nodes: Node[]): void {
		if (nodes.length === 0) return;
		const n = this.norm(name);
		const rows = nodes.map((node) => ({
			ecosystem: 'rust',
			crateName: n,
			crateVersion: version,
			nodeId: node.id,
			nodeJson: JSON.stringify(node),
		}));

		// Batch insert in chunks of 500 for SQLite efficiency
		const BATCH = 500;
		for (let i = 0; i < rows.length; i += BATCH) {
			this.db
				.insert(nodeDetails)
				.values(rows.slice(i, i + BATCH))
				.onConflictDoUpdate({
					target: [
						nodeDetails.ecosystem,
						nodeDetails.crateName,
						nodeDetails.crateVersion,
						nodeDetails.nodeId,
					],
					set: { nodeJson: sql`excluded.node_json` },
				})
				.run();
		}
	}

	/**
	 * Batch insert edges - call multiple times during streaming parse.
	 */
	insertEdges(name: string, version: string, edgeList: Edge[]): void {
		if (edgeList.length === 0) return;
		const n = this.norm(name);
		const rows = edgeList.map((edge) => ({
			ecosystem: 'rust',
			crateName: n,
			crateVersion: version,
			fromId: edge.from,
			toId: edge.to,
			kind: edge.kind,
			confidence: edge.confidence,
			isGlob: edge.is_glob === true,
		}));

		// Batch insert in chunks of 500 for SQLite efficiency
		const BATCH = 500;
		for (let i = 0; i < rows.length; i += BATCH) {
			this.db
				.insert(edges)
				.values(rows.slice(i, i + BATCH))
				.onConflictDoNothing()
				.run();
		}
	}

	/**
	 * Finalize crate storage - store tree summary and update counts.
	 */
	finalizeCrate(
		name: string,
		version: string,
		tree: CrateTree,
		nodeCount: number,
		edgeCount: number,
	): void {
		const n = this.norm(name);
		const now = Date.now();
		this.db
			.update(crateGraphs)
			.set({
				treeJson: JSON.stringify(tree),
				nodeCount,
				edgeCount,
				parsedAt: now,
			})
			.where(
				and(
					eq(crateGraphs.ecosystem, 'rust'),
					eq(crateGraphs.name, n),
					eq(crateGraphs.version, version),
				),
			)
			.run();

		// Invalidate mem cache
		const cacheKey = `${n}@${version}`;
		graphCache.delete(cacheKey);
	}

	/**
	 * Legacy putCrate - converts to progressive storage.
	 * @deprecated Use initCrate + insertNodes + insertEdges + finalizeCrate instead.
	 */
	putCrate(name: string, version: string, graph: CrateGraph, index: CrateIndex): void {
		const tree = buildCrateTree(graph);
		this.initCrate(name, version, index);
		this.insertNodes(name, version, graph.nodes);
		this.insertEdges(name, version, graph.edges);
		this.finalizeCrate(name, version, tree, graph.nodes.length, graph.edges.length);
	}

	// ── Crate status tracking ──

	getStatus(ecosystem: string, name: string, version: string): CrateStatusResult {
		const n = this.norm(name);
		const row = this.db
			.select({
				status: crateStatus.status,
				error: crateStatus.error,
				lastStep: crateStatus.lastStep,
			})
			.from(crateStatus)
			.where(
				and(
					eq(crateStatus.ecosystem, ecosystem),
					eq(crateStatus.name, n),
					eq(crateStatus.version, version),
				),
			)
			.get();
		if (!row) return { status: 'unknown' };
		// Prefer in-memory step (most up-to-date), fall back to DB
		const stepKey = `${ecosystem}:${n}:${version}`;
		const step =
			row.status === 'processing'
				? (this.stepMap.get(stepKey) ?? row.lastStep ?? undefined)
				: undefined;
		return {
			status: row.status as CrateStatusValue,
			...(row.error ? { error: row.error } : {}),
			...(step ? { step } : {}),
		};
	}

	setStatus(
		ecosystem: string,
		name: string,
		version: string,
		status: CrateStatusValue,
		error?: string,
		step?: string,
	): void {
		const n = this.norm(name);
		const now = Date.now();
		const stepKey = `${ecosystem}:${n}:${version}`;
		if (status === 'processing' && step) {
			this.stepMap.set(stepKey, step);
		} else if (status !== 'processing') {
			this.stepMap.delete(stepKey);
		}

		this.db
			.insert(crateStatus)
			.values({
				ecosystem,
				name: n,
				version,
				status,
				error: error ?? null,
				lastStep: step ?? null,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: [crateStatus.ecosystem, crateStatus.name, crateStatus.version],
				set: {
					status,
					error: error ?? null,
					lastStep: step ?? null,
					updatedAt: now,
				},
			})
			.run();
	}

	getProcessingCrates(ecosystem: string, limit = 20): Array<{ name: string; version: string }> {
		return this.db
			.select({ name: crateStatus.name, version: crateStatus.version })
			.from(crateStatus)
			.where(and(eq(crateStatus.ecosystem, ecosystem), eq(crateStatus.status, 'processing')))
			.orderBy(desc(crateStatus.updatedAt))
			.limit(limit)
			.all();
	}

	getProcessingCount(ecosystem: string): number {
		const row = this.db
			.select({ count: count() })
			.from(crateStatus)
			.where(and(eq(crateStatus.ecosystem, ecosystem), eq(crateStatus.status, 'processing')))
			.get();
		return Number(row?.count ?? 0);
	}

	// ── Cross-edge indexing ──

	replaceCrossEdges(
		ecosystem: string,
		name: string,
		version: string,
		edges: Array<{
			from: string;
			to: string;
			kind: string;
			confidence: string;
			is_glob?: boolean;
		}>,
		nodes: Array<{
			id: string;
			name: string;
			kind: string;
			visibility: Visibility;
			is_external?: boolean;
		}>,
	): void {
		const n = this.norm(name);
		this.db
			.delete(crossEdges)
			.where(
				and(
					eq(crossEdges.ecosystem, ecosystem),
					eq(crossEdges.sourceName, n),
					eq(crossEdges.sourceVersion, version),
				),
			)
			.run();

		if (edges.length > 0) {
			const BATCH = 10;
			const rows = edges.map((edge) => ({
				ecosystem,
				sourceName: n,
				sourceVersion: version,
				fromId: edge.from,
				toId: edge.to,
				kind: edge.kind,
				confidence: edge.confidence,
				isGlob: edge.is_glob === true,
			}));
			for (let i = 0; i < rows.length; i += BATCH) {
				this.db
					.insert(crossEdges)
					.values(rows.slice(i, i + BATCH))
					.onConflictDoNothing()
					.run();
			}
		}

		if (nodes.length > 0) {
			const now = Date.now();
			const BATCH = 100;
			const rows = nodes.map((node) => ({
				nodeId: node.id,
				name: node.name,
				kind: node.kind,
				// SQLite TEXT column; serialize the tagged enum to its
				// canonical key form ("Public" | "Restricted:crate::foo" | ...)
				// for storage. `parseVisibilityKey` reconstructs on read.
				visibility: visibilityKey(node.visibility),
				isExternal: Boolean(node.is_external),
				updatedAt: now,
			}));
			for (let i = 0; i < rows.length; i += BATCH) {
				this.db
					.insert(nodeIndex)
					.values(rows.slice(i, i + BATCH))
					.onConflictDoUpdate({
						target: nodeIndex.nodeId,
						set: {
							name: sql`excluded.name`,
							kind: sql`excluded.kind`,
							visibility: sql`excluded.visibility`,
							isExternal: sql`excluded.is_external`,
							updatedAt: sql`excluded.updated_at`,
						},
					})
					.run();
			}
		}
	}

	getCrossEdgeData(
		ecosystem: string,
		nodeId: string,
	): {
		edges: Array<{
			from: string;
			to: string;
			kind: string;
			confidence: string;
			is_glob?: boolean;
		}>;
		nodes: Array<{
			id: string;
			name: string;
			kind: string;
			visibility: Visibility;
			is_external?: boolean;
		}>;
	} {
		const edgeRows = this.db
			.select({
				fromId: crossEdges.fromId,
				toId: crossEdges.toId,
				kind: crossEdges.kind,
				confidence: crossEdges.confidence,
				isGlob: crossEdges.isGlob,
			})
			.from(crossEdges)
			.where(
				and(
					eq(crossEdges.ecosystem, ecosystem),
					or(eq(crossEdges.fromId, nodeId), eq(crossEdges.toId, nodeId)),
				),
			)
			.all();
		const edges = edgeRows.map((row) => ({
			from: row.fromId,
			to: row.toId,
			kind: row.kind,
			confidence: row.confidence,
			is_glob: row.isGlob ? true : undefined,
		}));

		const nodeIds = new Set<string>();
		for (const edge of edges) {
			nodeIds.add(edge.from);
			nodeIds.add(edge.to);
		}

		const resultNodes: Array<{
			id: string;
			name: string;
			kind: string;
			visibility: Visibility;
			is_external?: boolean;
		}> = [];
		if (nodeIds.size === 0) return { edges, nodes: resultNodes };

		const allIds = Array.from(nodeIds);
		const QUERY_BATCH = 50;
		for (let i = 0; i < allIds.length; i += QUERY_BATCH) {
			const batch = allIds.slice(i, i + QUERY_BATCH);
			const batchRows = this.db
				.select({
					nodeId: nodeIndex.nodeId,
					name: nodeIndex.name,
					kind: nodeIndex.kind,
					visibility: nodeIndex.visibility,
					isExternal: nodeIndex.isExternal,
				})
				.from(nodeIndex)
				.where(inArray(nodeIndex.nodeId, batch))
				.all();
			for (const row of batchRows) {
				resultNodes.push({
					id: row.nodeId,
					name: row.name,
					kind: row.kind,
					// SQLite stores the canonical key form; parse back to
					// the tagged Visibility tag.
					visibility: parseVisibilityKey(row.visibility),
					is_external: row.isExternal,
				});
			}
		}

		return { edges, nodes: resultNodes };
	}

	// ── Direct tree queries (work mid-parse, before treeJson is finalized) ──

	/**
	 * Find root tree nodes directly from the DB (works mid-parse).
	 * Uses the crate root node ID (underscored crate name) — O(1) lookup.
	 * During progressive parsing, edge-based root detection is unreliable
	 * because parent edges arrive in batches, so we just find the known root.
	 */
	getTreeRootsDirect(name: string, version: string): { node: Node; hasChildren: boolean }[] {
		const n = this.norm(name);
		// Rust crate root node ID is the underscore-normalized name
		const rootNodeId = n.replace(/-/g, '_');

		const node = this.getNodeById(name, version, rootNodeId);
		if (!node || node.is_external) return [];

		// Check if root has structural children
		const hasKids = this.db
			.select({ id: edges.fromId })
			.from(edges)
			.where(
				and(
					eq(edges.ecosystem, 'rust'),
					eq(edges.crateName, n),
					eq(edges.crateVersion, version),
					eq(edges.fromId, rootNodeId),
					inArray(edges.kind, ['Contains', 'Defines']),
				),
			)
			.limit(1)
			.get();

		return [{ node, hasChildren: !!hasKids }];
	}

	/**
	 * Get children of a tree node directly from edges table.
	 */
	getTreeChildrenDirect(
		name: string,
		version: string,
		parentId: string,
	): { node: Node; hasChildren: boolean }[] {
		const n = this.norm(name);
		const eco = 'rust';
		const structuralKinds = ['Contains', 'Defines'];

		const childEdges = this.db
			.select({ toId: edges.toId })
			.from(edges)
			.where(
				and(
					eq(edges.ecosystem, eco),
					eq(edges.crateName, n),
					eq(edges.crateVersion, version),
					eq(edges.fromId, parentId),
					inArray(edges.kind, structuralKinds),
				),
			)
			.all();

		if (childEdges.length === 0) return [];

		const childIds = Array.from(new Set(childEdges.map((row) => row.toId)));
		const childIdsWithChildren = new Set<string>();
		const QUERY_BATCH = 500;
		for (let i = 0; i < childIds.length; i += QUERY_BATCH) {
			const batch = childIds.slice(i, i + QUERY_BATCH);
			const childParentRows = this.db
				.select({ fromId: edges.fromId })
				.from(edges)
				.where(
					and(
						eq(edges.ecosystem, eco),
						eq(edges.crateName, n),
						eq(edges.crateVersion, version),
						inArray(edges.fromId, batch),
						inArray(edges.kind, structuralKinds),
					),
				)
				.all();
			for (const row of childParentRows) {
				childIdsWithChildren.add(row.fromId);
			}
		}

		const children: { node: Node; hasChildren: boolean }[] = [];
		for (const row of childEdges) {
			const node = this.getNodeById(name, version, row.toId);
			if (!node || node.is_external) continue;
			children.push({ node, hasChildren: childIdsWithChildren.has(row.toId) });
		}
		return children;
	}

	/**
	 * Walk parent chain iteratively from edges table.
	 */
	getTreeAncestorsDirect(name: string, version: string, nodeId: string): Node[] {
		const n = this.norm(name);
		const eco = 'rust';
		const structuralKinds = ['Contains', 'Defines'];
		const ancestors: Node[] = [];
		let current = nodeId;
		const visited = new Set<string>();

		while (!visited.has(current)) {
			visited.add(current);
			const parentEdge = this.db
				.select({ fromId: edges.fromId })
				.from(edges)
				.where(
					and(
						eq(edges.ecosystem, eco),
						eq(edges.crateName, n),
						eq(edges.crateVersion, version),
						eq(edges.toId, current),
						inArray(edges.kind, structuralKinds),
					),
				)
				.limit(1)
				.get();
			if (!parentEdge) break;
			const parentNode = this.getNodeById(name, version, parentEdge.fromId);
			if (!parentNode) break;
			ancestors.unshift(parentNode);
			current = parentEdge.fromId;
		}
		return ancestors;
	}
}
