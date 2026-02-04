import { DurableObject } from 'cloudflare:workers';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import type { WorkspaceOutput, CrateTree } from '$lib/schema';
import type { Node, Edge } from '$lib/graph';
import migrations from '$lib/server/db/migrations/migrations';
import { graphData, sourceCache, crateGraphs, nodeDetails, edges } from '$lib/server/db/schema';

export class GraphStore extends DurableObject {
	private db: DrizzleSqliteDODatabase;

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
				set: { content, cachedAt: now }
			})
			.run();
	}

	async ingestGraph(graphJson: WorkspaceOutput): Promise<void> {
		this.db
			.insert(graphData)
			.values({ id: 1, json: graphJson })
			.onConflictDoUpdate({
				target: graphData.id,
				set: { json: graphJson }
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
		indexJson: string
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
				nodeCount: 0,
				edgeCount: 0,
				parsedAt: now
			})
			.onConflictDoUpdate({
				target: [crateGraphs.ecosystem, crateGraphs.name, crateGraphs.version],
				set: {
					indexJson,
					treeJson: null,
					nodeCount: 0,
					edgeCount: 0,
					parsedAt: now
				}
			})
			.run();
	}

	/**
	 * Store a batch of nodes for a crate.
	 * Called during streaming parse.
	 */
	async storeNodes(
		ecosystem: string,
		name: string,
		version: string,
		nodes: Node[]
	): Promise<void> {
		if (nodes.length === 0) return;

		const rows = nodes.map((node) => ({
			ecosystem,
			crateName: name,
			crateVersion: version,
			nodeId: node.id,
			nodeJson: JSON.stringify(node)
		}));

		// workerd runtime has a low SQL variable limit (~100 total)
		const BATCH = 10;
		for (let i = 0; i < rows.length; i += BATCH) {
			this.db
				.insert(nodeDetails)
				.values(rows.slice(i, i + BATCH))
				.onConflictDoUpdate({
					target: [
						nodeDetails.ecosystem,
						nodeDetails.crateName,
						nodeDetails.crateVersion,
						nodeDetails.nodeId
					],
					set: { nodeJson: sql`excluded.node_json` }
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
		edgeList: Edge[]
	): Promise<void> {
		if (edgeList.length === 0) return;

		const rows = edgeList.map((edge) => ({
			ecosystem,
			crateName: name,
			crateVersion: version,
			fromId: edge.from,
			toId: edge.to,
			kind: edge.kind,
			confidence: edge.confidence
		}));

		// workerd runtime has a low SQL variable limit (~100 total)
		const BATCH = 10;
		for (let i = 0; i < rows.length; i += BATCH) {
			this.db
				.insert(edges)
				.values(rows.slice(i, i + BATCH))
				.onConflictDoNothing()
				.run();
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
		treeJson: string | null
	): Promise<void> {
		this.db
			.update(crateGraphs)
			.set({ nodeCount, edgeCount, treeJson })
			.where(
				and(
					eq(crateGraphs.ecosystem, ecosystem),
					eq(crateGraphs.name, name),
					eq(crateGraphs.version, version)
				)
			)
			.run();
	}

	/**
	 * Get crate metadata (index, tree, counts).
	 */
	async getCrateMeta(
		ecosystem: string,
		name: string,
		version: string
	): Promise<{
		indexJson: string;
		treeJson: string | null;
		nodeCount: number;
		edgeCount: number;
	} | null> {
		const row = this.db
			.select({
				indexJson: crateGraphs.indexJson,
				treeJson: crateGraphs.treeJson,
				nodeCount: crateGraphs.nodeCount,
				edgeCount: crateGraphs.edgeCount
			})
			.from(crateGraphs)
			.where(
				and(
					eq(crateGraphs.ecosystem, ecosystem),
					eq(crateGraphs.name, name),
					eq(crateGraphs.version, version)
				)
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
					eq(crateGraphs.version, version)
				)
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
		nodeId: string
	): Promise<Node | null> {
		const row = this.db
			.select({ nodeJson: nodeDetails.nodeJson })
			.from(nodeDetails)
			.where(
				and(
					eq(nodeDetails.ecosystem, ecosystem),
					eq(nodeDetails.crateName, name),
					eq(nodeDetails.crateVersion, version),
					eq(nodeDetails.nodeId, nodeId)
				)
			)
			.get();
		if (!row) return null;
		return JSON.parse(row.nodeJson) as Node;
	}

	/**
	 * Get all nodes for a crate.
	 */
	async getNodesForCrate(
		ecosystem: string,
		name: string,
		version: string
	): Promise<Node[]> {
		const rows = this.db
			.select({ nodeJson: nodeDetails.nodeJson })
			.from(nodeDetails)
			.where(
				and(
					eq(nodeDetails.ecosystem, ecosystem),
					eq(nodeDetails.crateName, name),
					eq(nodeDetails.crateVersion, version)
				)
			)
			.all();
		return rows.map((row) => JSON.parse(row.nodeJson) as Node);
	}

	/**
	 * Get all edges for a crate.
	 */
	async getEdgesForCrate(
		ecosystem: string,
		name: string,
		version: string
	): Promise<Edge[]> {
		const rows = this.db
			.select({
				fromId: edges.fromId,
				toId: edges.toId,
				kind: edges.kind,
				confidence: edges.confidence
			})
			.from(edges)
			.where(
				and(
					eq(edges.ecosystem, ecosystem),
					eq(edges.crateName, name),
					eq(edges.crateVersion, version)
				)
			)
			.all();
		return rows.map((row) => ({
			from: row.fromId,
			to: row.toId,
			kind: row.kind,
			confidence: row.confidence
		})) as Edge[];
	}

	/**
	 * Get edges connected to a specific node.
	 */
	async getEdgesForNode(
		ecosystem: string,
		name: string,
		version: string,
		nodeId: string
	): Promise<Edge[]> {
		const rows = this.db
			.select({
				fromId: edges.fromId,
				toId: edges.toId,
				kind: edges.kind,
				confidence: edges.confidence
			})
			.from(edges)
			.where(
				and(
					eq(edges.ecosystem, ecosystem),
					eq(edges.crateName, name),
					eq(edges.crateVersion, version),
					sql`(${edges.fromId} = ${nodeId} OR ${edges.toId} = ${nodeId})`
				)
			)
			.all();
		return rows.map((row) => ({
			from: row.fromId,
			to: row.toId,
			kind: row.kind,
			confidence: row.confidence
		})) as Edge[];
	}

	/**
	 * Delete all data for a crate (for re-parsing).
	 */
	async deleteCrate(ecosystem: string, name: string, version: string): Promise<void> {
		this.db
			.delete(nodeDetails)
			.where(
				and(
					eq(nodeDetails.ecosystem, ecosystem),
					eq(nodeDetails.crateName, name),
					eq(nodeDetails.crateVersion, version)
				)
			)
			.run();
		this.db
			.delete(edges)
			.where(
				and(
					eq(edges.ecosystem, ecosystem),
					eq(edges.crateName, name),
					eq(edges.crateVersion, version)
				)
			)
			.run();
		this.db
			.delete(crateGraphs)
			.where(
				and(
					eq(crateGraphs.ecosystem, ecosystem),
					eq(crateGraphs.name, name),
					eq(crateGraphs.version, version)
				)
			)
			.run();
	}
}
