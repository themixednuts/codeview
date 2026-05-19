/**
 * Seed std crates into local R2 only when missing. Used by `cf:dev` so dev
 * startup transparently parses std on first run but skips on subsequent runs.
 *
 * Run `bun run static:std` directly to force a re-seed.
 */

import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';

const persistTo = process.env.WRANGLER_PERSIST_TO || '.wrangler/state/v3';
const sqliteDir = resolve(join(persistTo, 'v3', 'r2', 'miniflare-R2BucketObject'));

function stdAlreadySeeded(): boolean {
	if (!existsSync(sqliteDir)) return false;
	const files = readdirSync(sqliteDir).filter((f) => f.endsWith('.sqlite'));
	for (const f of files) {
		const db = new Database(join(sqliteDir, f), { readonly: true });
		try {
			const row = db
				.prepare('SELECT 1 FROM _mf_objects WHERE key = ? LIMIT 1')
				.get('rust/alloc/stable.json');
			if (row) return true;
		} catch {
			// _mf_objects table not present yet
		} finally {
			db.close();
		}
	}
	return false;
}

if (stdAlreadySeeded()) {
	console.log(
		'std crates already seeded in local R2 — skipping (run `bun run static:std` to refresh)',
	);
	process.exit(0);
}

console.log('std crates not yet seeded — running static:std...');
const seed = spawnSync('bun', ['run', 'static:std'], { stdio: 'inherit', shell: true });
process.exit(seed.status ?? 1);
