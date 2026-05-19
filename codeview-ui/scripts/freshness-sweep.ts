/**
 * Freshness sweep — the cron's "what should I parse?" function.
 *
 * Inputs (env):
 *   STATIC_R2_TARGET     'local' | 'remote'                 default: local
 *   WATCHLIST            'catalog' | 'top:N' | path/to/file default: catalog
 *   MAX_CRATES           cap on emitted matrix size         default: 50
 *   PARSER_REVISION      git SHA of the parser              default: HEAD
 *   FORCE                comma-separated names to force-include
 *   WRANGLER_PERSIST_TO  for STATIC_R2_TARGET=local         default: .wrangler/state/v3
 *
 * Outputs:
 *   - stdout: human-readable summary (suppressed if QUIET=1)
 *   - $GITHUB_OUTPUT (if set): `matrix=<json>` for GHA matrix dispatch
 *   - $MATRIX_OUT (if set): writes matrix JSON to that path
 *
 * Matrix entry shape:
 *   { name: string, version: string, reason: string }
 *
 * The sweep is intentionally pure-ish: reads R2 + crates.io, writes no
 * state. The parse jobs themselves call `FreshnessRegistry.record(...)`
 * after a successful publish. That keeps "what's stale" and "did we parse
 * it" in separate scripts — easier to test, easier to dry-run.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	FreshnessRegistry,
	type FreshnessBackend,
	type StalenessReason,
} from '../src/lib/server/parsing/freshness';
import { LocalR2FreshnessBackend, WranglerR2FreshnessBackend } from './freshness-backends.ts';
import { SCHEMA_VERSION } from '../src/lib/schema';

const STATIC_R2_TARGET = (process.env.STATIC_R2_TARGET ?? 'local') as 'local' | 'remote';
const WATCHLIST = process.env.WATCHLIST ?? 'catalog';
const MAX_CRATES = Number(process.env.MAX_CRATES ?? '50');
const FORCE_RAW = process.env.FORCE ?? '';
const FORCE_SET = new Set(
	FORCE_RAW.split(',')
		.map((s) => s.trim())
		.filter(Boolean),
);
const WRANGLER_PERSIST_TO = process.env.WRANGLER_PERSIST_TO ?? '.wrangler/state/v3';
const R2_BUCKET = process.env.R2_BUCKET ?? 'crate-graphs';
const QUIET = process.env.QUIET === '1';

if (STATIC_R2_TARGET !== 'local' && STATIC_R2_TARGET !== 'remote') {
	throw new Error('STATIC_R2_TARGET must be "local" or "remote"');
}

function gitHead(): string {
	if (process.env.PARSER_REVISION) return process.env.PARSER_REVISION;
	try {
		return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
	} catch {
		return 'unknown';
	}
}

function log(...args: unknown[]): void {
	if (!QUIET) console.log(...args);
}

interface CratesIoCrate {
	name: string;
	newest_version: string;
	description?: string;
	downloads?: number;
}

async function fetchCratesIoNewest(name: string): Promise<CratesIoCrate | null> {
	const url = `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`;
	try {
		const r = await fetch(url, {
			headers: { 'User-Agent': 'codeview-freshness-sweep (https://codeview.dev)' },
		});
		if (!r.ok) {
			log(`[freshness] crates.io ${name} → ${r.status}`);
			return null;
		}
		const body = (await r.json()) as { crate: CratesIoCrate };
		return body.crate;
	} catch (err) {
		log(`[freshness] crates.io ${name} → fetch error: ${String(err)}`);
		return null;
	}
}

async function fetchCratesIoTop(n: number): Promise<CratesIoCrate[]> {
	const url = new URL('https://crates.io/api/v1/crates');
	url.searchParams.set('page', '1');
	url.searchParams.set('per_page', String(Math.min(n, 100)));
	url.searchParams.set('sort', 'downloads');
	const r = await fetch(url, {
		headers: { 'User-Agent': 'codeview-freshness-sweep (https://codeview.dev)' },
	});
	if (!r.ok) throw new Error(`crates.io top fetch failed: ${r.status}`);
	const body = (await r.json()) as { crates: CratesIoCrate[] };
	return body.crates.slice(0, n);
}

/**
 * Read `rust/catalog.json` from R2 via wrangler. Falls back to empty list
 * if the catalog doesn't exist yet (cold-start case — the watchlist
 * source picks up the slack).
 *
 * One call per sweep regardless of crate count, so the wrangler-CLI cost
 * is fine here. Local-only fast paths would need miniflare-SQLite direct
 * reads and the speedup isn't worth the duplication.
 */
async function readCatalog(): Promise<Array<{ name: string; newest_version?: string }>> {
	try {
		const json = execFileSync(
			'bun',
			[
				'run',
				'wrangler',
				'r2',
				'object',
				'get',
				`${R2_BUCKET}/rust/catalog.json`,
				'--pipe',
				'--config',
				'./wrangler.toml',
				...(STATIC_R2_TARGET === 'local'
					? ['--local', '--persist-to', WRANGLER_PERSIST_TO]
					: ['--remote']),
			],
			{ encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
		);
		const parsed = JSON.parse(json) as { crates?: Array<{ name: string; newest_version?: string }> };
		return parsed.crates ?? [];
	} catch {
		log('[freshness] no catalog found; using watchlist source instead');
		return [];
	}
}

async function watchlistCrates(): Promise<Array<{ name: string }>> {
	if (WATCHLIST === 'catalog') return await readCatalog();
	if (WATCHLIST.startsWith('top:')) {
		const n = Number(WATCHLIST.slice('top:'.length));
		return await fetchCratesIoTop(Number.isFinite(n) ? n : 30);
	}
	if (existsSync(WATCHLIST)) {
		return readFileSync(WATCHLIST, 'utf-8')
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter((l) => l && !l.startsWith('#'))
			.map((name) => ({ name }));
	}
	throw new Error(`WATCHLIST not recognised: "${WATCHLIST}" (use 'catalog', 'top:N', or a file path)`);
}

function describe(reason: StalenessReason): string {
	if (!reason.stale) return 'fresh';
	switch (reason.reason) {
		case 'never_parsed':
			return 'never parsed';
		case 'newer_version':
			return `crates.io has ${reason.observed} (we have ${reason.recorded})`;
		case 'parser_revision_changed':
			return `parser ${reason.recorded.slice(0, 8)} → ${reason.current.slice(0, 8)}`;
		case 'schema_version_changed':
			return `schema v${reason.recorded} → v${reason.current}`;
	}
}

async function main() {
	const parserRevision = gitHead();
	log(`[freshness] target=${STATIC_R2_TARGET} parser=${parserRevision.slice(0, 8)} schema=v${SCHEMA_VERSION}`);

	const backend: FreshnessBackend =
		STATIC_R2_TARGET === 'local'
			? new LocalR2FreshnessBackend({ bucket: R2_BUCKET, persistTo: WRANGLER_PERSIST_TO })
			: new WranglerR2FreshnessBackend({ bucket: R2_BUCKET, target: 'remote' });
	const registry = new FreshnessRegistry(backend);

	const watchlist = await watchlistCrates();
	log(`[freshness] watchlist source=${WATCHLIST} size=${watchlist.length}`);

	const matrix: Array<{ name: string; version: string; reason: string }> = [];
	const skipped: Array<{ name: string; reason: string }> = [];

	for (const c of watchlist) {
		if (matrix.length >= MAX_CRATES) break;

		const latest = await fetchCratesIoNewest(c.name);
		if (!latest) {
			skipped.push({ name: c.name, reason: 'crates.io lookup failed' });
			continue;
		}

		const reason = await registry.check(c.name, latest.newest_version, parserRevision, SCHEMA_VERSION);

		if (FORCE_SET.has(c.name)) {
			matrix.push({
				name: c.name,
				version: latest.newest_version,
				reason: `forced (otherwise: ${describe(reason)})`,
			});
			continue;
		}

		if (!reason.stale) {
			skipped.push({ name: c.name, reason: 'fresh' });
			continue;
		}

		matrix.push({
			name: c.name,
			version: latest.newest_version,
			reason: describe(reason),
		});
	}

	log('');
	log(`[freshness] ${matrix.length} stale, ${skipped.length} fresh/skipped`);
	for (const m of matrix) log(`  STALE  ${m.name}@${m.version}  (${m.reason})`);
	if (!QUIET && skipped.length) {
		for (const s of skipped.slice(0, 10)) log(`  skip   ${s.name}  (${s.reason})`);
		if (skipped.length > 10) log(`  ... ${skipped.length - 10} more`);
	}

	const matrixJson = JSON.stringify({ include: matrix });

	if (process.env.GITHUB_OUTPUT) {
		appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${matrixJson}\n`);
		appendFileSync(process.env.GITHUB_OUTPUT, `count=${matrix.length}\n`);
	}
	if (process.env.MATRIX_OUT) {
		writeFileSync(resolve(process.env.MATRIX_OUT), matrixJson + '\n', 'utf-8');
	}

	if (!process.env.GITHUB_OUTPUT && !process.env.MATRIX_OUT && QUIET) {
		// CLI invocation with QUIET=1 expects machine-readable output on stdout.
		process.stdout.write(matrixJson + '\n');
	}
}

await main();
