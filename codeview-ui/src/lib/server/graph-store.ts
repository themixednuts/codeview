import { DurableObject } from 'cloudflare:workers';

export class GraphStore extends DurableObject {
	constructor(ctx: DurableObjectState, env: unknown) {
		super(ctx, env);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS graph_data (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				json TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS source_cache (
				path TEXT PRIMARY KEY,
				content TEXT NOT NULL,
				cached_at INTEGER NOT NULL
			);
		`);
	}

	async getGraph(): Promise<string | null> {
		const row = this.ctx.storage.sql
			.exec('SELECT json FROM graph_data WHERE id = 1')
			.one();
		return (row?.json as string) ?? null;
	}

	async getSourceFile(path: string): Promise<string | null> {
		const row = this.ctx.storage.sql
			.exec('SELECT content FROM source_cache WHERE path = ?', path)
			.one();
		return (row?.content as string) ?? null;
	}

	async cacheSourceFile(path: string, content: string): Promise<void> {
		this.ctx.storage.sql.exec(
			'INSERT OR REPLACE INTO source_cache (path, content, cached_at) VALUES (?, ?, ?)',
			path,
			content,
			Date.now()
		);
	}

	async ingestGraph(graphJson: string): Promise<void> {
		this.ctx.storage.sql.exec(
			'INSERT OR REPLACE INTO graph_data (id, json) VALUES (1, ?)',
			graphJson
		);
	}
}
