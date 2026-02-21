import { DurableObject } from 'cloudflare:workers';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import type { WorkspaceOutput, NodeSummary } from '$lib/schema';
import type { Node, Edge } from '$lib/graph';
import migrations from '$lib/server/db/migrations/migrations';
import { graphData, sourceCache, crateGraphs, nodeDetails, edges } from '$lib/server/db/schema';
import { normalizeCrateName } from '$lib/crate-names';
import { getLogger } from '$lib/log';

const SQL_VARIABLE_LIMIT = 100;
const STRUCTURAL_EDGE_KINDS = ['Contains', 'Defines'] as const;
const log = getLogger('graph-store');
const nowMs = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());

export class GraphStore extends DurableObject {
	private db: DrizzleSqliteDODatabase;
	private activeParseSessions = new Map<string, string>();
	private edgeIngestStats = new Map<
		string,
		{
			calls: number;
			totalMs: number;
			totalEdges: number;
			maxMs: number;
			slowCalls: number;
		}
	>();

	private crateKey(ecosystem: string, name: string, version: string): string {
		return `${ecosystem}:${name}:${version}`;
	}

	private isActiveSession(
		ecosystem: string,
		name: string,
		version: string,
		parseSession?: string,
	): boolean {
		if (!parseSession) return true;
		return this.activeParseSessions.get(this.crateKey(ecosystem, name, version)) === parseSession;
	}

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = drizzle(this.ctx.storage);
		this.ctx.blockConcurrencyWhile(async () => {
			migrate(this.db, migrations);
		});
	}

	// ---------------------------------------------------------------------------
	// Legacy methods (for backwards compatibility)
	// ---------------------------------------------------------------------------

	async getGraph(): Promise<WorkspaceOutput | null> {
		const row = this.db
			.select({ json: graphData.json })
			.from(graphData)
			.where(eq(graphData.id, 1))
			.get();
		return row?.json ?? null;
	}

	async getSourceFile(path: string): Promise<string | null> {
		const row = this.db
			.select({ content: sourceCache.content })
			.from(sourceCache)
			.where(eq(sourceCache.path, path))
			.get();
		return row?.content ?? null;
	}

	async cacheSourceFile(path: string, content: string): Promise<void> {
		const now = Date.now();
		this.db
			.insert(sourceCache)
			.values({ path, content, cachedAt: now })
			.onConflictDoUpdate({
				target: sourceCache.path,
				set: { content, cachedAt: now },
			})
			.run();
	}

	async ingestGraph(graphJson: WorkspaceOutput): Promise<void> {
		this.db
			.insert(graphData)
			.values({ id: 1, json: graphJson })
			.onConflictDoUpdate({
				target: graphData.id,
				set: { json: graphJson },
			})
			.run();
	}

	// ---------------------------------------------------------------------------
	// Progressive storage methods
	// ---------------------------------------------------------------------------

	/**
	 * Initialize a crate record for progressive storage.
	 * Called before streaming nodes/edges.
	 */
	async initCrate(
		ecosystem: string,
		name: string,
		version: string,
		indexJson: string,
		parseSession: string,
	): Promise<void> {
		const now = Date.now();
		this.db
			.insert(crateGraphs)
			.values({
				ecosystem,
				name,
				version,
				indexJson,
				treeJson: null,
				parseSession,
				committed: false,
				nodeCount: 0,
				edgeCount: 0,
				parsedAt: now,
			})
			.onConflictDoUpdate({
				target: [crateGraphs.ecosystem, crateGraphs.name, crateGraphs.version],
				set: {
					indexJson,
					treeJson: null,
					parseSession,
					committed: false,
					nodeCount: 0,
					edgeCount: 0,
					parsedAt: now,
				},
			})
			.run();
		this.activeParseSessions.set(this.crateKey(ecosystem, name, version), parseSession);
	}

	/**
	 * Store a batch of nodes for a crate.
	 * Called during streaming parse.
	 */
	async storeNodes(
		ecosystem: string,
		name: string,
		version: string,
		nodes: Node[],
		parseSession?: string,
	): Promise<void> {
		if (nodes.length === 0) return;
		if (!this.isActiveSession(ecosystem, name, version, parseSession)) return;

		const rows = nodes.map((node) => ({
			ecosystem,
			crateName: name,
			crateVersion: version,
			nodeId: node.id,
			nodeJson: JSON.stringify(node),
		}));

		const NODE_INSERT_COLUMNS = 5;
		const BATCH = Math.max(1, Math.floor(SQL_VARIABLE_LIMIT / NODE_INSERT_COLUMNS));
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
	 * Store a batch of edges for a crate.
	 * Called during streaming parse.
	 */
	async storeEdges(
		ecosystem: string,
		name: string,
		version: string,
		edgeList: Edge[],
		parseSession?: string,
	): Promise<void> {
		if (edgeList.length === 0) return;
		if (!this.isActiveSession(ecosystem, name, version, parseSession)) return;
		const statsKey = `${ecosystem}:${name}:${version}`;
		const callStartedAt = nowMs();
		let batchCount = 0;

		const rows = edgeList.map((edge) => ({
			ecosystem,
			crateName: name,
			crateVersion: version,
			fromId: edge.from,
			toId: edge.to,
			kind: edge.kind,
			confidence: edge.confidence,
		}));

		const EDGE_INSERT_COLUMNS = 7;
		const BATCH = Math.max(1, Math.floor(SQL_VARIABLE_LIMIT / EDGE_INSERT_COLUMNS));
		for (let i = 0; i < rows.length; i += BATCH) {
			const chunk = rows.slice(i, i + BATCH);
			const batchStartedAt = nowMs();
			this.db
				.insert(edges)
				.values(chunk)
				.onConflictDoNothing()
				.run();
			batchCount += 1;
			const batchElapsedMs = nowMs() - batchStartedAt;
			if (batchElapsedMs >= 150) {
				log.warn`storeEdges.slow-batch crate=${name}@${version} batch=${String(batchCount)} rows=${String(chunk.length)} elapsedMs=${batchElapsedMs.toFixed(1)}`;
			}
		}

		const callElapsedMs = nowMs() - callStartedAt;
		const stats = this.edgeIngestStats.get(statsKey) ?? {
			calls: 0,
			totalMs: 0,
			totalEdges: 0,
			maxMs: 0,
			slowCalls: 0,
		};
		stats.calls += 1;
		stats.totalMs += callElapsedMs;
		stats.totalEdges += edgeList.length;
		if (callElapsedMs > stats.maxMs) {
			stats.maxMs = callElapsedMs;
		}
		if (callElapsedMs >= 200) {
			stats.slowCalls += 1;
		}
		this.edgeIngestStats.set(statsKey, stats);

		if (callElapsedMs >= 200 || stats.calls % 100 === 0) {
			const avgMs = stats.totalMs / stats.calls;
			log.info`storeEdges.ingest crate=${name}@${version} call=${String(stats.calls)} callEdges=${String(edgeList.length)} batches=${String(batchCount)} elapsedMs=${callElapsedMs.toFixed(1)} avgMs=${avgMs.toFixed(1)} maxMs=${stats.maxMs.toFixed(1)} totalEdges=${String(stats.totalEdges)} slowCalls=${String(stats.slowCalls)}`;
		}
	}

	/**
	 * Finalize a crate after streaming is complete.
	 * Updates counts and stores tree summary.
	 */
	async finalizeCrate(
		ecosystem: string,
		name: string,
		version: string,
		nodeCount: number,
		edgeCount: number,
		treeJson: string | null,
		parseSession: string,
	): Promise<void> {
		this.db
			.update(crateGraphs)
			.set({ nodeCount, edgeCount, treeJson, committed: true })
			.where(
				and(
					eq(crateGraphs.ecosystem, ecosystem),
					eq(crateGraphs.name, name),
					eq(crateGraphs.version, version),
					eq(crateGraphs.parseSession, parseSession),
				),
			)
			.run();
		const key = this.crateKey(ecosystem, name, version);
		if (this.activeParseSessions.get(key) === parseSession) {
			this.activeParseSessions.delete(key);
		}
	}

	/**
	 * Get crate metadata (index, tree, counts).
	 */
	async getCrateMeta(
		ecosystem: string,
		name: string,
		version: string,
	): Promise<{
		indexJson: string;
		treeJson: string | null;
		committed: boolean;
		nodeCount: number;
		edgeCount: number;
	} | null> {
		const row = this.db
			.select({
				indexJson: crateGraphs.indexJson,
				treeJson: crateGraphs.treeJson,
				committed: crateGraphs.committed,
				nodeCount: crateGraphs.nodeCount,
				edgeCount: crateGraphs.edgeCount,
			})
			.from(crateGraphs)
			.where(
				and(
					eq(crateGraphs.ecosystem, ecosystem),
					eq(crateGraphs.name, name),
					eq(crateGraphs.version, version),
				),
			)
			.get();
		return row ?? null;
	}

	/**
	 * Check if a crate exists in progressive storage.
	 */
	async hasCrate(ecosystem: string, name: string, version: string): Promise<boolean> {
		const row = this.db
			.select({ count: sql<number>`count(*)` })
			.from(crateGraphs)
			.where(
				and(
					eq(crateGraphs.ecosystem, ecosystem),
					eq(crateGraphs.name, name),
					eq(crateGraphs.version, version),
					eq(crateGraphs.committed, true),
				),
			)
			.get();
		return (row?.count ?? 0) > 0;
	}

	/**
	 * Get a single node by ID.
	 */
	async getNode(
		ecosystem: string,
		name: string,
		version: string,
		nodeId: string,
	): Promise<Node | null> {
		const row = this.db
			.select({ nodeJson: nodeDetails.nodeJson })
			.from(nodeDetails)
			.where(
				and(
					eq(nodeDetails.ecosystem, ecosystem),
					eq(nodeDetails.crateName, name),
					eq(nodeDetails.crateVersion, version),
					eq(nodeDetails.nodeId, nodeId),
				),
			)
			.get();
		if (!row) return null;
		return JSON.parse(row.nodeJson) as Node;
	}

	/**
	 * Get all nodes for a crate.
	 */
	async getNodesForCrate(ecosystem: string, name: string, version: string): Promise<Node[]> {
		const rows = this.db
			.select({ nodeJson: nodeDetails.nodeJson })
			.from(nodeDetails)
			.where(
				and(
					eq(nodeDetails.ecosystem, ecosystem),
					eq(nodeDetails.crateName, name),
					eq(nodeDetails.crateVersion, version),
				),
			)
			.all();
		return rows.map((row) => JSON.parse(row.nodeJson) as Node);
	}

	/**
	 * Get all edges for a crate.
	 */
	async getEdgesForCrate(ecosystem: string, name: string, version: string): Promise<Edge[]> {
		const rows = this.db
			.select({
				fromId: edges.fromId,
				toId: edges.toId,
				kind: edges.kind,
				confidence: edges.confidence,
			})
			.from(edges)
			.where(
				and(
					eq(edges.ecosystem, ecosystem),
					eq(edges.crateName, name),
					eq(edges.crateVersion, version),
				),
			)
			.all();
		return rows.map((row) => ({
			from: row.fromId,
			to: row.toId,
			kind: row.kind,
			confidence: row.confidence,
		})) as Edge[];
	}

	async getTreeRootsDirect(
		ecosystem: string,
		name: string,
		version: string,
	): Promise<Array<{ node: NodeSummary; hasChildren: boolean }>> {
		const rootNodeId = normalizeCrateName(name);
		const node = await this.getNode(ecosystem, name, version, rootNodeId);
		if (!node || node.is_external) return [];

		const hasChildren = this.db
			.select({ fromId: edges.fromId })
			.from(edges)
			.where(
				and(
					eq(edges.ecosystem, ecosystem),
					eq(edges.crateName, name),
					eq(edges.crateVersion, version),
					eq(edges.fromId, rootNodeId),
					inArray(edges.kind, [...STRUCTURAL_EDGE_KINDS]),
				),
			)
			.limit(1)
			.get();

		return [
			{
				node: summarizeNode(node),
				hasChildren: Boolean(hasChildren),
			},
		];
	}

	async getTreeChildrenDirect(
		ecosystem: string,
		name: string,
		version: string,
		parentId: string,
	): Promise<Array<{ node: NodeSummary; hasChildren: boolean }>> {
		const childRows = this.db
			.select({ toId: edges.toId })
			.from(edges)
			.where(
				and(
					eq(edges.ecosystem, ecosystem),
					eq(edges.crateName, name),
					eq(edges.crateVersion, version),
					eq(edges.fromId, parentId),
					inArray(edges.kind, [...STRUCTURAL_EDGE_KINDS]),
				),
			)
			.all();
		if (childRows.length === 0) return [];

		const childIds = childRows.map((row) => row.toId);
		const nodeRows = this.db
			.select({ nodeId: nodeDetails.nodeId, nodeJson: nodeDetails.nodeJson })
			.from(nodeDetails)
			.where(
				and(
					eq(nodeDetails.ecosystem, ecosystem),
					eq(nodeDetails.crateName, name),
					eq(nodeDetails.crateVersion, version),
					inArray(nodeDetails.nodeId, childIds),
				),
			)
			.all();
		const nodesById = new Map(nodeRows.map((row) => [row.nodeId, JSON.parse(row.nodeJson) as Node]));

		const descendantRows = this.db
			.select({ fromId: edges.fromId })
			.from(edges)
			.where(
				and(
					eq(edges.ecosystem, ecosystem),
					eq(edges.crateName, name),
					eq(edges.crateVersion, version),
					inArray(edges.fromId, childIds),
					inArray(edges.kind, [...STRUCTURAL_EDGE_KINDS]),
				),
			)
			.all();
		const hasChildrenIds = new Set(descendantRows.map((row) => row.fromId));

		const out: Array<{ node: NodeSummary; hasChildren: boolean }> = [];
		for (const childId of childIds) {
			const node = nodesById.get(childId);
			if (!node || node.is_external) continue;
			out.push({
				node: summarizeNode(node),
				hasChildren: hasChildrenIds.has(childId),
			});
		}
		return out;
	}

	async getTreeAncestorsDirect(
		ecosystem: string,
		name: string,
		version: string,
		nodeId: string,
	): Promise<NodeSummary[]> {
		const ancestors: NodeSummary[] = [];
		const visited = new Set<string>();
		let current = nodeId;

		while (!visited.has(current)) {
			visited.add(current);
			const parentEdge = this.db
				.select({ fromId: edges.fromId })
				.from(edges)
				.where(
					and(
						eq(edges.ecosystem, ecosystem),
						eq(edges.crateName, name),
						eq(edges.crateVersion, version),
						eq(edges.toId, current),
						inArray(edges.kind, [...STRUCTURAL_EDGE_KINDS]),
					),
				)
				.limit(1)
				.get();
			if (!parentEdge) break;

			const parent = await this.getNode(ecosystem, name, version, parentEdge.fromId);
			if (!parent) break;
			ancestors.unshift(summarizeNode(parent));
			current = parentEdge.fromId;
		}

		return ancestors;
	}

	async searchNodeSummaries(
		ecosystem: string,
		name: string,
		version: string,
		query: string,
		limit = 200,
	): Promise<NodeSummary[]> {
		const q = query.trim().toLowerCase();
		if (!q) return [];
		const pattern = `%${q}%`;

		const rows = this.db
			.select({
				nodeId: nodeDetails.nodeId,
				name: sql<string>`json_extract(${nodeDetails.nodeJson}, '$.name')`,
				kind: sql<string>`json_extract(${nodeDetails.nodeJson}, '$.kind')`,
				visibility: sql<string>`json_extract(${nodeDetails.nodeJson}, '$.visibility')`,
				isExternal: sql<number>`coalesce(json_extract(${nodeDetails.nodeJson}, '$.is_external'), 0)`,
			})
			.from(nodeDetails)
			.where(
				and(
					eq(nodeDetails.ecosystem, ecosystem),
					eq(nodeDetails.crateName, name),
					eq(nodeDetails.crateVersion, version),
					sql`(
						lower(${nodeDetails.nodeId}) LIKE ${pattern}
						OR lower(json_extract(${nodeDetails.nodeJson}, '$.name')) LIKE ${pattern}
					)`,
				),
			)
			.limit(limit)
			.all();

		return rows
			.filter((row) => row.isExternal === 0)
			.map((row) => ({
				id: row.nodeId,
				name: row.name ?? row.nodeId,
				kind: (row.kind ?? 'Module') as NodeSummary['kind'],
				visibility: (row.visibility ?? 'Unknown') as NodeSummary['visibility'],
				is_external: undefined,
			}));
	}

	/**
	 * Get edges connected to a specific node.
	 */
	async getEdgesForNode(
		ecosystem: string,
		name: string,
		version: string,
		nodeId: string,
	): Promise<Edge[]> {
		const rows = this.db
			.select({
				fromId: edges.fromId,
				toId: edges.toId,
				kind: edges.kind,
				confidence: edges.confidence,
			})
			.from(edges)
			.where(
				and(
					eq(edges.ecosystem, ecosystem),
					eq(edges.crateName, name),
					eq(edges.crateVersion, version),
					sql`(${edges.fromId} = ${nodeId} OR ${edges.toId} = ${nodeId})`,
				),
			)
			.all();
		return rows.map((row) => ({
			from: row.fromId,
			to: row.toId,
			kind: row.kind,
			confidence: row.confidence,
		})) as Edge[];
	}

	/**
	 * Delete all data for a crate (for re-parsing).
	 */
	async deleteCrate(ecosystem: string, name: string, version: string): Promise<void> {
		this.activeParseSessions.delete(this.crateKey(ecosystem, name, version));
		this.edgeIngestStats.delete(`${ecosystem}:${name}:${version}`);
		this.db
			.delete(nodeDetails)
			.where(
				and(
					eq(nodeDetails.ecosystem, ecosystem),
					eq(nodeDetails.crateName, name),
					eq(nodeDetails.crateVersion, version),
				),
			)
			.run();
		this.db
			.delete(edges)
			.where(
				and(
					eq(edges.ecosystem, ecosystem),
					eq(edges.crateName, name),
					eq(edges.crateVersion, version),
				),
			)
			.run();
		this.db
			.delete(crateGraphs)
			.where(
				and(
					eq(crateGraphs.ecosystem, ecosystem),
					eq(crateGraphs.name, name),
					eq(crateGraphs.version, version),
				),
			)
			.run();
	}
}

function summarizeNode(node: Node): NodeSummary {
	return {
		id: node.id,
		name: node.name,
		kind: node.kind,
		visibility: node.visibility,
		is_external: node.is_external,
		...(node.kind === 'Impl'
			? {
					impl_trait: node.impl_trait,
					generics: node.generics,
					where_clause: node.where_clause,
					bound_links: node.bound_links,
				}
			: {}),
	};
}
