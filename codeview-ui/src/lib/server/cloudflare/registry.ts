import { Result } from 'better-result';
import { DurableObject } from 'cloudflare:workers';
import { and, count, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { getLogger } from '$lib/log';
import migrations from '$lib/server/db/migrations/migrations';
import { crateStatus, crossEdges, nodeIndex } from '$lib/server/db/schema';
import { isValidEcosystem, isValidCrateName, isValidVersion } from '$lib/server/validation';
import { isStdCrate } from '$lib/std';
import type { GraphStore } from '$cloudflare/store';

const log = getLogger('registry');

type CrateStatusValue = 'unknown' | 'processing' | 'ready' | 'failed';

export interface CrateStatusResult {
	status: CrateStatusValue;
	error?: string;
	step?: string;
}

/**
 * CrateRegistry Durable Object — tracks parse status for crates and
 * pushes real-time updates to WebSocket subscribers.
 *
 * Uses Cloudflare Hibernatable WebSockets for connection management,
 * enabling DO hibernation between messages to reduce costs.
 */
export class CrateRegistry extends DurableObject {
	private db: DrizzleSqliteDODatabase;
	private stepMap = new Map<string, string>();
	private progressSnapshots = new Map<string, { sequence: number; contentId?: string; tree: unknown; contiguous: boolean }>();
	private progressMeta = new Map<string, { sequence: number; contentId?: string }>();
	private appEnv: Env;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.appEnv = env;
		this.db = drizzle(this.ctx.storage);
		this.ctx.blockConcurrencyWhile(async () => {
			migrate(this.db, migrations);
		});
	}

	// ============================================================
	// WebSocket Lifecycle (Hibernatable)
	// ============================================================

	/**
	 * HTTP handler — accepts WebSocket upgrades.
	 */
	async fetch(request: Request): Promise<Response> {
		const upgradeHeader = request.headers.get('Upgrade');
		if (upgradeHeader !== 'websocket') {
			return new Response('Expected WebSocket upgrade', { status: 400 });
		}

		const pair = new WebSocketPair();
		const connectionId = crypto.randomUUID();

		// Accept with hibernation support — tags stored as attachment
		this.ctx.acceptWebSocket(pair[1], [connectionId]);

		// Send connection acknowledgment
		pair[1].send(JSON.stringify({ type: 'connected', connectionId }));

		log.info`ws connect connectionId=${connectionId}`;

		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	/**
	 * Called when a WebSocket message arrives (survives hibernation).
	 */
	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const raw = typeof message === 'string' ? message : new TextDecoder().decode(message);
		let parsed: { action?: string; tags?: string[] };
		try {
			parsed = JSON.parse(raw);
		} catch {
			log.warn`invalid JSON from WebSocket client`;
			return;
		}

		const { action, tags = [] } = parsed;

		if (action === 'subscribe' && tags.length > 0) {
			// Get current subscription tags from attachment
			const currentTags = this.getWsTags(ws);
			for (const tag of tags) {
				currentTags.add(tag);
			}
			this.setWsTags(ws, currentTags);

			log.debug`ws subscribe tags=[${tags.join(', ')}]`;

			// Send initial data for each tag
			for (const tag of tags) {
				const data = await this.getInitialDataForTag(tag);
				if (data !== null) {
					try {
						ws.send(JSON.stringify({ tag, data }));
					} catch {
						// Connection may have closed
					}
				}
			}
		} else if (action === 'unsubscribe' && tags.length > 0) {
			const currentTags = this.getWsTags(ws);
			for (const tag of tags) {
				currentTags.delete(tag);
			}
			this.setWsTags(ws, currentTags);

			log.debug`ws unsubscribe tags=[${tags.join(', ')}]`;
		}
	}

	/**
	 * Called when a WebSocket connection closes (survives hibernation).
	 */
	async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
		log.debug`ws close code=${String(code)} reason=${reason || '(none)'}`;
		// Cloudflare automatically cleans up the WebSocket from getWebSockets()
	}

	/**
	 * Called when a WebSocket encounters an error.
	 */
	async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
		log.warn`ws error: ${String(error)}`;
	}

	// ── Typed emit helpers ──

	private emit = {
		status: (name: string, version: string, data: CrateStatusResult) => {
			this.broadcastToTag(`rust:${name}:${version}`, data);
		},
		progress: (name: string, version: string, data: unknown) => {
			this.broadcastToTag(`progress:rust:${name}:${version}`, data);
		},
		processing: (ecosystem: string, data: { type: 'processing'; count: number }) => {
			this.broadcastToTag(`processing:${ecosystem}`, data);
		},
		edges: (nodeId: string, data: { type: 'cross-edges'; nodeId: string }) => {
			this.broadcastToTag(`edge:${nodeId}`, data);
		}
	};

	// ── Tag management via DO WebSocket attachment serialization ──

	/**
	 * Store subscription tags for a WebSocket using serialization attachment.
	 * We serialize tags as a JSON string in the first attachment slot.
	 */
	private getWsTags(ws: WebSocket): Set<string> {
		try {
			const attachment = ws.deserializeAttachment() as { tags?: string[] } | null;
			return new Set(attachment?.tags ?? []);
		} catch {
			return new Set();
		}
	}

	private setWsTags(ws: WebSocket, tags: Set<string>): void {
		try {
			ws.serializeAttachment({ tags: Array.from(tags) });
		} catch {
			// May fail if WS is closing
		}
	}

	// ── Broadcasting to WebSocket clients ──

	private broadcastToTag<T = unknown>(tag: string, data: T): void {
		const payload = JSON.stringify({ tag, data });
		const sockets = this.ctx.getWebSockets();

		for (const ws of sockets) {
			const tags = this.getWsTags(ws);
			if (!tags.has(tag)) continue;
			try {
				ws.send(payload);
			} catch {
				// Dead connection — Cloudflare will clean up
			}
		}
	}

	// ============================================================
	// RPC Methods - Initial Data
	// ============================================================

	/**
	 * Get initial data for a subscription tag.
	 */
	private async getInitialDataForTag(tag: string): Promise<unknown> {
		if (tag.startsWith('progress:')) {
			const parts = tag.split(':');
			if (parts.length === 4) {
				const [, ecosystem, name, version] = parts;
				return this.getProgressSnapshot(ecosystem, name, version);
			}
		} else if (tag.startsWith('processing:')) {
			const parts = tag.split(':');
			if (parts.length === 2 && isValidEcosystem(parts[1])) {
				const cnt = await this.getProcessingCount(parts[1]);
				return { type: 'processing', count: cnt };
			}
		} else if (!tag.startsWith('edge:')) {
			const parts = tag.split(':');
			if (parts.length === 3 && isValidEcosystem(parts[0])) {
				const [ecosystem, name, version] = parts;
				const status = await this.getStatus(ecosystem, name, version);

				// Auto-trigger parse for unknown non-std crates (mirrors provider.getCrateStatus logic)
				if (status.status === 'unknown' && ecosystem === 'rust' && !isStdCrate(name)) {
					return this.autoTriggerParse(ecosystem, name, version);
				}

				return status;
			}
		}
		return null;
	}

	/**
	 * Check graph presence and auto-trigger parsing for unknown crates.
	 * Mirrors the auto-trigger logic in cloudflare/provider.ts getCrateStatus().
	 */
	private async autoTriggerParse(ecosystem: string, name: string, version: string): Promise<CrateStatusResult> {
		// Registry status can lag — check if graph data already exists and heal
		try {
			const graphStore = this.appEnv.GRAPH_STORE as unknown as DurableObjectNamespace<GraphStore>;
			const graphStub = graphStore.get(graphStore.idFromName(`${ecosystem}/${name}/${version}`));
			const hasGraph = await graphStub.hasCrate(ecosystem, name, version);
			if (hasGraph) {
				await this.setStatus(ecosystem, name, version, 'ready');
				return { status: 'ready' };
			}
		} catch {}

		// Validate and trigger parse workflow
		if (isValidCrateName(name) && isValidVersion(version)) {
			const workflow = this.appEnv.PARSE_CRATE as Workflow;
			await Promise.all([
				this.setStatus(ecosystem, name, version, 'processing'),
				workflow.create({ params: { ecosystem, name, version } })
			]);
			return { status: 'processing' };
		}

		return { status: 'unknown' };
	}

	/**
	 * Get progress snapshot for reconnection.
	 */
	async getProgressSnapshot(ecosystem: string, name: string, version: string): Promise<unknown> {
		const tag = `progress:${ecosystem}:${name}:${version}`;
		const snapshot = this.progressSnapshots.get(tag);
		if (!snapshot) return null;

		const counts = Result.try(() => {
			const tree = snapshot.tree as { nodes?: unknown[]; edges?: unknown[] };
			return { nodeCount: tree.nodes?.length ?? 0, edgeCount: tree.edges?.length ?? 0 };
		}).unwrapOr({ nodeCount: 0, edgeCount: 0 });

		return {
			type: 'snapshot',
			sequence: snapshot.sequence,
			contentId: snapshot.contentId,
			tree: snapshot.tree,
			nodeCount: counts.nodeCount,
			edgeCount: counts.edgeCount
		};
	}

	// ============================================================
	// RPC Methods - Status Management
	// ============================================================

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
		if (!row) {
			log.debug`getStatus ${ecosystem}:${name}:${version} → unknown (no row)`;
			return { status: 'unknown' };
		}
		const stepKey = `${ecosystem}:${name}:${version}`;
		const step = row.status === 'processing' ? this.stepMap.get(stepKey) : undefined;
		log.debug`getStatus ${ecosystem}:${name}:${version} → ${row.status} step=${step ?? '(none)'}`;
		return {
			status: row.status as CrateStatusValue,
			...(row.error ? { error: row.error } : {}),
			...(step ? { step } : {})
		};
	}

	async setStatus(
		ecosystem: string,
		name: string,
		version: string,
		status: CrateStatusValue,
		error?: string,
		step?: string,
		action?: string
	): Promise<void> {
		log.debug`setStatus ${ecosystem}:${name}:${version} status=${status} step=${step ?? '(none)'} error=${error ?? '(none)'}`;
		const now = Date.now();
		const stepKey = `${ecosystem}:${name}:${version}`;
		const progressTag = `progress:${ecosystem}:${name}:${version}`;
		if (status === 'processing' && step) {
			this.stepMap.set(stepKey, step);
			if (step === 'resolving') {
				this.progressSnapshots.delete(progressTag);
				this.progressMeta.delete(progressTag);
			}
		} else if (status !== 'processing') {
			this.stepMap.delete(stepKey);
		}

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
			})
			.run();

		// Broadcast status update via WebSocket
		const currentStep = this.stepMap.get(stepKey);
		const message: CrateStatusResult = { status, ...(error ? { error } : {}), ...(currentStep ? { step: currentStep } : {}), ...(action ? { action } : {}) };
		log.debug`broadcast ${ecosystem}:${name}:${version}`;
		this.emit.status(name, version, message);

		// Broadcast processing count change
		const processingCount = await this.getProcessingCount(ecosystem);
		this.emit.processing(ecosystem, { type: 'processing', count: processingCount });
	}

	// ============================================================
	// RPC Methods - Progress Broadcasting
	// ============================================================

	async broadcastProgress(
		ecosystem: string,
		name: string,
		version: string,
		data: { type: string; sequence?: number; contentId?: string; nodeCount?: number; edgeCount?: number; tree?: unknown; totalItems?: number }
	): Promise<void> {
		const tag = `progress:${ecosystem}:${name}:${version}`;
		let payload = data;
		if (data.tree && (data.nodeCount === undefined || data.edgeCount === undefined)) {
			const counts = Result.try(() => {
				const tree = data.tree as { nodes?: unknown[]; edges?: unknown[] };
				return { nodeCount: tree.nodes?.length ?? 0, edgeCount: tree.edges?.length ?? 0 };
			}).unwrapOr({ nodeCount: 0, edgeCount: 0 });
			payload = {
				...data,
				nodeCount: data.nodeCount ?? counts.nodeCount,
				edgeCount: data.edgeCount ?? counts.edgeCount
			};
		}
		if (typeof payload.sequence === 'number' || payload.contentId) {
			this.progressMeta.set(tag, {
				sequence: payload.sequence ?? 0,
				contentId: payload.contentId
			});
		}
		if (payload.tree) {
			const incoming = Result.try(() => payload.tree as { nodes?: unknown[]; edges?: unknown[] }).unwrapOr({ nodes: [], edges: [] });
			const incomingNodes = Array.isArray(incoming.nodes) ? incoming.nodes : [];
			const incomingEdges = Array.isArray(incoming.edges) ? incoming.edges : [];
			const seq = payload.sequence ?? 0;
			const prior = this.progressSnapshots.get(tag);

			if ((payload.type === 'snapshot' || payload.type === 'complete')) {
				this.progressSnapshots.set(tag, {
					sequence: seq,
					contentId: payload.contentId,
					tree: { nodes: incomingNodes.slice(), edges: incomingEdges.slice() },
					contiguous: true
				});
			} else if (payload.type === 'delta' && prior && prior.contiguous) {
				const priorTree = Result.try(() => prior.tree as { nodes?: unknown[]; edges?: unknown[] }).unwrapOr({ nodes: [], edges: [] });
				const priorNodes = Array.isArray(priorTree.nodes) ? priorTree.nodes : [];
				const priorEdges = Array.isArray(priorTree.edges) ? priorTree.edges : [];
				const sameContent = !payload.contentId || !prior.contentId || payload.contentId === prior.contentId;
				const isContiguous = seq === prior.sequence + 1;
				if (sameContent && isContiguous) {
					for (const node of incomingNodes) priorNodes.push(node);
					for (const edge of incomingEdges) priorEdges.push(edge);
					this.progressSnapshots.set(tag, {
						sequence: seq,
						contentId: payload.contentId ?? prior.contentId,
						tree: { nodes: priorNodes, edges: priorEdges },
						contiguous: true
					});
				} else {
					this.progressSnapshots.delete(tag);
				}
			} else if (payload.type === 'delta' && seq === 0) {
				this.progressSnapshots.set(tag, {
					sequence: seq,
					contentId: payload.contentId,
					tree: { nodes: incomingNodes.slice(), edges: incomingEdges.slice() },
					contiguous: true
				});
			} else {
				this.progressSnapshots.delete(tag);
			}
		}
		log.debug`broadcastProgress ${ecosystem}:${name}:${version} type=${payload.type} nodes=${payload.nodeCount ?? 0}`;
		this.emit.progress(name, version, payload);
	}

	// ============================================================
	// RPC Methods - Cross Edges
	// ============================================================

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
			)
			.run();

		if (edges.length > 0) {
			const BATCH = 10;
			const rows = edges.map((edge) => ({
				ecosystem,
				sourceName: name,
				sourceVersion: version,
				fromId: edge.from,
				toId: edge.to,
				kind: edge.kind,
				confidence: edge.confidence
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
			const BATCH = 10;
			const rows = nodes.map((node) => ({
				nodeId: node.id,
				name: node.name,
				kind: node.kind,
				visibility: node.visibility,
				isExternal: Boolean(node.is_external),
				updatedAt: now
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
							updatedAt: sql`excluded.updated_at`
						}
					})
					.run();
			}
		}

		// Broadcast edge updates via WebSocket
		for (const nodeId of touchedNodes) {
			this.emit.edges(nodeId, { type: 'cross-edges', nodeId });
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

		const allIds = Array.from(nodeIds);
		const QUERY_BATCH = 50;
		const rows: Array<{ nodeId: string; name: string; kind: string; visibility: string; isExternal: boolean }> = [];
		for (let i = 0; i < allIds.length; i += QUERY_BATCH) {
			const batch = allIds.slice(i, i + QUERY_BATCH);
			const batchRows = this.db
				.select({
					nodeId: nodeIndex.nodeId,
					name: nodeIndex.name,
					kind: nodeIndex.kind,
					visibility: nodeIndex.visibility,
					isExternal: nodeIndex.isExternal
				})
				.from(nodeIndex)
				.where(inArray(nodeIndex.nodeId, batch))
				.all();
			rows.push(...batchRows);
		}

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

	// ============================================================
	// RPC Methods - Processing Status
	// ============================================================

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
}
