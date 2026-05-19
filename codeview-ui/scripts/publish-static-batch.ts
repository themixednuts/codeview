/**
 * Publish a local static corpus to R2:
 *   - rustdoc JSON crates from the active Rust toolchain (std/core/alloc/proc_macro/test)
 *   - top crates.io crates by all-time downloads using docs.rs rustdoc JSON artifacts
 *
 * Defaults:
 *   TOP_CRATE_COUNT=30
 *   R2_BUCKET=crate-graphs
 *   STATIC_R2_TARGET=local
 *   WRANGLER_PERSIST_TO=.wrangler/state/v3
 *   RUST_TOOLCHAIN=nightly
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { STD_JSON_CRATES } from '../src/lib/std';
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

type CratesIoCrate = {
	name: string;
	newest_version: string;
	description?: string;
	downloads: number;
};

type PublishResult = {
	name: string;
	storageName: string;
	version: string;
	source: 'std' | 'crates.io';
	nodes?: number;
	edges?: number;
	artifacts?: number;
	description?: string;
	status: 'published' | 'failed';
	error?: string;
};

const TOP_CRATE_COUNT = Number(process.env.TOP_CRATE_COUNT || '30');
const INCLUDE_TOP = process.env.INCLUDE_TOP !== '0';
const INCLUDE_STD = process.env.INCLUDE_STD !== '0';
const CRATES = process.env.CRATES ?? '';
const DOCSRS_TARGET = process.env.DOCSRS_TARGET;
const R2_BUCKET = process.env.R2_BUCKET || 'crate-graphs';
const STATIC_R2_TARGET = process.env.STATIC_R2_TARGET || 'local';
const RUST_TOOLCHAIN = process.env.RUST_TOOLCHAIN || 'nightly';
// rustup only ships `rust-docs-json` on nightly; stable/beta channels can't be
// extracted directly. We seed each listed toolchain, and for nightly we publish
// under every channel alias so /alloc/stable resolves until per-channel artifacts
// land. Override STD_TOOLCHAINS to also seed nightly-{date} pins for specific
// release dates.
const STD_TOOLCHAINS = (process.env.STD_TOOLCHAINS ?? 'nightly')
	.split(',')
	.map((entry) => entry.trim())
	.filter(Boolean);

function stdAliasesForToolchain(toolchain: string): string[] {
	if (toolchain === 'nightly') return ['nightly', 'stable', 'beta', 'latest'];
	return [toolchain];
}
const WRANGLER_PERSIST_TO = process.env.WRANGLER_PERSIST_TO || '.wrangler/state/v3';
const UPLOAD_CONCURRENCY = Number(process.env.UPLOAD_CONCURRENCY || '16');
const LOCAL_R2_SEEDER = process.env.LOCAL_R2_SEEDER || 'direct';
const CALL_MODE = process.env.CALL_MODE === 'ambiguous' ? 'ambiguous' : 'strict';
const WORK_DIR = resolve('.codeview-static', 'batch');
const REPORT_PATH = join(WORK_DIR, 'publish-report.json');
const CATALOG_PATH = join(WORK_DIR, 'catalog.json');

if (STATIC_R2_TARGET !== 'local' && STATIC_R2_TARGET !== 'remote') {
	throw new Error('STATIC_R2_TARGET must be "local" or "remote"');
}

function rustcRelease(toolchain: string): string {
	const verbose = execFileSync('rustc', [`+${toolchain}`, '--version', '--verbose'], {
		encoding: 'utf-8',
	});
	const release = verbose
		.split(/\r?\n/)
		.find((line) => line.startsWith('release: '))
		?.slice('release: '.length)
		.trim();
	if (release) return release;
	const version = execFileSync('rustc', [`+${toolchain}`, '--version'], {
		encoding: 'utf-8',
	}).trim();
	return version.split(/\s+/)[1] ?? version;
}

async function topCrates(): Promise<CratesIoCrate[]> {
	const url = new URL('https://crates.io/api/v1/crates');
	url.searchParams.set('page', '1');
	url.searchParams.set('per_page', String(TOP_CRATE_COUNT));
	url.searchParams.set('sort', 'downloads');
	const response = await fetch(url, {
		headers: {
			'User-Agent': 'codeview-static-local-publisher (local QA)',
		},
	});
	if (!response.ok) {
		throw new Error(`crates.io request failed: ${response.status} ${response.statusText}`);
	}
	const data = (await response.json()) as { crates: CratesIoCrate[] };
	return data.crates.slice(0, TOP_CRATE_COUNT);
}

async function publishGraph(
	graph: CrateGraph,
	options: {
		crateName: string;
		storageName: string;
		version: string;
		source: PublishResult['source'];
		aliases?: string[];
		description?: string;
	},
): Promise<PublishResult> {
	const outDir = join(WORK_DIR, 'artifacts', options.storageName, options.version);
	rmSync(outDir, { recursive: true, force: true });
	const artifacts = await buildStaticArtifacts({
		crateName: options.crateName,
		storageName: options.storageName,
		version: options.version,
		graph,
		outDir,
		nodeDetailConcurrency: UPLOAD_CONCURRENCY,
		aliases: options.aliases ?? ['latest'],
	});
	if (STATIC_R2_TARGET === 'local' && LOCAL_R2_SEEDER === 'direct') {
		seedLocalR2Artifacts(artifacts, {
			bucket: R2_BUCKET,
			persistTo: WRANGLER_PERSIST_TO,
			deletePrefixes: [`rust/${options.storageName}/${options.version}/`],
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
	return {
		name: options.crateName,
		storageName: options.storageName,
		version: options.version,
		source: options.source,
		nodes: graph.nodes.length,
		edges: graph.edges.length,
		artifacts: artifacts.length,
		description: options.description,
		status: 'published',
	};
}

function selectedCrates(): CratesIoCrate[] | null {
	const entries = CRATES.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (entries.length === 0) return null;
	return entries.map((entry) => {
		const at = entry.lastIndexOf('@');
		if (at <= 0 || at === entry.length - 1) {
			throw new Error(`CRATES entries must be name@version, got ${entry}`);
		}
		return {
			name: entry.slice(0, at),
			newest_version: entry.slice(at + 1),
			downloads: 0,
		};
	});
}

async function publishStdCratesForToolchain(
	results: PublishResult[],
	toolchain: string,
): Promise<void> {
	let release: string;
	let sysroot: string;
	try {
		release = rustcRelease(toolchain);
		sysroot = execFileSync('rustc', [`+${toolchain}`, '--print', 'sysroot'], {
			encoding: 'utf-8',
		}).trim();
	} catch (err) {
		console.warn(
			`Skipping std toolchain "${toolchain}": ${err instanceof Error ? err.message : String(err)}`,
		);
		return;
	}
	const jsonDir = join(sysroot, 'share', 'doc', 'rust', 'json');
	if (!existsSync(jsonDir)) {
		console.warn(
			`Skipping std toolchain "${toolchain}": rustdoc JSON not found at ${jsonDir} ` +
				`(run \`rustup component add rust-docs-json --toolchain ${toolchain}\`)`,
		);
		return;
	}

	console.log(`\n=== std crates for "${toolchain}" (${release}) ===`);
	console.log(`std rustdoc JSON: ${jsonDir}`);

	for (const crateName of STD_JSON_CRATES) {
		const storageName = hyphenateCrateName(crateName);
		const jsonPath = join(jsonDir, `${crateName}.json`);
		if (!existsSync(jsonPath)) {
			results.push({
				name: crateName,
				storageName,
				version: release,
				source: 'std',
				status: 'failed',
				error: `${basename(jsonPath)} not found`,
			});
			continue;
		}
		try {
			console.log(`\n[std/${toolchain}] ${crateName}@${release}`);
			const graphPath = join(
				WORK_DIR,
				'graphs',
				'std',
				`${crateName}-${toolchain}-${release}.json`,
			);
			const graph = runRustParser({
				jsonPath,
				crateName,
				version: release,
				outPath: graphPath,
				callMode: CALL_MODE,
			});
			results.push(
				await publishGraph(graph, {
					crateName,
					storageName,
					version: release,
					source: 'std',
					aliases: stdAliasesForToolchain(toolchain),
				}),
			);
		} catch (err) {
			results.push({
				name: crateName,
				storageName: crateName,
				version: release,
				source: 'std',
				status: 'failed',
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}

async function publishStdCrates(results: PublishResult[]): Promise<void> {
	for (const toolchain of STD_TOOLCHAINS) {
		await publishStdCratesForToolchain(results, toolchain);
	}
}

async function publishTopCrates(results: PublishResult[]): Promise<void> {
	const crates = selectedCrates() ?? (await topCrates());
	console.log(`fetching ${crates.length} crate rustdoc JSON artifact(s) from docs.rs...`);

	for (const krate of crates) {
		const storageName = hyphenateCrateName(krate.name);
		const crateName = normalizeCrateName(krate.name);

		try {
			console.log(`\n[crate] ${krate.name}@${krate.newest_version}`);
			const jsonPath = join(
				WORK_DIR,
				'rustdoc',
				'crates.io',
				`${storageName}-${krate.newest_version}.json`,
			);
			const download = await downloadDocsRsRustdocJson({
				crateName: krate.name,
				version: krate.newest_version,
				target: DOCSRS_TARGET,
				outPath: jsonPath,
			});
			console.log(
				`docs.rs JSON: ${(download.compressedBytes / 1024 / 1024).toFixed(1)} MB compressed, ${(download.jsonBytes / 1024 / 1024).toFixed(1)} MB json`,
			);
			const graphPath = join(
				WORK_DIR,
				'graphs',
				'crates.io',
				`${crateName}-${krate.newest_version}.json`,
			);
			const graph = runRustParser({
				jsonPath,
				crateName,
				version: krate.newest_version,
				outPath: graphPath,
				callMode: CALL_MODE,
			});
			results.push(
				await publishGraph(graph, {
					crateName,
					storageName,
					version: krate.newest_version,
					source: 'crates.io',
					aliases: ['latest'],
					description: krate.description,
				}),
			);
		} catch (err) {
			results.push({
				name: crateName,
				storageName,
				version: krate.newest_version,
				source: 'crates.io',
				status: 'failed',
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}

function publishCatalog(results: PublishResult[], generatedAt: string): void {
	const catalog = {
		schema_version: 1,
		generatedAt,
		crates: results
			.filter((result) => result.status === 'published')
			.map((result) => ({
				name: result.name,
				storageName: result.storageName,
				version: result.version,
				source: result.source,
				description: result.description,
				nodeCount: result.nodes,
				edgeCount: result.edges,
			})),
	};
	writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2), 'utf-8');
	const artifact = { key: 'rust/catalog.json', path: CATALOG_PATH };
	if (STATIC_R2_TARGET === 'local' && LOCAL_R2_SEEDER === 'direct') {
		seedLocalR2Artifacts([artifact], {
			bucket: R2_BUCKET,
			persistTo: WRANGLER_PERSIST_TO,
		});
	} else {
		uploadArtifactWithWrangler(artifact, {
			bucket: R2_BUCKET,
			target: STATIC_R2_TARGET,
			persistTo: WRANGLER_PERSIST_TO,
		});
	}
}

mkdirSync(dirname(REPORT_PATH), { recursive: true });
console.log(`R2 target: ${STATIC_R2_TARGET}`);
console.log(`R2 bucket: ${R2_BUCKET}`);
if (STATIC_R2_TARGET === 'local') console.log(`persist-to: ${WRANGLER_PERSIST_TO}`);

const results: PublishResult[] = [];
if (INCLUDE_STD) await publishStdCrates(results);
if (INCLUDE_TOP) await publishTopCrates(results);

const generatedAt = new Date().toISOString();
const report = {
	generatedAt,
	r2Target: STATIC_R2_TARGET,
	r2Bucket: R2_BUCKET,
	results,
};
writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf-8');
publishCatalog(results, generatedAt);
const published = results.filter((result) => result.status === 'published').length;
const failed = results.length - published;
console.log(`\npublished ${published}/${results.length} crates; failed ${failed}`);
console.log(`report: ${REPORT_PATH}`);
if (failed > 0) {
	for (const result of results.filter((entry) => entry.status === 'failed')) {
		console.warn(`failed ${result.name}@${result.version}: ${result.error}`);
	}
}
