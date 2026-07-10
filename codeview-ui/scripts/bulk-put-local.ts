/**
 * `scripts/bulk-put-local.ts` — long-running miniflare R2 writer.
 *
 * Speaks a tiny JSON-Lines RPC over stdio so the Rust
 * `LocalMiniflareBackend` can keep one miniflare process alive across
 * hundreds of puts.  Replaces the per-put `bunx wrangler r2 object
 * put` spawn (which paid ~3s of node startup per artifact) with a
 * persistent process that pays the startup cost once.
 *
 * **Protocol (stdio):**
 *
 *   Request  (stdin, one JSON line per put):
 *     { "key": "rust/std/.../manifest.json",
 *       "contentType": "application/json",
 *       "body": "<base64-encoded bytes>" }
 *
 *   Response (stdout, one JSON line per put):
 *     { "ok": true,  "key": "..."}
 *     { "ok": false, "key": "...", "err": "..." }
 *
 *   Ready marker (stdout, before first request):
 *     { "ready": true }
 *
 *   stderr is informational logging — Rust ignores it on the happy
 *   path, surfaces it when stdin closes with an unexpected exit code.
 *
 * Run as:
 *   bun scripts/bulk-put-local.ts \
 *     --binding CRATE_GRAPHS \
 *     --bucket crate-graphs \
 *     --persist-to .wrangler/state
 */

import { Miniflare } from 'miniflare';
import { createInterface } from 'node:readline';

interface Args {
	binding: string;
	bucket: string;
	persistTo: string;
}

function parseArgs(argv: string[]): Args {
	const out: Partial<Args> = {};
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		const val = argv[i + 1];
		switch (flag) {
			case '--binding':
				out.binding = val;
				i += 1;
				break;
			case '--bucket':
				out.bucket = val;
				i += 1;
				break;
			case '--persist-to':
				out.persistTo = val;
				i += 1;
				break;
			default:
				throw new Error(`unknown flag: ${flag}`);
		}
	}
	if (!out.binding || !out.bucket || !out.persistTo) {
		throw new Error(
			`missing required args; got binding=${out.binding} bucket=${out.bucket} persist-to=${out.persistTo}`,
		);
	}
	return out as Args;
}

function writeStdout(obj: unknown): void {
	process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));

	const mf = new Miniflare({
		modules: true,
		script: 'export default { async fetch() { return new Response(); } };',
		r2Buckets: { [args.binding]: args.bucket },
		// Match Wrangler's local persistence contract. Wrangler passes the v3
		// root as Miniflare's default root and lets each plugin own its directory.
		defaultPersistRoot: `${args.persistTo}/v3`,
		log: undefined,
	});
	await mf.ready;
	const bucket = await mf.getR2Bucket(args.binding);

	writeStdout({ ready: true });
	process.stderr.write(
		`[bulk-put-local] miniflare ready; binding=${args.binding} bucket=${args.bucket} persist-to=${args.persistTo}\n`,
	);

	const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
	let lineCount = 0;
	try {
		for await (const line of rl) {
			lineCount += 1;
			const trimmed = line.trim();
			if (!trimmed) continue;
			let req: { key: string; contentType?: string; body: string };
			try {
				req = JSON.parse(trimmed);
			} catch (err) {
				writeStdout({
					ok: false,
					key: '<parse-error>',
					err: `parse line ${lineCount}: ${(err as Error).message}`,
				});
				continue;
			}
			try {
				const body = Buffer.from(req.body, 'base64');
				await bucket.put(req.key, body, {
					httpMetadata: req.contentType ? { contentType: req.contentType } : undefined,
				});
				writeStdout({ ok: true, key: req.key });
			} catch (err) {
				writeStdout({ ok: false, key: req.key, err: (err as Error).message });
			}
		}
	} finally {
		await mf.dispose();
	}
	process.stderr.write(`[bulk-put-local] processed ${lineCount} requests, exiting\n`);
}

main().catch((err) => {
	process.stderr.write(`[bulk-put-local] fatal: ${err}\n`);
	process.exit(1);
});
