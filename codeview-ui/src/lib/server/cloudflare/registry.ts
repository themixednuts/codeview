import { Result } from 'better-result';
import { DurableObject } from 'cloudflare:workers';
import { and, count, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { getLogger } from '$lib/log';
import migrations from '$lib/server/db/migrations/migrations';
import { crateStatus, crossEdges, nodeIndex } from '$lib/server/db/schema';
import { isValidEcosystem, parseCrateKey, parseEdgeKey } from '$lib/server/validation';

const log = getLogger('registry');

type CrateStatusValue = 'unknown' | 'processing' | 'ready' | 'failed';

export interface CrateStatusResult {
	status: CrateStatusValue;
	error?: string;
	step?: string;
}

/**
 * CrateRegistry Durable Object — tracks parse status for crates and
 * pushes real-time updates to SSE subscribers via TransformStream.
 */
export class CrateRegistry extends DurableObject {
	private db: DrizzleSqliteDODatabase;
	private stepMap = new Map<string, string>();
	private sseWriters = new Map<string, Set<WritableStreamDefaultWriter>>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = drizzle(this.ctx.storage);
		this.ctx.blockConcurrencyWhile(async () => {
			migrate(this.db, migrations);
		});
	}

	private addWriter(tag: string, writer: WritableStreamDefaultWriter): void {
		let set = this.sseWriters.get(tag);
		if (!set) {
			set = new Set();
			this.sseWriters.set(tag, set);
		}
		set.add(writer);
	}

	private removeWriter(tag: string, writer: WritableStreamDefaultWriter): void {
		const set = this.sseWriters.get(tag);
		if (!set) return;
		set.delete(writer);
		if (set.size === 0) this.sseWriters.delete(tag);
	}

	private broadcast(tag: string, data: unknown): void {
		const set = this.sseWriters.get(tag);
		if (!set || set.size === 0) return;
		log.debug`broadcast ${tag} to ${String(set.size)} writer(s)`;
		const jsonResult = Result.try(() => JSON.stringify(data));
		if (jsonResult.isErr()) {
			log.error`Failed to serialize broadcast data for ${tag}`;
			return;
		}
		const encoder = new TextEncoder();
		const chunk = encoder.encode(`data: ${jsonResult.value}\n\n`);
		// Copy to array — removeWriter mutates the Set
		for (const writer of [...set]) {
			try {
				writer.write(chunk).catch(() => {
					this.removeWriter(tag, writer);
				});
			} catch {
				this.removeWriter(tag, writer);
			}
		}
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

		for (const nodeId of touchedNodes) {
			this.broadcast(`edge:${nodeId}`, { type: 'cross-edges', nodeId });
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
		if (status === 'processing' && step) {
			this.stepMap.set(stepKey, step);
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

		// Broadcast to all SSE subscribers watching this crate
		const tag = `${ecosystem}:${name}:${version}`;
		const currentStep = this.stepMap.get(stepKey);
		const message = { status, ...(error ? { error } : {}), ...(currentStep ? { step: currentStep } : {}) };
		const msgJson = Result.try(() => JSON.stringify(message)).unwrapOr('{}');
		log.debug`broadcast ${tag} → ${msgJson}`;
		this.broadcast(tag, message);

		const processingCount = await this.getProcessingCount(ecosystem);
		const processingTag = `processing:${ecosystem}`;
		this.broadcast(processingTag, { type: 'processing', count: processingCount });
	}

	/**
	 * HTTP handler — returns SSE streams for subscription keys.
	 * The client passes the subscription key as a query parameter:
	 *   /sse?key=rust:serde:1.0.219
	 *   /sse?key=processing:rust
	 *   /sse?key=edge:<nodeId>
	 */
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const key = url.searchParams.get('key');
		log.debug`fetch key=${key}`;
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

		// Limit concurrent connections per tag
		const existing = this.sseWriters.get(tag);
		if (existing && existing.size >= 10) {
			return new Response('Too many connections for this key', { status: 429 });
		}

		// Build initial message
		let initialData: unknown = null;
		if (keyType === 'crate' && crateData) {
			initialData = await this.getStatus(crateData.ecosystem, crateData.name, crateData.version);
		} else if (keyType === 'processing' && processingEcosystem) {
			const cnt = await this.getProcessingCount(processingEcosystem);
			initialData = { type: 'processing', count: cnt };
		}
		// edge type has no initial data — updates arrive when edges change

		const encoder = new TextEncoder();
		const { readable, writable } = new TransformStream();
		const writer = writable.getWriter();

		this.addWriter(tag, writer);
		log.debug`registered writer for tag=${tag}, total writers=${String(this.sseWriters.get(tag)?.size ?? 0)}`;

		// Send initial data after registering — don't await since the readable
		// side has no consumer until the Response is returned.
		if (initialData !== null) {
			const initJson = Result.try(() => JSON.stringify(initialData)).unwrapOr('{}');
			const chunk = encoder.encode(`data: ${initJson}\n\n`);
			log.debug`writing initial data for tag=${tag}: ${initJson}`;
			writer.write(chunk).catch(() => {});
		}

		// Clean up writer when the connection closes.
		// writer.closed settles when the readable side is cancelled (CF production).
		// request.signal fires when the upstream proxy aborts (wrangler dev).
		// Both may fire — guard ensures we only run once.
		const capturedTag = tag;
		let cleaned = false;
		const cleanup = () => {
			if (cleaned) return;
			cleaned = true;
			log.debug`writer cleanup for tag=${capturedTag}`;
			this.removeWriter(capturedTag, writer);
			writer.close().catch(() => {});
		};
		writer.closed.then(cleanup, cleanup);
		if (request.signal) {
			request.signal.addEventListener('abort', cleanup, { once: true });
		}

		log.debug`returning SSE response for tag=${tag}`;
		return new Response(readable, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				'Content-Encoding': 'identity',
				Connection: 'keep-alive'
			}
		});
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
}
