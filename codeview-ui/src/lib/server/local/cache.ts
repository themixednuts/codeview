/// <reference types="@types/bun" />
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { formatToMillis, type MigrationMeta } from "drizzle-orm/migrator";
import type { SQLiteSyncDialect } from "drizzle-orm/sqlite-core/dialect";
import type { SQLiteSession } from "drizzle-orm/sqlite-core/session";
import { and, count, desc, eq, inArray, or } from "drizzle-orm";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { crateGraphs, crateStatus, crossEdges, nodeIndex } from "../db/schema";
import { normalizeCrateName } from "../validation";
import type { CrateGraph } from "$lib/graph";
import type { CrateIndex } from "$lib/schema";

const sqlModules = import.meta.glob("../db/migrations/*/migration.sql", {
	query: "?raw",
	eager: true,
	import: "default",
}) as Record<string, string>;

const migrations: MigrationMeta[] = Object.entries(sqlModules)
	.map(([path, sql]) => {
		const folderName = path.split("/").at(-2)!;
		return {
			sql: sql.split("--> statement-breakpoint"),
			bps: true,
			folderMillis: formatToMillis(folderName.slice(0, 14)),
			hash: createHash("sha256").update(sql).digest("hex"),
		};
	})
	.sort((a, b) => a.folderMillis - b.folderMillis);

const CACHE_DIR = join(homedir(), ".codeview");
const CACHE_DB = join(CACHE_DIR, "cache.sqlite");

type CrateStatusValue = "unknown" | "processing" | "ready" | "failed";

export interface CrateStatusResult {
	status: CrateStatusValue;
	error?: string;
	step?: string;
}

export class LocalCache {
	private db;
	private stepMap = new Map<string, string>();

	private norm(name: string): string {
		return normalizeCrateName(name);
	}

	constructor() {
		mkdirSync(CACHE_DIR, { recursive: true });
		this.db = drizzle({ client: new Database(CACHE_DB) });
		const { dialect, session } = this.db as unknown as {
			dialect: SQLiteSyncDialect;
			session: SQLiteSession<"sync", unknown>;
		};
		dialect.migrate(migrations, session);

		// Reset zombie statuses from a crashed/killed parse process.
		// Keep "failed" rows so users see what failed and can retry explicitly.
		this.db
			.delete(crateStatus)
			.where(eq(crateStatus.status, "processing"))
			.run();
	}

	// ── Crate graph storage ──

	hasCrate(name: string, version: string): boolean {
		const n = this.norm(name);
		const row = this.db
			.select({ name: crateGraphs.name })
			.from(crateGraphs)
			.where(
				and(
					eq(crateGraphs.ecosystem, "rust"),
					eq(crateGraphs.name, n),
					eq(crateGraphs.version, version),
				),
			)
			.get();
		return row !== undefined;
	}

	getGraph(name: string, version: string): CrateGraph | null {
		const n = this.norm(name);
		const row = this.db
			.select({ graphJson: crateGraphs.graphJson })
			.from(crateGraphs)
			.where(
				and(
					eq(crateGraphs.ecosystem, "rust"),
					eq(crateGraphs.name, n),
					eq(crateGraphs.version, version),
				),
			)
			.get();
		if (!row) return null;
		try {
			return JSON.parse(row.graphJson) as CrateGraph;
		} catch {
			return null;
		}
	}

	getIndex(name: string, version: string): CrateIndex | null {
		const n = this.norm(name);
		const row = this.db
			.select({ indexJson: crateGraphs.indexJson })
			.from(crateGraphs)
			.where(
				and(
					eq(crateGraphs.ecosystem, "rust"),
					eq(crateGraphs.name, n),
					eq(crateGraphs.version, version),
				),
			)
			.get();
		if (!row) return null;
		try {
			return JSON.parse(row.indexJson) as CrateIndex;
		} catch {
			return null;
		}
	}

	putCrate(name: string, version: string, graph: object, index: object): void {
		const n = this.norm(name);
		const now = Date.now();
		this.db
			.insert(crateGraphs)
			.values({
				ecosystem: "rust",
				name: n,
				version,
				graphJson: JSON.stringify(graph),
				indexJson: JSON.stringify(index),
				parsedAt: now,
			})
			.onConflictDoUpdate({
				target: [crateGraphs.ecosystem, crateGraphs.name, crateGraphs.version],
				set: {
					graphJson: JSON.stringify(graph),
					indexJson: JSON.stringify(index),
					parsedAt: now,
				},
			})
			.run();
	}

	// ── Crate status tracking ──

	getStatus(ecosystem: string, name: string, version: string): CrateStatusResult {
		const n = this.norm(name);
		const row = this.db
			.select({ status: crateStatus.status, error: crateStatus.error })
			.from(crateStatus)
			.where(
				and(
					eq(crateStatus.ecosystem, ecosystem),
					eq(crateStatus.name, n),
					eq(crateStatus.version, version),
				),
			)
			.get();
		if (!row) return { status: "unknown" };
		const stepKey = `${ecosystem}:${n}:${version}`;
		const step = row.status === "processing" ? this.stepMap.get(stepKey) : undefined;
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
		if (status === "processing" && step) {
			this.stepMap.set(stepKey, step);
		} else if (status !== "processing") {
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
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: [crateStatus.ecosystem, crateStatus.name, crateStatus.version],
				set: {
					status,
					error: error ?? null,
					updatedAt: now,
				},
			})
			.run();
	}

	getProcessingCrates(ecosystem: string, limit = 20): Array<{ name: string; version: string }> {
		return this.db
			.select({ name: crateStatus.name, version: crateStatus.version })
			.from(crateStatus)
			.where(and(eq(crateStatus.ecosystem, ecosystem), eq(crateStatus.status, "processing")))
			.orderBy(desc(crateStatus.updatedAt))
			.limit(limit)
			.all();
	}

	getProcessingCount(ecosystem: string): number {
		const row = this.db
			.select({ count: count() })
			.from(crateStatus)
			.where(and(eq(crateStatus.ecosystem, ecosystem), eq(crateStatus.status, "processing")))
			.get();
		return Number(row?.count ?? 0);
	}

	// ── Cross-edge indexing ──

	replaceCrossEdges(
		ecosystem: string,
		name: string,
		version: string,
		edges: Array<{ from: string; to: string; kind: string; confidence: string }>,
		nodes: Array<{ id: string; name: string; kind: string; visibility: string; is_external?: boolean }>,
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
			}));
			for (let i = 0; i < rows.length; i += BATCH) {
				this.db
					.insert(crossEdges)
					.values(rows.slice(i, i + BATCH))
					.onConflictDoNothing()
					.run();
			}
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
					updatedAt: now,
				})
				.onConflictDoUpdate({
					target: nodeIndex.nodeId,
					set: {
						name: node.name,
						kind: node.kind,
						visibility: node.visibility,
						isExternal,
						updatedAt: now,
					},
				})
				.run();
		}
	}

	getCrossEdgeData(
		ecosystem: string,
		nodeId: string,
	): {
		edges: Array<{ from: string; to: string; kind: string; confidence: string }>;
		nodes: Array<{ id: string; name: string; kind: string; visibility: string; is_external?: boolean }>;
	} {
		const edgeRows = this.db
			.select({
				fromId: crossEdges.fromId,
				toId: crossEdges.toId,
				kind: crossEdges.kind,
				confidence: crossEdges.confidence,
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
		}));

		const nodeIds = new Set<string>();
		for (const edge of edges) {
			nodeIds.add(edge.from);
			nodeIds.add(edge.to);
		}

		const resultNodes: Array<{ id: string; name: string; kind: string; visibility: string; is_external?: boolean }> = [];
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
					visibility: row.visibility,
					is_external: row.isExternal,
				});
			}
		}

		return { edges, nodes: resultNodes };
	}
}
