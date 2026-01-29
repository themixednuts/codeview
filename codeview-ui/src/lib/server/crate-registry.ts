import { DurableObject } from 'cloudflare:workers';
import { and, count, desc, eq, inArray, or } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import migrations from './db/migrations';
import { crateStatus, crossEdges, nodeIndex } from './db/schema';
import { isValidEcosystem, parseCrateKey, parseEdgeKey } from './validation';

type CrateStatusValue = 'unknown' | 'processing' | 'ready' | 'failed';

export interface CrateStatusResult {
	status: CrateStatusValue;
	error?: string;
}

/**
 * CrateRegistry Durable Object — tracks parse status for crates and
 * pushes real-time updates to WebSocket subscribers.
 *
 * Uses Cloudflare Hibernatable WebSockets with tags for efficient fan-out.
 */
export class CrateRegistry extends DurableObject {
	private db: DrizzleSqliteDODatabase;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = drizzle(this.ctx.storage);
		this.ctx.blockConcurrencyWhile(async () => {
			await migrate(this.db, migrations);
		});
	}

	async replaceCrossEdges(
		ecosystem: string,
		name: string,
		version: string,
		edges: Array<{
			from: string;
			to: string;
			kind: string;
			confidence: string;
		}>,
		nodes: Array<{
			id: string;
			name: string;
			kind: string;
			visibility: string;
			is_external?: boolean;
		}>
	): Promise<void> {
		const touchedNodes = new Set<string>();
		for (const edge of edges) {
			touchedNodes.add(edge.from);
			touchedNodes.add(edge.to);
		}

		this.db
			.delete(crossEdges)
			.where(
				and(
					eq(crossEdges.ecosystem, ecosystem),
					eq(crossEdges.sourceName, name),
					eq(crossEdges.sourceVersion, version)
				)
			);

		if (edges.length > 0) {
			this.db
				.insert(crossEdges)
				.values(
					edges.map((edge) => ({
						ecosystem,
						sourceName: name,
						sourceVersion: version,
						fromId: edge.from,
						toId: edge.to,
						kind: edge.kind,
						confidence: edge.confidence
					}))
				)
				.onConflictDoNothing();
		}

		const now = Date.now();
		for (const node of nodes) {
			const isExternal = Boolean(node.is_external);
			this.db
				.insert(nodeIndex)
				.values({
					nodeId: node.id,
					name: node.name,
					kind: node.kind,
					visibility: node.visibility,
					isExternal,
					updatedAt: now
				})
				.onConflictDoUpdate({
					target: nodeIndex.nodeId,
					set: {
						name: node.name,
						kind: node.kind,
						visibility: node.visibility,
						isExternal,
						updatedAt: now
					}
				});
		}

		for (const nodeId of touchedNodes) {
			const tag = `edge:${nodeId}`;
			const sockets = this.ctx.getWebSockets(tag);
			if (sockets.length === 0) continue;
			const message = JSON.stringify({ type: 'cross-edges', nodeId });
			for (const ws of sockets) {
				try {
					ws.send(message);
				} catch {
					// Socket already closed — cleanup handled by runtime
				}
			}
		}
	}

	async getCrossEdgeData(
		ecosystem: string,
		nodeId: string
	): Promise<{
		edges: Array<{ from: string; to: string; kind: string; confidence: string }>;
		nodes: Array<{ id: string; name: string; kind: string; visibility: string; is_external?: boolean }>;
	}> {
		const edgeRows = this.db
			.select({
				fromId: crossEdges.fromId,
				toId: crossEdges.toId,
				kind: crossEdges.kind,
				confidence: crossEdges.confidence
			})
			.from(crossEdges)
			.where(
				and(
					eq(crossEdges.ecosystem, ecosystem),
					or(eq(crossEdges.fromId, nodeId), eq(crossEdges.toId, nodeId))
				)
			)
			.all();
		const edges = edgeRows.map((row) => ({
			from: row.fromId,
			to: row.toId,
			kind: row.kind,
			confidence: row.confidence
		}));

		const nodeIds = new Set<string>();
		for (const edge of edges) {
			nodeIds.add(edge.from);
			nodeIds.add(edge.to);
		}

		const nodes: Array<{ id: string; name: string; kind: string; visibility: string; is_external?: boolean }> = [];
		if (nodeIds.size === 0) return { edges, nodes };

		const rows = this.db
			.select({
				nodeId: nodeIndex.nodeId,
				name: nodeIndex.name,
				kind: nodeIndex.kind,
				visibility: nodeIndex.visibility,
				isExternal: nodeIndex.isExternal
			})
			.from(nodeIndex)
			.where(inArray(nodeIndex.nodeId, Array.from(nodeIds)))
			.all();

		for (const row of rows) {
			nodes.push({
				id: row.nodeId,
				name: row.name,
				kind: row.kind,
				visibility: row.visibility,
				is_external: row.isExternal
			});
		}

		return { edges, nodes };
	}

	async getStatus(ecosystem: string, name: string, version: string): Promise<CrateStatusResult> {
		const row = this.db
			.select({ status: crateStatus.status, error: crateStatus.error })
			.from(crateStatus)
			.where(
				and(
					eq(crateStatus.ecosystem, ecosystem),
					eq(crateStatus.name, name),
					eq(crateStatus.version, version)
				)
			)
			.get();
		if (!row) return { status: 'unknown' };
		return {
			status: row.status as CrateStatusValue,
			...(row.error ? { error: row.error } : {})
		};
	}

	async setStatus(
		ecosystem: string,
		name: string,
		version: string,
		status: CrateStatusValue,
		error?: string
	): Promise<void> {
		const now = Date.now();
		this.db
			.insert(crateStatus)
			.values({
				ecosystem,
				name,
				version,
				status,
				error: error ?? null,
				updatedAt: now
			})
			.onConflictDoUpdate({
				target: [crateStatus.ecosystem, crateStatus.name, crateStatus.version],
				set: {
					status,
					error: error ?? null,
					updatedAt: now
				}
			});

		// Broadcast to all WebSocket subscribers watching this crate
		const tag = `${ecosystem}:${name}:${version}`;
		const sockets = this.ctx.getWebSockets(tag);
		const message = JSON.stringify({ status, ...(error ? { error } : {}) });
		for (const ws of sockets) {
			try {
				ws.send(message);
			} catch {
				// Socket already closed — will be cleaned up automatically
			}
		}

		const processingCount = await this.getProcessingCount(ecosystem);
		const processingTag = `processing:${ecosystem}`;
		const processingSockets = this.ctx.getWebSockets(processingTag);
		if (processingSockets.length > 0) {
			const update = JSON.stringify({ type: 'processing', count: processingCount });
			for (const ws of processingSockets) {
				try {
					ws.send(update);
				} catch {
					// Socket already closed — will be cleaned up automatically
				}
			}
		}
	}

	/**
	 * HTTP handler — only accepts WebSocket upgrade requests.
	 * The client passes the subscription key as a query parameter:
	 *   /ws?key=rust:serde:1.0.219
	 */
	async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('Expected WebSocket', { status: 400 });
		}

		const url = new URL(request.url);
		const key = url.searchParams.get('key');
		if (!key) {
			return new Response('Missing key parameter', { status: 400 });
		}

		let tag: string | null = null;
		let keyType: 'crate' | 'processing' | 'edge' | null = null;
		let crateData: { ecosystem: string; name: string; version: string } | null = null;
		let processingEcosystem: string | null = null;
		let edgeData: { nodeId: string } | null = null;

		if (key.startsWith('processing:')) {
			const parts = key.split(':');
			if (parts.length === 2 && isValidEcosystem(parts[1])) {
				tag = key;
				keyType = 'processing';
				processingEcosystem = parts[1];
			}
		} else if (key.startsWith('edge:')) {
			edgeData = parseEdgeKey(key);
			if (edgeData) {
				tag = `edge:${edgeData.nodeId}`;
				keyType = 'edge';
			}
		} else {
			crateData = parseCrateKey(key);
			if (crateData) {
				tag = `${crateData.ecosystem}:${crateData.name}:${crateData.version}`;
				keyType = 'crate';
			}
		}

		if (!tag || !keyType) {
			return new Response('Invalid key parameter', { status: 400 });
		}

		const existing = this.ctx.getWebSockets(tag);
		if (existing.length >= 10) {
			return new Response('Too many connections for this key', { status: 429 });
		}

		const pair = new WebSocketPair();
		// Accept with a tag so getWebSockets(tag) finds this socket
		this.ctx.acceptWebSocket(pair[1], [tag]);

		// Send current status immediately
		if (keyType === 'crate' && crateData) {
			const status = await this.getStatus(crateData.ecosystem, crateData.name, crateData.version);
			pair[1].send(JSON.stringify(status));
		} else if (keyType === 'processing' && processingEcosystem) {
			const count = await this.getProcessingCount(processingEcosystem);
			pair[1].send(JSON.stringify({ type: 'processing', count }));
		}

		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	async getProcessingCrates(
		ecosystem: string,
		limit = 20
	): Promise<Array<{ name: string; version: string }>> {
		const rows = this.db
			.select({ name: crateStatus.name, version: crateStatus.version })
			.from(crateStatus)
			.where(and(eq(crateStatus.ecosystem, ecosystem), eq(crateStatus.status, 'processing')))
			.orderBy(desc(crateStatus.updatedAt))
			.limit(limit)
			.all();
		return rows.map((row) => ({
			name: row.name,
			version: row.version
		}));
	}

	async getProcessingCount(ecosystem: string): Promise<number> {
		const row = this.db
			.select({ count: count() })
			.from(crateStatus)
			.where(and(eq(crateStatus.ecosystem, ecosystem), eq(crateStatus.status, 'processing')))
			.get();
		return Number(row?.count ?? 0);
	}

	async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
		// No client-to-server messages expected after connection
	}

	async webSocketClose(ws: WebSocket): Promise<void> {
		ws.close();
	}

	async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
		// Socket errored — cleanup handled automatically by the runtime
	}
}
