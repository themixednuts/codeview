import { DurableObject } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import type { WorkspaceOutput } from '$lib/schema';
import migrations from '$lib/server/db/migrations/migrations';
import { graphData, sourceCache } from '$lib/server/db/schema';

export class GraphStore extends DurableObject {
	private db: DrizzleSqliteDODatabase;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = drizzle(this.ctx.storage);
		this.ctx.blockConcurrencyWhile(async () => {
			migrate(this.db, migrations);
		});
	}

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
}
