/**
 * FreshnessBackend implementations for Bun-side use (scripts + GHA).
 *
 *   - LocalR2FreshnessBackend: reads/writes the miniflare SQLite store under
 *     `.wrangler/state/v3/...`. Mirrors how `seedLocalR2Artifacts` writes
 *     artifacts to local R2 — same SQLite schema, same blob layout.
 *
 *   - WranglerR2FreshnessBackend: shells out to `wrangler r2 object {get,put,list}`
 *     for either `--local` or `--remote`. Slower than direct SQLite or S3
 *     SDK, but no extra deps and matches the existing upload pipeline's
 *     auth model (the wrangler CLI + token already work in CI).
 *
 * Pick: `LocalR2FreshnessBackend` for the local-mimic script (fast, direct
 * SQLite). `WranglerR2FreshnessBackend` with `target: 'remote'` for GHA.
 */

import { Database } from 'bun:sqlite';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	type FreshnessBackend,
	type FreshnessEntry,
	freshnessKey,
} from '../src/lib/server/parsing/freshness';

// ─── Local (miniflare SQLite) backend ───────────────────────────────

const MINIFLARE_R2_OBJECT_CLASS = 'R2BucketObject';
const MINIFLARE_R2_OBJECT_UNIQUE_KEY = `miniflare-${MINIFLARE_R2_OBJECT_CLASS}`;
const MINIFLARE_R2_SQL = `
CREATE TABLE IF NOT EXISTS _mf_objects (
    key TEXT PRIMARY KEY,
    blob_id TEXT,
    version TEXT NOT NULL,
    size INTEGER NOT NULL,
    etag TEXT NOT NULL,
    uploaded INTEGER NOT NULL,
    checksums TEXT NOT NULL,
    http_metadata TEXT NOT NULL,
    custom_metadata TEXT NOT NULL
);
`;

function durableObjectNamespaceIdFromName(uniqueKey: string, name: string): string {
	const key = createHash('sha256').update(uniqueKey).digest();
	const nameHmac = createHmac('sha256', key).update(name).digest().subarray(0, 16);
	const hmac = createHmac('sha256', key).update(nameHmac).digest().subarray(0, 16);
	return Buffer.concat([nameHmac, hmac]).toString('hex');
}

function localR2Paths(bucket: string, persistTo: string): { blobDir: string; sqlitePath: string } {
	const r2Root = join(persistTo, 'v3', 'r2');
	const objectDir = join(r2Root, MINIFLARE_R2_OBJECT_UNIQUE_KEY);
	const bucketObjectId = durableObjectNamespaceIdFromName(
		MINIFLARE_R2_OBJECT_UNIQUE_KEY,
		bucket,
	);
	return {
		blobDir: join(r2Root, bucket, 'blobs'),
		sqlitePath: join(objectDir, `${bucketObjectId}.sqlite`),
	};
}

export interface LocalR2FreshnessOptions {
	bucket?: string;
	persistTo?: string;
}

/**
 * Local-development freshness backend. Talks straight to the same
 * miniflare SQLite + blob filesystem that `seedLocalR2Artifacts` writes
 * to. Reads scan the `_mf_objects` table; writes follow the same
 * blob-generation/upsert pattern.
 *
 * Single-threaded — assumes one writer (the local-mimic script). Don't
 * run two concurrent mimics against the same `.wrangler` state.
 */
export class LocalR2FreshnessBackend implements FreshnessBackend {
	private readonly bucket: string;
	private readonly persistTo: string;

	constructor(options: LocalR2FreshnessOptions = {}) {
		this.bucket = options.bucket ?? 'crate-graphs';
		this.persistTo = options.persistTo ?? '.wrangler/state/v3';
	}

	async read(name: string): Promise<FreshnessEntry | null> {
		const { blobDir, sqlitePath } = localR2Paths(this.bucket, this.persistTo);
		if (!existsSync(sqlitePath)) return null;
		const db = new Database(sqlitePath, { readonly: true });
		try {
			const row = db
				.query<{ blob_id: string | null }, [string]>(
					'SELECT blob_id FROM _mf_objects WHERE key = ?1',
				)
				.get(freshnessKey(name));
			if (!row?.blob_id) return null;
			const blobPath = join(blobDir, row.blob_id);
			if (!existsSync(blobPath)) return null;
			const bytes = readFileSync(blobPath);
			return JSON.parse(bytes.toString('utf-8')) as FreshnessEntry;
		} finally {
			db.close();
		}
	}

	async write(entry: FreshnessEntry): Promise<void> {
		const { blobDir, sqlitePath } = localR2Paths(this.bucket, this.persistTo);
		mkdirSync(blobDir, { recursive: true });
		mkdirSync(dirname(sqlitePath), { recursive: true });
		const db = new Database(sqlitePath);
		try {
			db.exec(MINIFLARE_R2_SQL);
			const key = freshnessKey(entry.name);
			const bytes = Buffer.from(JSON.stringify(entry, null, 2), 'utf-8');
			const newBlobId = Buffer.concat([
				randomBytes(32),
				Buffer.alloc(8, 0).map((_, i) => Number((BigInt(Date.now()) >> BigInt(8 * (7 - i))) & 0xffn)),
			]).toString('hex');

			db.transaction(() => {
				const existing = db
					.query<{ blob_id: string | null }, [string]>(
						'SELECT blob_id FROM _mf_objects WHERE key = ?1',
					)
					.get(key);
				if (existing?.blob_id) {
					const stalePath = join(blobDir, existing.blob_id);
					if (existsSync(stalePath)) unlinkSync(stalePath);
				}
				writeFileSync(join(blobDir, newBlobId), bytes);
				db.query(
					`
					INSERT OR REPLACE INTO _mf_objects (
						key, blob_id, version, size, etag, uploaded,
						checksums, http_metadata, custom_metadata
					) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
				`,
				).run(
					key,
					newBlobId,
					randomBytes(16).toString('hex'),
					bytes.length,
					createHash('md5').update(bytes).digest('hex'),
					Date.now(),
					'{}',
					JSON.stringify({ contentType: 'application/json; charset=utf-8' }),
					'{}',
				);
			})();
		} finally {
			db.close();
		}
	}

	async list(): Promise<FreshnessEntry[]> {
		const { blobDir, sqlitePath } = localR2Paths(this.bucket, this.persistTo);
		if (!existsSync(sqlitePath)) return [];
		const db = new Database(sqlitePath, { readonly: true });
		try {
			const rows = db
				.query<{ key: string; blob_id: string | null }, [string]>(
					"SELECT key, blob_id FROM _mf_objects WHERE substr(key, 1, length(?1)) = ?1",
				)
				.all('rust/_index/');
			const out: FreshnessEntry[] = [];
			for (const row of rows) {
				if (!row.blob_id) continue;
				const blobPath = join(blobDir, row.blob_id);
				if (!existsSync(blobPath)) continue;
				try {
					const bytes = readFileSync(blobPath);
					out.push(JSON.parse(bytes.toString('utf-8')) as FreshnessEntry);
				} catch (err) {
					console.warn(`[freshness] skipping unreadable entry ${row.key}: ${String(err)}`);
				}
			}
			return out;
		} finally {
			db.close();
		}
	}
}

// ─── Wrangler-CLI backend (works for both local and remote R2) ───────

export interface WranglerR2FreshnessOptions {
	bucket?: string;
	target: 'local' | 'remote';
	persistTo?: string;
	config?: string;
}

/**
 * Freshness backend that shells out to `wrangler r2 object {get,put,list}`.
 * Works against either local miniflare state (`--local`) or production R2
 * (`--remote`). Slower than direct SQLite/S3 because each call spins up
 * the wrangler CLI — fine for ~hundreds of crates per cron run, NOT fine
 * for chatty per-node access.
 *
 * Use this in GHA where wrangler is already installed and authenticated
 * via `CLOUDFLARE_API_TOKEN`. For local development prefer
 * `LocalR2FreshnessBackend` (~100x faster on listings).
 */
export class WranglerR2FreshnessBackend implements FreshnessBackend {
	private readonly bucket: string;
	private readonly target: 'local' | 'remote';
	private readonly persistTo: string;
	private readonly config: string;

	constructor(options: WranglerR2FreshnessOptions) {
		this.bucket = options.bucket ?? 'crate-graphs';
		this.target = options.target;
		this.persistTo = options.persistTo ?? '.wrangler/state/v3';
		this.config = options.config ?? './wrangler.toml';
	}

	private targetFlags(): string[] {
		return this.target === 'local'
			? ['--local', '--persist-to', this.persistTo]
			: ['--remote'];
	}

	async read(name: string): Promise<FreshnessEntry | null> {
		const key = freshnessKey(name);
		const tmpDir = mkdtempSync(join(tmpdir(), 'codeview-freshness-'));
		const out = join(tmpDir, 'entry.json');
		try {
			execFileSync(
				'bun',
				[
					'run',
					'wrangler',
					'r2',
					'object',
					'get',
					`${this.bucket}/${key}`,
					'--file',
					out,
					'--config',
					this.config,
					...this.targetFlags(),
				],
				{ stdio: ['ignore', 'ignore', 'pipe'] },
			);
		} catch (err) {
			// wrangler exits non-zero on 404 — treat any failure as "not present".
			return null;
		}
		try {
			if (!existsSync(out)) return null;
			return JSON.parse(readFileSync(out, 'utf-8')) as FreshnessEntry;
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	}

	async write(entry: FreshnessEntry): Promise<void> {
		const key = freshnessKey(entry.name);
		const tmpDir = mkdtempSync(join(tmpdir(), 'codeview-freshness-'));
		const file = join(tmpDir, 'entry.json');
		try {
			writeFileSync(file, JSON.stringify(entry, null, 2), 'utf-8');
			execFileSync(
				'bun',
				[
					'run',
					'wrangler',
					'r2',
					'object',
					'put',
					`${this.bucket}/${key}`,
					'--file',
					file,
					'--content-type',
					'application/json; charset=utf-8',
					'--config',
					this.config,
					...this.targetFlags(),
				],
				{ stdio: 'inherit' },
			);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	}

	async list(): Promise<FreshnessEntry[]> {
		// `wrangler r2 object list` requires a paginated walk over the prefix.
		// For now, list keys then fetch each one. Future: switch to S3 SDK
		// for the listing path — much faster when freshness rolls past ~500 crates.
		let listJson: string;
		try {
			listJson = execFileSync(
				'bun',
				[
					'run',
					'wrangler',
					'r2',
					'object',
					'list',
					this.bucket,
					'--prefix',
					'rust/_index/',
					'--config',
					this.config,
					...this.targetFlags(),
					'--json',
				],
				{ encoding: 'utf-8' },
			);
		} catch (err) {
			console.warn(`[freshness] list failed: ${String(err)}`);
			return [];
		}
		let keys: string[];
		try {
			const parsed = JSON.parse(listJson) as { objects?: Array<{ key: string }> };
			keys = (parsed.objects ?? []).map((o) => o.key);
		} catch {
			return [];
		}
		const out: FreshnessEntry[] = [];
		for (const key of keys) {
			const name = key.replace(/^rust\/_index\//, '').replace(/\.json$/, '');
			const entry = await this.read(name);
			if (entry) out.push(entry);
		}
		return out;
	}
}
