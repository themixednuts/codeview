import { Result } from 'better-result';
import { DurableObject } from 'cloudflare:workers';
import { and, count, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { getLogger } from '$lib/log';
import migrations from '$lib/server/db/migrations/migrations';
import { crateStatus, crossEdges, nodeIndex } from '$lib/server/db/schema';
import { isValidEcosystem, parseCrateKey, parseEdgeKey } from '$lib/server/validation';
import { SharedEventStream } from '../shared-events';

const log = getLogger('registry');

type CrateStatusValue = 'unknown' | 'processing' | 'ready' | 'failed';

export interface CrateStatusResult {
	status: CrateStatusValue;
	error?: string;
	step?: string;
}

/**
 * CrateRegistry Durable Object — tracks parse status for crates and
 * pushes real-time updates to SSE subscribers via multiplexed shared events.
 * 
 * Uses RPC methods for all operations except SSE streaming (which requires fetch).
 */
export class CrateRegistry extends DurableObject {
	private db: DrizzleSqliteDODatabase;
	private stepMap = new Map<string, string>();
	private progressSnapshots = new Map<string, { sequence: number; contentId?: string; tree: unknown; contiguous: boolean }>();
	private progressMeta = new Map<string, { sequence: number; contentId?: string }>();
	private sharedEvents: SharedEventStream;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = drizzle(this.ctx.storage);
		this.sharedEvents = new SharedEventStream(log);
		this.ctx.blockConcurrencyWhile(async () => {
			migrate(this.db, migrations);
		});
	}

	// ============================================================
	// RPC Methods - Subscription Management
	// ============================================================

	/**
	 * Subscribe a client to tags. Returns initial data for each tag.
	 */
	async subscribe(clientId: string, tags: string[]): Promise<Array<{ tag: string; data: unknown }>> {
		log.debug`RPC subscribe clientId=${clientId} tags=[${tags.join(', ')}]`;
		
		this.sharedEvents.subscribe(clientId, tags);
		
		// Collect initial data for each tag
		const initialData: Array<{ tag: string; data: unknown }> = [];
		
		for (const tag of tags) {
			const data = await this.getInitialDataForTag(tag);
			if (data !== null) {
				initialData.push({ tag, data });
				// Also send immediately via SSE
				await this.sharedEvents.sendToClient(clientId, { tag, data });
			}
		}
		
		return initialData;
	}

	/**
	 * Unsubscribe a client from tags.
	 */
	async unsubscribe(clientId: string, tags: string[]): Promise<void> {
		log.debug`RPC unsubscribe clientId=${clientId} tags=[${tags.join(', ')}]`;
		this.sharedEvents.unsubscribe(clientId, tags);
	}

	/**
	 * Ping to keep connection alive.
	 */
	async ping(clientId: string): Promise<void> {
		this.sharedEvents.ping(clientId);
	}

	/**
	 * Get initial data for a subscription tag.
	 */
	private async getInitialDataForTag(tag: string): Promise<unknown> {
		// Parse tag format and fetch appropriate data
		if (tag.startsWith('progress:')) {
			// progress:rust:name:version
			const parts = tag.split(':');
			if (parts.length === 4) {
				const [, ecosystem, name, version] = parts;
				return this.getProgressSnapshot(ecosystem, name, version);
			}
		} else if (tag.startsWith('processing:')) {
			// processing:rust
			const parts = tag.split(':');
			if (parts.length === 2 && isValidEcosystem(parts[1])) {
				const cnt = await this.getProcessingCount(parts[1]);
				return { type: 'processing', count: cnt };
			}
		} else if (!tag.startsWith('edge:')) {
			// Crate status: rust:name:version
			const parts = tag.split(':');
			if (parts.length === 3 && isValidEcosystem(parts[0])) {
				const [ecosystem, name, version] = parts;
				return this.getStatus(ecosystem, name, version);
			}
		}
		// edge: tags have no initial data
		return null;
	}

	/**
	 * Get progress snapshot for reconnection (RPC method).
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
		step?: string
	): Promise<void> {
		log.debug`setStatus ${ecosystem}:${name}:${version} status=${status} step=${step ?? '(none)'} error=${error ?? '(none)'}`;
		const now = Date.now();
		const stepKey = `${ecosystem}:${name}:${version}`;
		const progressTag = `progress:${ecosystem}:${name}:${version}`;
		if (status === 'processing' && step) {
			this.stepMap.set(stepKey, step);
			if (step === 'resolving') {
				// New parse cycle: clear any stale progress snapshot/meta state.
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

		// Broadcast status update via shared events
		const tag = `${ecosystem}:${name}:${version}`;
		const currentStep = this.stepMap.get(stepKey);
		const message = { status, ...(error ? { error } : {}), ...(currentStep ? { step: currentStep } : {}) };
		log.debug`broadcast ${tag}`;
		await this.sharedEvents.broadcast(tag, message);

		// Broadcast processing count change
		const processingCount = await this.getProcessingCount(ecosystem);
		const processingTag = `processing:${ecosystem}`;
		await this.sharedEvents.broadcast(processingTag, { type: 'processing', count: processingCount });
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
		log.debug`broadcastProgress ${tag} type=${payload.type} nodes=${payload.nodeCount ?? 0}`;
		await this.sharedEvents.broadcast(tag, payload);
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

		// Broadcast edge updates
		for (const nodeId of touchedNodes) {
			await this.sharedEvents.broadcast(`edge:${nodeId}`, { type: 'cross-edges', nodeId });
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

	// ============================================================
	// RPC Methods - Shared Event Stream Subscriptions
	// ============================================================

	/**
	 * Subscribe a client to tags via RPC.
	 */
	async subscribeClient(clientId: string, tags: string[]): Promise<void> {
		log.debug`RPC subscribe clientId=${clientId} tags=[${tags.join(', ')}]`;
		this.sharedEvents.subscribe(clientId, tags);
	}

	/**
	 * Unsubscribe a client from tags via RPC.
	 */
	async unsubscribeClient(clientId: string, tags: string[]): Promise<void> {
		log.debug`RPC unsubscribe clientId=${clientId} tags=[${tags.join(', ')}]`;
		this.sharedEvents.unsubscribe(clientId, tags);
	}

	/**
	 * Ping a client to keep connection alive via RPC.
	 */
	async pingClient(clientId: string): Promise<void> {
		this.sharedEvents.ping(clientId);
	}

	// ============================================================
	// HTTP fetch - Only for SSE streaming
	// ============================================================

	/**
	 * HTTP handler — only handles SSE streaming connections.
	 * All other operations use RPC methods.
	 */
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		// Only SSE connections use fetch - everything else uses RPC
		if (path === '/shared-sse') {
			return this.handleSharedSse(request);
		}

		return new Response('Use RPC methods', { status: 400 });
	}

	/**
	 * Handle shared SSE connections (multiplexed).
	 */
	private async handleSharedSse(request: Request): Promise<Response> {
		const clientId = crypto.randomUUID();
		log.info`shared-sse new connection clientId=${clientId}`;

		const { readable, writable } = new TransformStream();
		const writer = writable.getWriter();

		// Register client with shared event stream
		this.sharedEvents.addClient(clientId, writer);

		// Send initial connection acknowledgment
		const encoder = new TextEncoder();
		const ackMessage = encoder.encode(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);
		writer.write(ackMessage).catch(() => {});

		// Clean up when connection closes
		let cleaned = false;
		const cleanup = () => {
			if (cleaned) return;
			cleaned = true;
			log.debug`shared-sse cleanup clientId=${clientId}`;
			this.sharedEvents.removeClient(clientId);
			writer.close().catch(() => {});
		};

		writer.closed.then(cleanup, cleanup);
		if (request.signal) {
			request.signal.addEventListener('abort', cleanup, { once: true });
		}

		return new Response(readable, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				'Content-Encoding': 'identity',
				Connection: 'keep-alive'
			}
		});
	}
}
