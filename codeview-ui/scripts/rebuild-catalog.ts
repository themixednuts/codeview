/**
 * Rebuild rust/catalog.json from the freshness index.
 *
 * The catalog is the read-side index of "which crates exist in our R2".
 * Today it's written piecemeal by `publish-static-crate.ts` (each crate
 * appends itself). The freshness registry already records every
 * successful parse — this script derives the catalog FROM that as the
 * single source of truth.
 *
 * Run shape: after the parse.yml matrix completes, the `catalog` job
 * invokes this. Also safe to run manually at any time.
 *
 * Inputs (env):
 *   STATIC_R2_TARGET   'local' | 'remote'     default: local
 *   R2_BUCKET                                  default: crate-graphs
 *   WRANGLER_PERSIST_TO                        default: .wrangler/state/v3
 *   DRY_RUN            '1' to print without writing
 *
 * Writes: `rust/catalog.json` with shape
 *   { schema_version: 1, generated_at: ISO, crates: [...] }
 * where each crate carries (name, storageName, newest_version,
 * description?, parsedAt, nodes, edges) — everything the landing page
 * needs to render its rails without a second R2 round-trip per crate.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { FreshnessRegistry } from '../src/lib/server/parsing/freshness';
import { LocalR2FreshnessBackend, WranglerR2FreshnessBackend } from './freshness-backends.ts';

const STATIC_R2_TARGET = (process.env.STATIC_R2_TARGET ?? 'local') as 'local' | 'remote';
const WRANGLER_PERSIST_TO = process.env.WRANGLER_PERSIST_TO ?? '.wrangler/state/v3';
const R2_BUCKET = process.env.R2_BUCKET ?? 'crate-graphs';
const DRY_RUN = process.env.DRY_RUN === '1';

if (STATIC_R2_TARGET !== 'local' && STATIC_R2_TARGET !== 'remote') {
	throw new Error(`STATIC_R2_TARGET must be local|remote, got "${STATIC_R2_TARGET}"`);
}

interface CatalogEntry {
	name: string;
	storageName: string;
	newest_version: string;
	parsedAt: string;
	nodes: number;
	edges: number;
	description?: string;
}

interface Catalog {
	schema_version: 1;
	generated_at: string;
	crates: CatalogEntry[];
}

function log(...args: unknown[]): void {
	if (process.env.QUIET !== '1') console.log(...args);
}

async function main() {
	const backend =
		STATIC_R2_TARGET === 'local'
			? new LocalR2FreshnessBackend({ bucket: R2_BUCKET, persistTo: WRANGLER_PERSIST_TO })
			: new WranglerR2FreshnessBackend({ bucket: R2_BUCKET, target: 'remote' });
	const registry = new FreshnessRegistry(backend);

	log(`[rebuild-catalog] reading freshness index from ${STATIC_R2_TARGET} R2`);
	const entries = await registry.listAll();
	log(`[rebuild-catalog] ${entries.length} crates in freshness index`);

	const crates: CatalogEntry[] = entries
		.map((e) => ({
			name: e.name,
			storageName: e.storageName ?? e.name,
			newest_version: e.version,
			parsedAt: e.parsedAt,
			nodes: e.nodes,
			edges: e.edges,
		}))
		// Stable order — alphabetical by name. Helps deterministic diffs
		// across catalog regenerations.
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

	const catalog: Catalog = {
		schema_version: 1,
		generated_at: new Date().toISOString(),
		crates,
	};

	if (DRY_RUN) {
		log(`[rebuild-catalog] DRY_RUN — would write ${crates.length} entries`);
		log(JSON.stringify(catalog, null, 2).slice(0, 500) + '...');
		return;
	}

	// Write via wrangler so the same upload path works for both local and
	// remote. (Local could go straight to miniflare SQLite for speed but
	// catalog rewrites are infrequent — wrangler's overhead is fine.)
	const tmpDir = mkdtempSync(join(tmpdir(), 'codeview-catalog-'));
	const file = join(tmpDir, 'catalog.json');
	try {
		writeFileSync(file, JSON.stringify(catalog, null, 2), 'utf-8');
		const args = [
			'run',
			'wrangler',
			'r2',
			'object',
			'put',
			`${R2_BUCKET}/rust/catalog.json`,
			'--file',
			file,
			'--content-type',
			'application/json; charset=utf-8',
			'--config',
			'./wrangler.toml',
			...(STATIC_R2_TARGET === 'local'
				? ['--local', '--persist-to', WRANGLER_PERSIST_TO]
				: ['--remote']),
		];
		execFileSync('bun', args, { stdio: 'inherit' });
		log(`[rebuild-catalog] wrote rust/catalog.json: ${crates.length} crates`);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
}

await main();
