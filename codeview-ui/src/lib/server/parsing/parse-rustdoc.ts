/**
 * Thin subprocess bridge that the local-CLI dev mode uses to invoke the
 * canonical Rust parser on demand.
 *
 * Production parsing happens via `codeview cron parse-one` (run from
 * GHA, writes to R2 directly).  The local CLI's `codeview ui .` keeps
 * the older "parse on demand into the SQLite cache" workflow because
 * users browsing their own workspace expect immediate results without
 * staging an R2 round-trip first.  This module is the ONLY remaining
 * TypeScript that participates in parsing — and it does nothing but
 * spawn `cargo run -p codeview-cli -- parse-json` and ingest the
 * resulting graph JSON.
 *
 * Anything beyond subprocess wrangling (artifact building, R2 upload,
 * freshness tracking, etc.) lives in `codeview-cli/src/cron/`.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Edge, Node } from '$lib/graph';
import type { CrateTree } from '$lib/schema';
import { getLogger } from '$lib/log';
import { normalizeCrateName } from '$lib/crate-names';

const log = getLogger('parse-rustdoc');

export interface ProgressiveParseResult {
	nodeCount: number;
	edgeCount: number;
	tree: CrateTree;
	externalCrates: Array<{ id: string; name: string }>;
	crateVersion: string | null;
}

export interface ProgressiveStorageCallbacks {
	storeNodes: (nodes: Node[]) => void;
	storeEdges: (edges: Edge[]) => void;
}

export interface ParseProgress {
	type: 'delta' | 'complete';
	nodeCount: number;
	edgeCount: number;
	totalItems?: number;
}

export interface ParseRustdocOptions {
	manifestPath?: string;
	rootFile?: string;
	callMode?: 'strict' | 'ambiguous';
	rustdocName?: string;
	cargoWorkingDir?: string;
	onProgress?: (progress: ParseProgress) => void;
	onFinalizingStart?: () => void;
}

interface CrateGraphJson {
	id: string;
	name: string;
	version: string;
	nodes: Node[];
	edges: Edge[];
}

/**
 * Materialise the rustdoc JSON to a temp file, invoke
 * `codeview-cli parse-json`, read the emitted graph back, and feed it
 * to the storage callbacks. One-shot — no streaming — but the Rust
 * binary is fast enough that even windows-sys lands in well under 10s.
 */
export async function parseWithRustBinary(
	input: ReadableStream<Uint8Array> | Uint8Array | string,
	crateName: string,
	storageCallbacks: ProgressiveStorageCallbacks,
	options: ParseRustdocOptions = {},
): Promise<ProgressiveParseResult> {
	const normalizedName = normalizeCrateName(crateName);
	const tmpDir = mkdtempSync(join(tmpdir(), `codeview-parse-${normalizedName}-`));
	const jsonPath = join(tmpDir, 'rustdoc.json');
	const graphPath = join(tmpDir, 'graph.json');

	try {
		if (typeof input === 'string') {
			writeFileSync(jsonPath, input, 'utf-8');
		} else if (input instanceof Uint8Array) {
			writeFileSync(jsonPath, input);
		} else {
			const chunks: Uint8Array[] = [];
			const reader = input.getReader();
			let total = 0;
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				if (value) {
					chunks.push(value);
					total += value.length;
				}
			}
			const combined = new Uint8Array(total);
			let offset = 0;
			for (const chunk of chunks) {
				combined.set(chunk, offset);
				offset += chunk.length;
			}
			writeFileSync(jsonPath, combined);
		}

		options.onProgress?.({ type: 'delta', nodeCount: 0, edgeCount: 0 });

		const cargoWorkingDir = options.cargoWorkingDir ?? findCodeviewRepoRoot();
		mkdirSync(dirname(graphPath), { recursive: true });

		const args = [
			'run',
			'--manifest-path',
			join(cargoWorkingDir, 'Cargo.toml'),
			'-p',
			'codeview-cli',
			'--',
			'parse-json',
			'--json',
			jsonPath,
			'--crate-name',
			normalizedName,
			'--version',
			'0.0.0',
			'--out',
			graphPath,
			'--call-mode',
			options.callMode ?? 'strict',
		];
		if (options.manifestPath && options.rootFile) {
			args.push('--manifest-path', options.manifestPath, '--root-file', options.rootFile);
		}
		if (options.rustdocName) {
			args.push('--rustdoc-name', options.rustdocName);
		}

		log.info`Invoking codeview-cli parse-json for ${crateName}`;
		options.onFinalizingStart?.();

		execFileSync('cargo', args, {
			env: { ...process.env, CODEVIEW_SKIP_SIDECAR: '1' },
			stdio: 'inherit',
		});

		const graph = JSON.parse(readFileSync(graphPath, 'utf-8')) as CrateGraphJson;
		storageCallbacks.storeNodes(graph.nodes);
		storageCallbacks.storeEdges(graph.edges);

		options.onProgress?.({
			type: 'complete',
			nodeCount: graph.nodes.length,
			edgeCount: graph.edges.length,
			totalItems: graph.nodes.length,
		});

		return {
			nodeCount: graph.nodes.length,
			edgeCount: graph.edges.length,
			tree: { nodes: [], edges: graph.edges },
			externalCrates: [],
			crateVersion: graph.version || null,
		};
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
}

let cachedRepoRoot: string | null = null;
function findCodeviewRepoRoot(): string {
	if (cachedRepoRoot) return cachedRepoRoot;
	let dir = resolve(process.cwd());
	while (dir !== resolve(dir, '..')) {
		try {
			const cargoToml = readFileSync(join(dir, 'Cargo.toml'), 'utf-8');
			if (cargoToml.includes('codeview-cli') || cargoToml.includes('[workspace]')) {
				cachedRepoRoot = dir;
				return dir;
			}
		} catch {
			/* keep walking */
		}
		dir = resolve(dir, '..');
	}
	throw new Error('Could not locate codeview workspace Cargo.toml');
}
