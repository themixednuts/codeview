/**
 * Build hosted static graph artifacts for one crate and publish them to R2.
 *
 * Defaults are tuned for local QA:
 *   MANIFEST_PATH=../codeview-core/Cargo.toml
 *   R2_BUCKET=crate-graphs
 *   STATIC_R2_TARGET=local
 *   WRANGLER_PERSIST_TO=.wrangler/state/v3
 *
 * Optional:
 *   RUSTDOC_JSON          Use an existing rustdoc JSON file instead of running cargo rustdoc
 *   CRATE_NAME            Override package name
 *   CRATE_VERSION         Override package version
 *   RUST_TOOLCHAIN        default: nightly
 *   UPLOAD_CONCURRENCY    default: 16
 */

import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
	buildStaticArtifacts,
	hyphenateCrateName,
	normalizeCrateName,
	runRustParser,
	seedLocalR2Artifacts,
	uploadArtifactWithWrangler,
	type CrateGraph,
} from './static-artifacts.ts';

type CargoMetadata = {
	packages: Array<{
		id: string;
		name: string;
		version: string;
		manifest_path: string;
		targets: Array<{
			name: string;
			kind: string[];
			src_path: string;
		}>;
	}>;
	resolve?: {
		root?: string;
	};
	target_directory: string;
};

const MANIFEST_PATH = resolve(process.env.MANIFEST_PATH || '../codeview-core/Cargo.toml');
const RUSTDOC_JSON = process.env.RUSTDOC_JSON ? resolve(process.env.RUSTDOC_JSON) : null;
const R2_BUCKET = process.env.R2_BUCKET || 'crate-graphs';
const STATIC_R2_TARGET = process.env.STATIC_R2_TARGET || 'local';
const RUST_TOOLCHAIN = process.env.RUST_TOOLCHAIN || 'nightly';
const WRANGLER_PERSIST_TO = process.env.WRANGLER_PERSIST_TO || '.wrangler/state/v3';
const UPLOAD_CONCURRENCY = Number(process.env.UPLOAD_CONCURRENCY || '16');
const LOCAL_R2_SEEDER = process.env.LOCAL_R2_SEEDER || 'direct';
const WORK_DIR = resolve('.codeview-static', 'local');

if (STATIC_R2_TARGET !== 'local' && STATIC_R2_TARGET !== 'remote') {
	throw new Error('STATIC_R2_TARGET must be "local" or "remote"');
}

function cargoMetadata(): CargoMetadata {
	const output = execFileSync(
		'cargo',
		['metadata', '--no-deps', '--format-version', '1', '--manifest-path', MANIFEST_PATH],
		{ encoding: 'utf-8' },
	);
	return JSON.parse(output) as CargoMetadata;
}

function packageFromMetadata(metadata: CargoMetadata) {
	const root = metadata.resolve?.root;
	if (root) {
		const pkg = metadata.packages.find((candidate) => candidate.id === root);
		if (pkg) return pkg;
	}
	const normalizedManifest = resolve(MANIFEST_PATH);
	const pkg = metadata.packages.find(
		(candidate) => resolve(candidate.manifest_path) === normalizedManifest,
	);
	if (!pkg) throw new Error(`Could not find package for manifest ${MANIFEST_PATH}`);
	return pkg;
}

function rustdocTarget(pkg: ReturnType<typeof packageFromMetadata>) {
	const lib = pkg.targets.find((target) =>
		target.kind.some((kind) =>
			['lib', 'rlib', 'cdylib', 'dylib', 'staticlib', 'proc-macro'].includes(kind),
		),
	);
	const bin = pkg.targets.find((target) => target.kind.includes('bin'));
	const target = lib ?? bin;
	if (!target) throw new Error(`Package ${pkg.name} has no lib or bin target`);
	return target;
}

function generateRustdocJson(metadata: CargoMetadata, rustdocName: string): string {
	execFileSync(
		'cargo',
		[
			`+${RUST_TOOLCHAIN}`,
			'rustdoc',
			'--manifest-path',
			MANIFEST_PATH,
			'--',
			'-Z',
			'unstable-options',
			'--output-format',
			'json',
		],
		{ stdio: 'inherit' },
	);
	return join(metadata.target_directory, 'doc', `${rustdocName}.json`);
}

const metadata = cargoMetadata();
const pkg = packageFromMetadata(metadata);
const target = rustdocTarget(pkg);
const packageName = process.env.CRATE_NAME || pkg.name;
const crateName = normalizeCrateName(packageName);
const storageName = hyphenateCrateName(packageName);
const version = process.env.CRATE_VERSION || pkg.version;
const rustdocName = normalizeCrateName(target.name);
const jsonPath = RUSTDOC_JSON ?? generateRustdocJson(metadata, rustdocName);
const graphPath = join(WORK_DIR, `${crateName}-${version}.graph.json`);

console.log(`crate:        ${crateName}@${version}`);
console.log(`R2 key:       rust/${storageName}/${version}`);
console.log(`rustdoc JSON: ${jsonPath}`);
console.log(`R2 target:    ${STATIC_R2_TARGET}`);
console.log(`R2 bucket:    ${R2_BUCKET}`);
if (STATIC_R2_TARGET === 'local') console.log(`persist-to:   ${WRANGLER_PERSIST_TO}`);

const graph: CrateGraph = runRustParser({
	jsonPath,
	crateName,
	version,
	outPath: graphPath,
	manifestPath: MANIFEST_PATH,
	rootFile: target.src_path,
	rustdocName,
});
const artifactDir = join(WORK_DIR, `${crateName}-${version}-artifacts`);
rmSync(artifactDir, { recursive: true, force: true });
const artifacts = await buildStaticArtifacts({
	crateName,
	storageName,
	version,
	graph,
	outDir: artifactDir,
	nodeDetailConcurrency: UPLOAD_CONCURRENCY,
});

console.log(`uploading ${artifacts.length} static artifacts...`);
if (STATIC_R2_TARGET === 'local' && LOCAL_R2_SEEDER === 'direct') {
	seedLocalR2Artifacts(artifacts, {
		bucket: R2_BUCKET,
		persistTo: WRANGLER_PERSIST_TO,
		deletePrefixes: [`rust/${storageName}/${version}/`],
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

console.log(`published ${crateName}@${version} to ${STATIC_R2_TARGET} R2`);
