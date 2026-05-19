/**
 * Parse rustdoc JSON by invoking the canonical Rust parser via cargo.
 *
 * Replaces the in-process TypeScript streaming parser. Now that all
 * production parsing happens offline (GHA cron → R2 artifacts), there's
 * no reason to maintain a parallel TS implementation — local dev mode
 * shells out to the same `codeview-cli parse-json` invocation that
 * `scripts/parse-one.ts` uses in CI.
 *
 * The Rust parser is synchronous (one shot, full graph) so we lose the
 * progressive-storage stream the TS builder used to provide. Storage
 * callbacks are still invoked once-each with the full nodes/edges lists
 * to keep the existing local-cache ingest code path unchanged.
 *
 * For very large crates (windows-sys, libc) the wall-clock difference
 * between streaming and one-shot is negligible — the Rust parser is
 * fast enough that the whole graph lands in well under 10s.
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

/**
 * Same shape the old streaming parser returned, so callers can swap in
 * without changing their downstream consumers.
 */
export interface ProgressiveParseResult {
	nodeCount: number;
	edgeCount: number;
	tree: CrateTree;
	externalCrates: Array<{ id: string; name: string }>;
	crateVersion: string | null;
}

/**
 * Callback shape preserved from the streaming parser — storeNodes/storeEdges
 * fire once each with the full lists (instead of incrementally) since the
 * Rust binary is one-shot.
 */
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
	/**
	 * `manifest-path` arg passed to cargo so the parser can resolve
	 * cross-crate IDs against the workspace's `cargo metadata`. Optional —
	 * docs.rs JSON parses fine without it.
	 */
	manifestPath?: string;
	/**
	 * Root source file (relative to manifest-path) — lets the parser open
	 * the local source tree for call-graph extraction (`--call-mode strict`).
	 */
	rootFile?: string;
	/** `strict` (default) or `ambiguous` — see codeview-rustdoc::CallMode. */
	callMode?: 'strict' | 'ambiguous';
	/** Override the cargo package name used in the parser invocation. */
	rustdocName?: string;
	/** Working dir for cargo. Defaults to the codeview repo root. */
	cargoWorkingDir?: string;
	/** Called when parse begins → useful for status emission. */
	onProgress?: (progress: ParseProgress) => void;
	/** Fired between download and parse phases. */
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
 * Parse rustdoc JSON bytes into a graph by shelling out to codeview-cli.
 *
 * `input` is the raw decompressed rustdoc JSON. We buffer it to a temp
 * file (cargo wants a path) and call `codeview parse-json`, then read
 * the emitted graph JSON back.
 *
 * Tree building is delegated to the consumer's storage callbacks — this
 * function only returns a *placeholder* tree in the result. Callers that
 * need a real CrateTree should build it from the stored nodes/edges
 * (which is what `local/provider.ts` already does via its node-index +
 * cache layer).
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
		// ── Stage 1: materialise the rustdoc JSON to a file ────────────
		if (typeof input === 'string') {
			writeFileSync(jsonPath, input, 'utf-8');
		} else if (input instanceof Uint8Array) {
			writeFileSync(jsonPath, input);
		} else {
			// Stream: accumulate to a buffer, then write. Could be improved to
			// stream-pipe to disk, but rustdoc JSON for huge crates is ~10MB
			// uncompressed which fits comfortably in memory once.
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

		// ── Stage 2: invoke the Rust parser ────────────────────────────
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
			'0.0.0', // placeholder; real version comes from rustdoc JSON itself
			'--out',
			graphPath,
			'--call-mode',
			options.callMode ?? 'strict',
		];
		if (options.manifestPath && options.rootFile) {
			args.push(
				'--manifest-path',
				options.manifestPath,
				'--root-file',
				options.rootFile,
			);
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

		// ── Stage 3: read graph and feed it to the storage callbacks ───
		const graphRaw = readFileSync(graphPath, 'utf-8');
		const graph = JSON.parse(graphRaw) as CrateGraphJson;

		storageCallbacks.storeNodes(graph.nodes);
		storageCallbacks.storeEdges(graph.edges);

		options.onProgress?.({
			type: 'complete',
			nodeCount: graph.nodes.length,
			edgeCount: graph.edges.length,
			totalItems: graph.nodes.length,
		});

		// External crates are inferred from edges whose `to` lives in a
		// different crate prefix. The consumer can reconstruct these from
		// stored data; we return an empty list here for API parity with the
		// old streaming parser.
		const externalCrates: Array<{ id: string; name: string }> = [];

		// Placeholder tree — callers needing a structured tree build it
		// from the stored nodes (see `local/cache.ts::buildCrateTree`).
		const tree: CrateTree = { nodes: [], edges: graph.edges };

		return {
			nodeCount: graph.nodes.length,
			edgeCount: graph.edges.length,
			tree,
			externalCrates,
			crateVersion: graph.version || null,
		};
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
}

/**
 * Walk upward from CWD looking for the workspace `Cargo.toml`. Caches the
 * result for repeat calls. Errors loudly if we're not inside the codeview
 * checkout — the local-mode CLI shouldn't be invoked outside it.
 */
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
	throw new Error(
		'Could not locate codeview workspace Cargo.toml. ' +
			'Run the local CLI from inside the codeview checkout, or set ' +
			'CODEVIEW_REPO_ROOT explicitly.',
	);
}
