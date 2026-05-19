/**
 * Parse one crate, end-to-end. The unit of work the parse.yml matrix
 * invokes, and the unit the local-mimic exercises.
 *
 * Pipeline:
 *   1. Resolve (name, version) input
 *   2. Idempotency check — if freshness matches current parser+schema and
 *      `FORCE=0`, exit 0 without touching R2.
 *   3. Fetch rustdoc JSON from docs.rs.
 *   4. Run the Rust parser (codeview-rustdoc).
 *   5. Hash the graph. If the hash matches the previous freshness entry
 *      AND only the parser revision changed, still skip the upload
 *      (parser produced byte-identical output → R2 already correct).
 *   6. Build static artifacts.
 *   7. Upload to R2.
 *   8. Record freshness entry.
 *
 * Exit codes (caller can branch on these):
 *   0   success — parsed + uploaded, OR idempotent skip
 *   64  transient (network, docs.rs rate limit, R2 5xx) — caller retries
 *   65  permanent (parser rejected the JSON, unsupported schema)        →
 *       don't retry until parser revision changes
 *   70  internal error (bug) — page a human; CI marks the job failed
 *
 * Inputs (env or CLI args via --key=value):
 *   NAME            crate name (required)
 *   VERSION         crate version (required)
 *   STATIC_R2_TARGET 'local' | 'remote'  default: local
 *   PARSER_REVISION git SHA              default: `git rev-parse HEAD`
 *   FORCE           '1' to skip idempotency check
 *   DOCSRS_TARGET   override docs.rs target triple
 *   WRANGLER_PERSIST_TO  default: .wrangler/state/v3
 *   R2_BUCKET       default: crate-graphs
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
	buildStaticArtifacts,
	downloadDocsRsRustdocJson,
	hyphenateCrateName,
	normalizeCrateName,
	runRustParser,
	seedLocalR2Artifacts,
	uploadArtifactWithWrangler,
	type CrateGraph,
} from './static-artifacts.ts';
import { FreshnessRegistry } from '../src/lib/server/parsing/freshness';
import { LocalR2FreshnessBackend, WranglerR2FreshnessBackend } from './freshness-backends.ts';
import { SCHEMA_VERSION } from '../src/lib/schema';

const EXIT_SUCCESS = 0;
const EXIT_TRANSIENT = 64;
const EXIT_PERMANENT = 65;
const EXIT_INTERNAL = 70;

function parseCliArgs(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const arg of process.argv.slice(2)) {
		const m = arg.match(/^--([^=]+)=(.*)$/);
		if (m) out[m[1]] = m[2];
	}
	return out;
}

function fail(code: number, reason: 'transient' | 'permanent' | 'internal', message: string): never {
	console.error(`[parse-one] ${reason}: ${message}`);
	process.exit(code);
}

function gitHead(): string {
	if (process.env.PARSER_REVISION) return process.env.PARSER_REVISION;
	try {
		return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
	} catch {
		return 'unknown';
	}
}

/**
 * Recursive JSON canonicaliser. Produces byte-stable output regardless
 * of object-key insertion order — necessary because the Rust parser
 * emits `bound_links` (and similar `Record<string, _>` fields) from a
 * HashMap, whose iteration order varies across runs. Plain JSON.stringify
 * would hash differently each time.
 *
 * Arrays are preserved as-is (we sort arrays at the level of the caller
 * — top-level nodes/edges — where the canonical order is meaningful).
 */
function canonicalize(value: unknown): string {
	if (value === null) return 'null';
	if (typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

/**
 * Deterministic graph hash. Sorts the top-level nodes/edges arrays by a
 * stable key, then deep-canonicalises before hashing so insertion-order
 * differences inside individual objects (e.g. `bound_links`) don't
 * change the digest.
 */
function hashGraph(graph: CrateGraph): string {
	const stable = {
		id: graph.id,
		name: graph.name,
		version: graph.version,
		nodes: [...graph.nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
		edges: [...graph.edges].sort((a, b) => {
			const ak = `${a.from}|${a.to}|${a.kind}`;
			const bk = `${b.from}|${b.to}|${b.kind}`;
			return ak < bk ? -1 : ak > bk ? 1 : 0;
		}),
	};
	return createHash('sha256').update(canonicalize(stable)).digest('hex');
}

/**
 * Hash of the rustdoc JSON bytes we received from docs.rs. Independent
 * of parser determinism — same input file = same digest, always. Stored
 * alongside graphHash so a future sweep can short-circuit at the
 * download step ("input hasn't changed, skip parsing entirely").
 */
function hashRustdocJson(path: string): string {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function main() {
	const args = parseCliArgs();
	const NAME = args.name ?? process.env.NAME ?? '';
	const VERSION = args.version ?? process.env.VERSION ?? '';
	const STATIC_R2_TARGET = (args.target ?? process.env.STATIC_R2_TARGET ?? 'local') as
		| 'local'
		| 'remote';
	const FORCE = (args.force ?? process.env.FORCE ?? '0') === '1';
	const DOCSRS_TARGET = args.docsrsTarget ?? process.env.DOCSRS_TARGET;
	const WRANGLER_PERSIST_TO = process.env.WRANGLER_PERSIST_TO ?? '.wrangler/state/v3';
	const R2_BUCKET = process.env.R2_BUCKET ?? 'crate-graphs';
	const UPLOAD_CONCURRENCY = Number(process.env.UPLOAD_CONCURRENCY ?? '16');
	const LOCAL_R2_SEEDER = process.env.LOCAL_R2_SEEDER ?? 'direct';
	const WORK_DIR = resolve('.codeview-static', 'parse-one');

	if (!NAME) fail(EXIT_INTERNAL, 'internal', 'NAME is required (env or --name=)');
	if (!VERSION) fail(EXIT_INTERNAL, 'internal', 'VERSION is required (env or --version=)');
	if (STATIC_R2_TARGET !== 'local' && STATIC_R2_TARGET !== 'remote') {
		fail(EXIT_INTERNAL, 'internal', `STATIC_R2_TARGET must be local|remote, got "${STATIC_R2_TARGET}"`);
	}

	const parserRevision = gitHead();
	const storageName = hyphenateCrateName(NAME);
	const crateName = normalizeCrateName(NAME);

	console.log(`[parse-one] ${NAME}@${VERSION} → ${STATIC_R2_TARGET} R2`);
	console.log(`[parse-one] parser=${parserRevision.slice(0, 8)} schema=v${SCHEMA_VERSION}`);

	// ─── Backend + registry setup ─────────────────────────────────────
	const backend =
		STATIC_R2_TARGET === 'local'
			? new LocalR2FreshnessBackend({ bucket: R2_BUCKET, persistTo: WRANGLER_PERSIST_TO })
			: new WranglerR2FreshnessBackend({ bucket: R2_BUCKET, target: 'remote' });
	const registry = new FreshnessRegistry(backend);

	// ─── Step 1: idempotency check ────────────────────────────────────
	if (!FORCE) {
		const reason = await registry.check(NAME, VERSION, parserRevision, SCHEMA_VERSION);
		if (!reason.stale) {
			console.log(`[parse-one] fresh, no work needed (use FORCE=1 to override)`);
			process.exit(EXIT_SUCCESS);
		}
		console.log(`[parse-one] stale: ${describeStaleness(reason)}`);
	} else {
		console.log(`[parse-one] FORCE=1: skipping idempotency check`);
	}

	// ─── Step 2: fetch rustdoc JSON from docs.rs ──────────────────────
	mkdirSync(WORK_DIR, { recursive: true });
	const jsonPath = join(WORK_DIR, 'rustdoc', `${storageName}-${VERSION}.json`);
	let download: { compressedBytes: number; jsonBytes: number };
	try {
		download = await downloadDocsRsRustdocJson({
			crateName: NAME,
			version: VERSION,
			target: DOCSRS_TARGET,
			outPath: jsonPath,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// 4xx from docs.rs → permanent (this version's docs build failed); 5xx/network → transient.
		if (/\b4\d\d\b/.test(msg)) fail(EXIT_PERMANENT, 'permanent', `docs.rs: ${msg}`);
		fail(EXIT_TRANSIENT, 'transient', `docs.rs fetch failed: ${msg}`);
	}
	console.log(
		`[parse-one] docs.rs JSON: ${(download.compressedBytes / 1024 / 1024).toFixed(1)} MB gz, ${(download.jsonBytes / 1024 / 1024).toFixed(1)} MB raw`,
	);

	// Hash the input bytes — recorded in the freshness entry for
	// diagnostics ("did docs.rs serve different bytes for this version
	// over time?"). Not used as a short-circuit because all the cases
	// where rustdocHash could match are already covered by the earlier
	// registry.check() — see commit message for the dead-code analysis.
	const rustdocHash = hashRustdocJson(jsonPath);
	console.log(`[parse-one] rustdoc input hash: ${rustdocHash.slice(0, 12)}`);

	// ─── Step 3: run the Rust parser ──────────────────────────────────
	const graphPath = join(WORK_DIR, 'graphs', `${crateName}-${VERSION}.json`);
	let graph: CrateGraph;
	try {
		graph = runRustParser({
			jsonPath,
			crateName,
			version: VERSION,
			outPath: graphPath,
			callMode: process.env.CALL_MODE === 'ambiguous' ? 'ambiguous' : 'strict',
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// Parser rejection of valid JSON = permanent. Parser internal crash = retry once via internal.
		if (/unsupported rustdoc|format_version|unknown variant/i.test(msg)) {
			fail(EXIT_PERMANENT, 'permanent', `parser rejected JSON: ${msg}`);
		}
		fail(EXIT_INTERNAL, 'internal', `parser failed: ${msg}`);
	}
	const graphHash = hashGraph(graph);
	console.log(
		`[parse-one] graph: nodes=${graph.nodes.length} edges=${graph.edges.length} hash=${graphHash.slice(0, 12)}`,
	);

	// ─── Step 4: idempotent skip if hash matches existing ─────────────
	if (!FORCE) {
		const existing = await registry.latestParsed(NAME);
		if (existing && existing.graphHash === graphHash && existing.version === VERSION) {
			console.log(`[parse-one] graph hash unchanged — refreshing registry only`);
			await registry.record({
				...existing,
				parsedAt: new Date().toISOString(),
				parserRevision,
				schemaVersion: SCHEMA_VERSION,
			});
			process.exit(EXIT_SUCCESS);
		}
	}

	// ─── Step 5: build static artifacts ───────────────────────────────
	const artifactDir = join(WORK_DIR, 'artifacts', storageName, VERSION);
	rmSync(artifactDir, { recursive: true, force: true });
	const artifacts = await buildStaticArtifacts({
		crateName,
		storageName,
		version: VERSION,
		graph,
		outDir: artifactDir,
		nodeDetailConcurrency: UPLOAD_CONCURRENCY,
		aliases: ['latest'],
	});
	console.log(`[parse-one] artifacts: ${artifacts.length}`);

	// ─── Step 6: upload to R2 ─────────────────────────────────────────
	try {
		if (STATIC_R2_TARGET === 'local' && LOCAL_R2_SEEDER === 'direct') {
			seedLocalR2Artifacts(artifacts, {
				bucket: R2_BUCKET,
				persistTo: WRANGLER_PERSIST_TO,
				deletePrefixes: [`rust/${storageName}/${VERSION}/`],
			});
		} else {
			for (const artifact of artifacts) {
				uploadArtifactWithWrangler(artifact, {
					bucket: R2_BUCKET,
					target: STATIC_R2_TARGET,
					persistTo: WRANGLER_PERSIST_TO,
				});
			}
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		fail(EXIT_TRANSIENT, 'transient', `R2 upload failed: ${msg}`);
	}

	// ─── Step 7: record freshness ─────────────────────────────────────
	try {
		await registry.record({
			name: NAME,
			storageName,
			version: VERSION,
			parsedAt: new Date().toISOString(),
			source: 'docs.rs',
			parserRevision,
			schemaVersion: SCHEMA_VERSION,
			graphHash,
			rustdocHash,
			nodes: graph.nodes.length,
			edges: graph.edges.length,
		});
	} catch (err) {
		// Don't fail the whole run if freshness write fails — artifacts are
		// already uploaded. Next sweep will re-parse but that's safe.
		console.warn(
			`[parse-one] WARNING: freshness write failed (will re-parse next sweep): ${String(err)}`,
		);
	}

	console.log(`[parse-one] OK ${NAME}@${VERSION}`);
	process.exit(EXIT_SUCCESS);
}

function describeStaleness(reason: { reason: string }): string {
	const r = reason as { reason: string; observed?: string; recorded?: string | number; current?: string | number };
	switch (r.reason) {
		case 'never_parsed':
			return 'never parsed';
		case 'newer_version':
			return `crates.io ${r.observed} vs recorded ${r.recorded}`;
		case 'parser_revision_changed':
			return `parser ${String(r.recorded).slice(0, 8)} → ${String(r.current).slice(0, 8)}`;
		case 'schema_version_changed':
			return `schema v${r.recorded} → v${r.current}`;
		default:
			return r.reason;
	}
}

try {
	await main();
} catch (err) {
	const msg = err instanceof Error ? err.stack ?? err.message : String(err);
	console.error(`[parse-one] uncaught: ${msg}`);
	process.exit(EXIT_INTERNAL);
}
