import { DurableObject } from 'cloudflare:workers';
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { getLogger } from '$lib/log';
import migrations from '$lib/server/db/migrations/migrations';
import { crateStatus, crossEdges, nodeIndex } from '$lib/server/db/schema';
import { isValidEcosystem, isValidCrateName, isValidVersion } from '$lib/server/validation';
import { isStdCrate } from '$lib/std';

const log = getLogger('registry');
const nowMs = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());
const PROCESSING_LEASE_TTL_MS = 20 * 60 * 1000;
const STEP_STAGES: Record<string, string> = {
	resolving: '1/5',
	fetching: '2/5',
	parsing: '3/5',
	storing: '4/5',
	indexing: '5/5',
};

function formatStep(step: string | undefined): string {
	if (!step) return 'none';
	const stage = STEP_STAGES[step];
	return stage ? `${step}(${stage})` : step;
}

type CrateStatusValue = 'unknown' | 'processing' | 'ready' | 'failed';

export interface CrateStatusResult {
	status: CrateStatusValue;
	error?: string;
	step?: string;
}

export interface ParseRequestResult {
	created: boolean;
	status: CrateStatusResult;
	reason: string;
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
	private stepStartedAt = new Map<string, number>();
	private crossEdgeIngestStats = new Map<
		string,
		{
			calls: number;
			totalMs: number;
			totalEdges: number;
			totalNodes: number;
			maxMs: number;
			slowCalls: number;
		}
	>();
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

		log.info`ws connect connectionId=${connectionId} sockets=${String(this.ctx.getWebSockets().length)}`;

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

		if (action === 'ping') {
			try {
				ws.send(JSON.stringify({ type: 'pong' }));
			} catch {}
			return;
		}

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
	async webSocketClose(
		ws: WebSocket,
		code: number,
		reason: string,
		wasClean: boolean,
	): Promise<void> {
		const connectionId = this.getWsConnectionId(ws);
		log.info`ws close connectionId=${connectionId} code=${String(code)} clean=${String(wasClean)} reason=${reason || '(none)'} sockets=${String(this.ctx.getWebSockets().length)}`;
		// Cloudflare automatically cleans up the WebSocket from getWebSockets()
	}

	/**
	 * Called when a WebSocket encounters an error.
	 */
	async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
		const connectionId = this.getWsConnectionId(ws);
		log.warn`ws error connectionId=${connectionId}: ${String(error)}`;
	}

	private getWsConnectionId(ws: WebSocket): string {
		try {
			const tags = this.ctx.getTags(ws);
			if (tags.length > 0 && tags[0]) return tags[0];
		} catch {}
		return 'unknown';
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
		},
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
			// No snapshot accumulation — client picks up from next live event
			return null;
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

				// Self-heal: workflow may have crashed after storing tree to R2
				if (status.status === 'failed' && ecosystem === 'rust') {
					const healed = await this.healFailedStatus(ecosystem, name, version);
					if (healed) return healed;
					log.warn`getInitialDataForTag ${tag} returning failed (heal did not find tree in R2) error=${status.error ?? '(none)'}`;
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
	private async autoTriggerParse(
		ecosystem: string,
		name: string,
		version: string,
	): Promise<CrateStatusResult> {
		// Registry status can lag — check if graph data already exists in R2 and heal
		try {
			const r2 = this.appEnv.CRATE_GRAPHS as R2Bucket;
			const head = await r2.head(`${ecosystem}/${name}/${version}/tree.json`);
			if (head) {
				await this.setStatus(ecosystem, name, version, 'ready');
				return { status: 'ready' };
			}
		} catch {}

		if (!isValidCrateName(name) || !isValidVersion(version)) {
			return { status: 'unknown' };
		}

		const enqueue = await this.requestParse(ecosystem, name, version, {
			source: 'registry.autoTriggerParse',
		});
		return enqueue.status;
	}

	async requestParse(
		ecosystem: string,
		name: string,
		version: string,
		options?: { force?: boolean; source?: string },
	): Promise<ParseRequestResult> {
		const force = options?.force ?? false;
		const source = options?.source ?? 'unknown';
		if (!isValidCrateName(name) || !isValidVersion(version)) {
			log.warn`parse.enqueue.skip source=${source} crate=${ecosystem}:${name}:${version} reason=invalid-identifier`;
			return {
				created: false,
				status: { status: 'unknown' },
				reason: 'invalid-identifier',
			};
		}

		const row = this.db
			.select({
				status: crateStatus.status,
				error: crateStatus.error,
				updatedAt: crateStatus.updatedAt,
				lastStep: crateStatus.lastStep,
			})
			.from(crateStatus)
			.where(
				and(
					eq(crateStatus.ecosystem, ecosystem),
					eq(crateStatus.name, name),
					eq(crateStatus.version, version),
				),
			)
			.get();

		const stepKey = `${ecosystem}:${name}:${version}`;
		const step = this.stepMap.get(stepKey) ?? row?.lastStep ?? undefined;
		const status = (row?.status as CrateStatusValue | undefined) ?? 'unknown';
		const leaseAgeMs = row ? Math.max(0, Date.now() - row.updatedAt) : null;

		if (!force && status === 'ready') {
			log.info`parse.enqueue.skip source=${source} crate=${ecosystem}:${name}:${version} reason=already-ready`;
			return {
				created: false,
				status: { status, ...(row?.error ? { error: row.error } : {}) },
				reason: 'already-ready',
			};
		}

		if (!force && status === 'processing') {
			if (leaseAgeMs !== null && leaseAgeMs <= PROCESSING_LEASE_TTL_MS) {
				log.info`parse.enqueue.skip source=${source} crate=${ecosystem}:${name}:${version} reason=lease-active leaseAgeMs=${String(leaseAgeMs)} step=${step ?? '(none)'}`;
				return {
					created: false,
					status: { status: 'processing', ...(step ? { step } : {}) },
					reason: 'lease-active',
				};
			}

			log.warn`parse.enqueue.reclaim source=${source} crate=${ecosystem}:${name}:${version} reason=lease-stale leaseAgeMs=${String(leaseAgeMs ?? -1)} ttlMs=${String(PROCESSING_LEASE_TTL_MS)} step=${step ?? '(none)'}`;
		}

		await this.setStatus(ecosystem, name, version, 'processing', undefined, step ?? 'resolving');

		const workflow = this.appEnv.PARSE_CRATE as Workflow<{
			ecosystem: string;
			name: string;
			version: string;
		}>;
		try {
			await workflow.create({ params: { ecosystem, name, version } });
			log.info`parse.enqueue.create source=${source} crate=${ecosystem}:${name}:${version} force=${String(force)} previousStatus=${status}`;
			return { created: true, status: { status: 'processing' }, reason: 'created' };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (/already exists/i.test(message)) {
				log.warn`parse.enqueue.duplicate source=${source} crate=${ecosystem}:${name}:${version} reason=workflow-instance-exists error=${message}`;
				return {
					created: false,
					status: { status: 'processing', ...(step ? { step } : {}) },
					reason: 'workflow-instance-exists',
				};
			}
			log.error`parse.enqueue.error source=${source} crate=${ecosystem}:${name}:${version} error=${message}`;
			return {
				created: false,
				status: { status: 'processing', ...(step ? { step } : {}) },
				reason: 'enqueue-error',
			};
		}
	}

	/**
	 * Self-heal from 'failed' status when tree data exists in R2.
	 * Workflow may have crashed (e.g. DO RPC size limit) after successfully
	 * storing the tree. Uses R2 head check (cheap, no DO RPC).
	 */
	private async healFailedStatus(
		ecosystem: string,
		name: string,
		version: string,
	): Promise<CrateStatusResult | null> {
		try {
			const r2 = this.appEnv.CRATE_GRAPHS as R2Bucket;
			const head = await r2.head(`${ecosystem}/${name}/${version}/tree.json`);
			if (head) {
				log.info`healFailedStatus ${ecosystem}:${name}:${version} tree exists in R2 (${String(head.size)} bytes), promoting to ready`;
				await this.setStatus(ecosystem, name, version, 'ready');
				return { status: 'ready' };
			}
			log.debug`healFailedStatus ${ecosystem}:${name}:${version} no tree in R2`;
		} catch (err) {
			log.warn`healFailedStatus ${ecosystem}:${name}:${version} error: ${String(err)}`;
		}
		return null;
	}

	// ============================================================
	// RPC Methods - Status Management
	// ============================================================

	async getStatus(ecosystem: string, name: string, version: string): Promise<CrateStatusResult> {
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
					eq(crateStatus.name, name),
					eq(crateStatus.version, version),
				),
			)
			.get();
		if (!row) {
			log.debug`getStatus ${ecosystem}:${name}:${version} → unknown (no row)`;
			return { status: 'unknown' };
		}
		const stepKey = `${ecosystem}:${name}:${version}`;
		const step =
			row.status === 'processing'
				? (this.stepMap.get(stepKey) ?? row.lastStep ?? undefined)
				: undefined;
		if (row.status === 'failed') {
			log.warn`getStatus ${ecosystem}:${name}:${version} → failed error=${row.error ?? '(none)'}`;
		} else {
			log.debug`getStatus ${ecosystem}:${name}:${version} → ${row.status} step=${step ?? '(none)'}`;
		}
		return {
			status: row.status as CrateStatusValue,
			...(row.error ? { error: row.error } : {}),
			...(step ? { step } : {}),
		};
	}

	async setStatus(
		ecosystem: string,
		name: string,
		version: string,
		status: CrateStatusValue,
		error?: string,
		step?: string,
		action?: string,
	): Promise<void> {
		if (status === 'failed') {
			log.warn`setStatus ${ecosystem}:${name}:${version} → failed error=${error ?? '(none)'}`;
		} else {
			log.debug`setStatus ${ecosystem}:${name}:${version} status=${status} step=${step ?? '(none)'}`;
		}
		const now = Date.now();
		const stepKey = `${ecosystem}:${name}:${version}`;
		const previousStep = this.stepMap.get(stepKey);
		const previousStepStartedAt = this.stepStartedAt.get(stepKey);
		const nextStep = status === 'processing' ? (step ?? previousStep ?? null) : null;
		if (status === 'processing' && step) {
			if (previousStep !== step) {
				const elapsedMs =
					typeof previousStepStartedAt === 'number' ? now - previousStepStartedAt : 0;
				log.info`status.transition ${ecosystem}:${name}:${version} ${formatStep(previousStep)} -> ${formatStep(step)} elapsedMs=${String(elapsedMs)}`;
				this.stepStartedAt.set(stepKey, now);
			}
			this.stepMap.set(stepKey, step);
		} else if (status !== 'processing') {
			if (previousStep) {
				const elapsedMs =
					typeof previousStepStartedAt === 'number' ? now - previousStepStartedAt : 0;
				log.info`status.transition ${ecosystem}:${name}:${version} ${formatStep(previousStep)} -> ${status} elapsedMs=${String(elapsedMs)}`;
			}
			this.stepMap.delete(stepKey);
			this.stepStartedAt.delete(stepKey);
		}

		this.db
			.insert(crateStatus)
			.values({
				ecosystem,
				name,
				version,
				status,
				error: error ?? null,
				lastStep: nextStep,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: [crateStatus.ecosystem, crateStatus.name, crateStatus.version],
				set: {
					status,
					error: error ?? null,
					lastStep: nextStep,
					updatedAt: now,
				},
			})
			.run();

		// Broadcast status update via WebSocket
		const currentStep = this.stepMap.get(stepKey);
		const message: CrateStatusResult = {
			status,
			...(error ? { error } : {}),
			...(currentStep ? { step: currentStep } : {}),
			...(action ? { action } : {}),
		};
		log.debug`broadcast ${ecosystem}:${name}:${version}`;
		this.emit.status(name, version, message);

		// Broadcast processing count change
		const processingCount = await this.getProcessingCount(ecosystem);
		this.emit.processing(ecosystem, { type: 'processing', count: processingCount });
	}

	async touchProcessing(
		ecosystem: string,
		name: string,
		version: string,
		step?: string,
	): Promise<void> {
		const now = Date.now();
		const key = `${ecosystem}:${name}:${version}`;
		const currentStep = step ?? this.stepMap.get(key) ?? null;
		if (currentStep) {
			this.stepMap.set(key, currentStep);
		}
		this.db
			.update(crateStatus)
			.set({
				updatedAt: now,
				...(currentStep ? { lastStep: currentStep } : {}),
			})
			.where(
				and(
					eq(crateStatus.ecosystem, ecosystem),
					eq(crateStatus.name, name),
					eq(crateStatus.version, version),
					eq(crateStatus.status, 'processing'),
				),
			)
			.run();
	}

	// ============================================================
	// RPC Methods - Progress Broadcasting
	// ============================================================

	async broadcastProgress(
		ecosystem: string,
		name: string,
		version: string,
		data: {
			type: string;
			nodeCount?: number;
			edgeCount?: number;
			totalItems?: number;
		},
	): Promise<void> {
		log.debug`broadcastProgress ${ecosystem}:${name}:${version} type=${data.type} nodes=${data.nodeCount ?? 0}`;
		this.emit.progress(name, version, data);
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
		}>,
	): Promise<void> {
		await this.beginCrossEdgeIngest(ecosystem, name, version);
		await this.appendCrossEdgeBatch(ecosystem, name, version, edges, nodes);
	}

	async beginCrossEdgeIngest(ecosystem: string, name: string, version: string): Promise<void> {
		this.crossEdgeIngestStats.delete(`${ecosystem}:${name}:${version}`);
		this.db
			.delete(crossEdges)
			.where(
				and(
					eq(crossEdges.ecosystem, ecosystem),
					eq(crossEdges.sourceName, name),
					eq(crossEdges.sourceVersion, version),
				),
			)
			.run();
	}

	async appendCrossEdgeBatch(
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
		}>,
	): Promise<void> {
		const statsKey = `${ecosystem}:${name}:${version}`;
		const ingestStartedAt = nowMs();
		let edgeInsertBatches = 0;
		let nodeUpsertBatches = 0;

		if (edges.length > 0) {
			const SQL_VARIABLE_LIMIT = 100;
			const EDGE_INSERT_COLUMNS = 7;
			const BATCH = Math.max(1, Math.floor(SQL_VARIABLE_LIMIT / EDGE_INSERT_COLUMNS));
			const rows = edges.map((edge) => ({
				ecosystem,
				sourceName: name,
				sourceVersion: version,
				fromId: edge.from,
				toId: edge.to,
				kind: edge.kind,
				confidence: edge.confidence,
			}));
			for (let i = 0; i < rows.length; i += BATCH) {
				const chunk = rows.slice(i, i + BATCH);
				const batchStartedAt = nowMs();
				this.db
					.insert(crossEdges)
					.values(chunk)
					.onConflictDoNothing()
					.run();
				edgeInsertBatches += 1;
				const batchElapsedMs = nowMs() - batchStartedAt;
				if (batchElapsedMs >= 150) {
					log.warn`cross-edge.edges.slow-batch crate=${name}@${version} batch=${String(edgeInsertBatches)} rows=${String(chunk.length)} elapsedMs=${batchElapsedMs.toFixed(1)}`;
				}
			}
		}

		if (nodes.length > 0) {
			const now = Date.now();
			const SQL_VARIABLE_LIMIT = 100;
			const NODE_UPSERT_COLUMNS = 6;
			const BATCH = Math.max(1, Math.floor(SQL_VARIABLE_LIMIT / NODE_UPSERT_COLUMNS));
			const rows = nodes.map((node) => ({
				nodeId: node.id,
				name: node.name,
				kind: node.kind,
				visibility: node.visibility,
				isExternal: Boolean(node.is_external),
				updatedAt: now,
			}));
			for (let i = 0; i < rows.length; i += BATCH) {
				const chunk = rows.slice(i, i + BATCH);
				const batchStartedAt = nowMs();
				this.db
					.insert(nodeIndex)
					.values(chunk)
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
				nodeUpsertBatches += 1;
				const batchElapsedMs = nowMs() - batchStartedAt;
				if (batchElapsedMs >= 150) {
					log.warn`cross-edge.nodes.slow-batch crate=${name}@${version} batch=${String(nodeUpsertBatches)} rows=${String(chunk.length)} elapsedMs=${batchElapsedMs.toFixed(1)}`;
				}
			}
		}

		const ingestElapsedMs = nowMs() - ingestStartedAt;
		const stats = this.crossEdgeIngestStats.get(statsKey) ?? {
			calls: 0,
			totalMs: 0,
			totalEdges: 0,
			totalNodes: 0,
			maxMs: 0,
			slowCalls: 0,
		};
		stats.calls += 1;
		stats.totalMs += ingestElapsedMs;
		stats.totalEdges += edges.length;
		stats.totalNodes += nodes.length;
		if (ingestElapsedMs > stats.maxMs) {
			stats.maxMs = ingestElapsedMs;
		}
		if (ingestElapsedMs >= 150) {
			stats.slowCalls += 1;
		}
		this.crossEdgeIngestStats.set(statsKey, stats);

		if (ingestElapsedMs >= 150 || stats.calls % 100 === 0) {
			const avgMs = stats.totalMs / stats.calls;
			log.info`cross-edge.ingest crate=${name}@${version} call=${String(stats.calls)} callEdges=${String(edges.length)} callNodes=${String(nodes.length)} edgeBatches=${String(edgeInsertBatches)} nodeBatches=${String(nodeUpsertBatches)} elapsedMs=${ingestElapsedMs.toFixed(1)} avgMs=${avgMs.toFixed(1)} maxMs=${stats.maxMs.toFixed(1)} totalEdges=${String(stats.totalEdges)} totalNodes=${String(stats.totalNodes)} slowCalls=${String(stats.slowCalls)}`;
		}
	}

	async getCrossEdgeData(
		ecosystem: string,
		nodeId: string,
	): Promise<{
		edges: Array<{ from: string; to: string; kind: string; confidence: string }>;
		nodes: Array<{
			id: string;
			name: string;
			kind: string;
			visibility: string;
			is_external?: boolean;
		}>;
	}> {
		const outboundRows = this.db
			.select({
				fromId: crossEdges.fromId,
				toId: crossEdges.toId,
				kind: crossEdges.kind,
				confidence: crossEdges.confidence,
			})
			.from(crossEdges)
			.where(and(eq(crossEdges.ecosystem, ecosystem), eq(crossEdges.fromId, nodeId)))
			.all();
		const inboundRows = this.db
			.select({
				fromId: crossEdges.fromId,
				toId: crossEdges.toId,
				kind: crossEdges.kind,
				confidence: crossEdges.confidence,
			})
			.from(crossEdges)
			.where(and(eq(crossEdges.ecosystem, ecosystem), eq(crossEdges.toId, nodeId)))
			.all();
		const edgeRows = outboundRows.concat(inboundRows);
		const edgeKeys = new Set<string>();
		const edges = edgeRows
			.filter((row) => {
				const key = `${row.fromId}|${row.toId}|${row.kind}|${row.confidence}`;
				if (edgeKeys.has(key)) return false;
				edgeKeys.add(key);
				return true;
			})
			.map((row) => ({
				from: row.fromId,
				to: row.toId,
				kind: row.kind,
				confidence: row.confidence,
			}));

		const nodeIds = new Set<string>();
		for (const edge of edges) {
			nodeIds.add(edge.from);
			nodeIds.add(edge.to);
		}

		const nodes: Array<{
			id: string;
			name: string;
			kind: string;
			visibility: string;
			is_external?: boolean;
		}> = [];
		if (nodeIds.size === 0) return { edges, nodes };

		const allIds = Array.from(nodeIds);
		const QUERY_BATCH = 50;
		const rows: Array<{
			nodeId: string;
			name: string;
			kind: string;
			visibility: string;
			isExternal: boolean;
		}> = [];
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
			rows.push(...batchRows);
		}

		for (const row of rows) {
			nodes.push({
				id: row.nodeId,
				name: row.name,
				kind: row.kind,
				visibility: row.visibility,
				is_external: row.isExternal,
			});
		}

		return { edges, nodes };
	}

	// ============================================================
	// RPC Methods - Processing Status
	// ============================================================

	async getProcessingCrates(
		ecosystem: string,
		limit = 20,
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
			version: row.version,
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
