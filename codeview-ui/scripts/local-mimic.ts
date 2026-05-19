/**
 * Local mimic of the parse.yml workflow.
 *
 * Runs the same two-stage flow GHA does, but locally and against local R2:
 *   1. freshness sweep → emits a matrix JSON to a temp file
 *   2. for each matrix entry, invokes parse-one.ts as a subprocess
 *      (matching how GHA runs each shard in isolation)
 *
 * Goals:
 *   - Exercise every code path the real workflow exercises, including
 *     subprocess boundaries and exit-code propagation.
 *   - Surface edge cases (404s from docs.rs, parser version mismatches,
 *     OOM on huge crates, normalisation bugs) without burning CI minutes.
 *   - Be fast enough to iterate on parse-one.ts changes — single-crate
 *     runs should complete in under a minute against local R2.
 *
 * Inputs (env or args):
 *   WATCHLIST       'top:N' | 'catalog' | path/to/file | 'inline'
 *                   default: 'inline' (which uses INLINE_CRATES below)
 *   INLINE_CRATES   comma-separated name[@version] when WATCHLIST=inline
 *                   default: a small representative set
 *   MAX_CRATES      cap on parse jobs in this run                default: 10
 *   FORCE           '1' to bypass freshness idempotency           default: 0
 *   STOP_ON_FAIL    '1' to halt the loop on first non-zero exit  default: 0
 *
 * Output:
 *   - Per-crate logs to stdout
 *   - Final summary table
 *   - Exit code: 0 if all succeeded, 1 if any matrix entry hit code != 0
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const WATCHLIST = process.env.WATCHLIST ?? 'inline';
const INLINE_CRATES =
	process.env.INLINE_CRATES ??
	// Representative starter set: small/medium/large + tricky names.
	'serde,tokio,anyhow,thiserror,clap';
const MAX_CRATES = Number(process.env.MAX_CRATES ?? '10');
const FORCE = process.env.FORCE === '1';
const STOP_ON_FAIL = process.env.STOP_ON_FAIL === '1';

const TMP = resolve(tmpdir(), `codeview-mimic-${Date.now()}`);
mkdirSync(TMP, { recursive: true });
const MATRIX_OUT = join(TMP, 'matrix.json');

function header(s: string) {
	const bar = '─'.repeat(Math.max(0, 70 - s.length - 4));
	console.log(`\n── ${s} ${bar}`);
}

function runStep(cmd: string, args: string[], env: Record<string, string>): { code: number; ms: number } {
	const started = Date.now();
	const r = spawnSync(cmd, args, {
		stdio: 'inherit',
		env: { ...process.env, ...env },
	});
	return { code: r.status ?? -1, ms: Date.now() - started };
}

// ─── Stage 1: freshness sweep ────────────────────────────────────────

header('Stage 1: freshness sweep');

interface MatrixEntry {
	name: string;
	version: string;
	reason: string;
}

let matrix: MatrixEntry[];

if (WATCHLIST === 'inline') {
	// Inline mode: parse INLINE_CRATES directly, fetching crates.io for the
	// latest version of each one. This is what you want for "I just changed
	// the parser; smoke-test it on these 5 crates" iteration.
	console.log(`[mimic] inline mode: ${INLINE_CRATES}`);
	const names = INLINE_CRATES.split(',')
		.map((s) => s.trim())
		.filter(Boolean);

	matrix = [];
	for (const entry of names) {
		const at = entry.lastIndexOf('@');
		if (at > 0) {
			matrix.push({
				name: entry.slice(0, at),
				version: entry.slice(at + 1),
				reason: 'inline pin',
			});
			continue;
		}
		try {
			const r = execFileSync(
				'curl',
				['-sf', '-H', 'User-Agent: codeview-mimic', `https://crates.io/api/v1/crates/${entry}`],
				{ encoding: 'utf-8' },
			);
			const parsed = JSON.parse(r) as { crate: { newest_version: string } };
			matrix.push({ name: entry, version: parsed.crate.newest_version, reason: 'inline (newest)' });
		} catch (err) {
			console.warn(`[mimic] crates.io lookup failed for ${entry}: ${String(err)}`);
		}
	}
} else {
	// Real sweep — go through freshness-sweep.ts so we exercise that script too.
	console.log(`[mimic] sweep mode: WATCHLIST=${WATCHLIST}`);
	const env: Record<string, string> = {
		STATIC_R2_TARGET: 'local',
		WATCHLIST,
		MAX_CRATES: String(MAX_CRATES),
		MATRIX_OUT,
	};
	const sweep = runStep('bun', ['scripts/freshness-sweep.ts'], env);
	if (sweep.code !== 0) {
		console.error(`[mimic] freshness sweep failed (exit ${sweep.code})`);
		process.exit(1);
	}
	if (!existsSync(MATRIX_OUT)) {
		console.error(`[mimic] sweep didn't produce matrix output`);
		process.exit(1);
	}
	const parsed = JSON.parse(readFileSync(MATRIX_OUT, 'utf-8')) as { include?: MatrixEntry[] };
	matrix = parsed.include ?? [];
}

if (matrix.length === 0) {
	console.log('[mimic] nothing to parse — exiting');
	rmSync(TMP, { recursive: true, force: true });
	process.exit(0);
}

matrix = matrix.slice(0, MAX_CRATES);
console.log(`[mimic] matrix size: ${matrix.length}`);
for (const m of matrix) console.log(`  - ${m.name}@${m.version}  (${m.reason})`);

// ─── Stage 2: parse each matrix entry ────────────────────────────────

header('Stage 2: parse');

interface ResultRow {
	name: string;
	version: string;
	code: number;
	classification: 'ok' | 'transient' | 'permanent' | 'internal';
	ms: number;
}

const results: ResultRow[] = [];

for (const entry of matrix) {
	header(`parsing ${entry.name}@${entry.version}`);
	const env: Record<string, string> = {
		NAME: entry.name,
		VERSION: entry.version,
		STATIC_R2_TARGET: 'local',
		FORCE: FORCE ? '1' : '0',
	};
	const step = runStep('bun', ['scripts/parse-one.ts'], env);
	const classification: ResultRow['classification'] =
		step.code === 0 ? 'ok' : step.code === 64 ? 'transient' : step.code === 65 ? 'permanent' : 'internal';
	results.push({
		name: entry.name,
		version: entry.version,
		code: step.code,
		classification,
		ms: step.ms,
	});
	console.log(`[mimic] ${entry.name}@${entry.version} → ${classification} (exit ${step.code}, ${step.ms}ms)`);
	if (STOP_ON_FAIL && step.code !== 0) {
		console.error(`[mimic] STOP_ON_FAIL set — halting after first failure`);
		break;
	}
}

// ─── Summary ─────────────────────────────────────────────────────────

header('Summary');
const okCount = results.filter((r) => r.classification === 'ok').length;
const transientCount = results.filter((r) => r.classification === 'transient').length;
const permanentCount = results.filter((r) => r.classification === 'permanent').length;
const internalCount = results.filter((r) => r.classification === 'internal').length;

console.log(`ran=${results.length}  ok=${okCount}  transient=${transientCount}  permanent=${permanentCount}  internal=${internalCount}`);

const colWidth = Math.max(...results.map((r) => r.name.length + r.version.length + 1), 20);
for (const r of results) {
	const label = `${r.name}@${r.version}`.padEnd(colWidth);
	const code =
		r.classification === 'ok'
			? 'OK         '
			: r.classification === 'transient'
				? 'TRANSIENT  '
				: r.classification === 'permanent'
					? 'PERMANENT  '
					: 'INTERNAL   ';
	console.log(`  ${code}${label}  ${r.ms}ms  (exit ${r.code})`);
}

rmSync(TMP, { recursive: true, force: true });

const anyFailure = results.some((r) => r.classification !== 'ok');
process.exit(anyFailure ? 1 : 0);
