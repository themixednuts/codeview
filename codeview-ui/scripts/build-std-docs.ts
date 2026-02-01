/**
 * Parse std-lib rustdoc JSON and upload graphs to R2.
 *
 * Expected env vars:
 *   RUST_VERSION   – e.g. "1.84.0"
 *   R2_ENDPOINT    – e.g. "https://<account>.r2.cloudflarestorage.com"
 *   R2_BUCKET      – e.g. "crate-graphs"
 *   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY – S3-compatible R2 creds
 */

import { readFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { createRustdocParser } from '../src/lib/server/parser/rustdoc.js';
import { STD_JSON_CRATES } from '../src/lib/std-crates.js';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const RUST_VERSION = env('RUST_VERSION');
const R2_ENDPOINT = env('R2_ENDPOINT');
const R2_BUCKET = env('R2_BUCKET');

function env(name: string): string {
	const v = process.env[name];
	if (!v) throw new Error(`Missing env var: ${name}`);
	return v;
}

// ---------------------------------------------------------------------------
// S3 client (R2-compatible)
// ---------------------------------------------------------------------------

const s3 = new S3Client({
	endpoint: R2_ENDPOINT,
	region: 'auto',
	forcePathStyle: true
});

async function upload(key: string, body: string): Promise<void> {
	await s3.send(
		new PutObjectCommand({
			Bucket: R2_BUCKET,
			Key: key,
			Body: body,
			ContentType: 'application/json'
		})
	);
	console.log(`  uploaded ${key}`);
}

// ---------------------------------------------------------------------------
// Locate rustdoc JSON directory
// ---------------------------------------------------------------------------

const sysroot = execSync('rustc +nightly --print sysroot', { encoding: 'utf-8' }).trim();
const jsonDir = join(sysroot, 'share', 'doc', 'rust', 'json');

console.log(`Rust version: ${RUST_VERSION}`);
console.log(`Sysroot:      ${sysroot}`);
console.log(`JSON dir:     ${jsonDir}`);

const available = new Set(
	readdirSync(jsonDir)
		.filter((f) => f.endsWith('.json'))
		.map((f) => basename(f, '.json'))
);

console.log(`Available JSON crates: ${[...available].join(', ')}`);

// ---------------------------------------------------------------------------
// Parse each crate and upload
// ---------------------------------------------------------------------------

const parser = createRustdocParser();

for (const crate of STD_JSON_CRATES) {
	if (!available.has(crate)) {
		console.warn(`⚠ ${crate}.json not found in ${jsonDir}, skipping`);
		continue;
	}

	console.log(`Parsing ${crate}...`);
	const jsonPath = join(jsonDir, `${crate}.json`);
	const rawJson = readFileSync(jsonPath, 'utf-8');

	const result = await parser.parse(rawJson, crate, RUST_VERSION);

	const graphData = {
		id: crate,
		name: crate,
		version: RUST_VERSION,
		nodes: result.graph.nodes ?? [],
		edges: result.graph.edges ?? []
	};

	const index = {
		name: crate,
		version: RUST_VERSION,
		crates: [
			{
				id: crate,
				name: crate,
				version: RUST_VERSION,
				is_external: false
			}
		]
	};

	const prefix = `rust/${crate}/${RUST_VERSION}`;
	await upload(`${prefix}/graph.json`, JSON.stringify(graphData));
	await upload(`${prefix}/index.json`, JSON.stringify(index));

	// Write channel pointers so the provider can resolve rust/{crate}/{channel}
	await upload(`rust/${crate}/latest.json`, JSON.stringify({ version: RUST_VERSION }));
	await upload(`rust/${crate}/stable.json`, JSON.stringify({ version: RUST_VERSION }));
}

console.log('Done.');
