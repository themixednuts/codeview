import {
	copyFile,
	mkdir,
	readdir,
	rm,
	stat,
	utimes,
} from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

const BUILD_IMMUTABLE_DIR = join(process.cwd(), '.svelte-kit', 'cloudflare', '_app', 'immutable');
const RETAINED_IMMUTABLE_DIR = join(
	process.cwd(),
	'.codeview-static',
	'retained-cloudflare-assets',
	'_app',
	'immutable',
);
const RETENTION_DAYS = parsePositiveInt(process.env.CODEVIEW_RETAINED_ASSET_DAYS, 30);
const command = process.argv[2];

if (command !== 'capture' && command !== 'restore') {
	console.error('Usage: bun scripts/retain-cloudflare-assets.ts <capture|restore>');
	process.exit(1);
}

if (command === 'capture') {
	await captureRetainedAssets();
} else {
	await restoreRetainedAssets();
}

async function captureRetainedAssets(): Promise<void> {
	if (!(await exists(BUILD_IMMUTABLE_DIR))) return;

	await copyMissingOrChangedFiles(BUILD_IMMUTABLE_DIR, RETAINED_IMMUTABLE_DIR, true);
	await pruneRetainedAssets();
}

async function restoreRetainedAssets(): Promise<void> {
	if (!(await exists(RETAINED_IMMUTABLE_DIR))) return;

	await copyMissingOrChangedFiles(RETAINED_IMMUTABLE_DIR, BUILD_IMMUTABLE_DIR, false);
}

async function copyMissingOrChangedFiles(
	sourceRoot: string,
	destinationRoot: string,
	overwriteChanged: boolean,
): Promise<void> {
	for await (const source of walkFiles(sourceRoot)) {
		const destination = join(destinationRoot, relative(sourceRoot, source));
		const sourceStat = await stat(source);
		const destinationStat = await maybeStat(destination);
		if (
			destinationStat &&
			(!overwriteChanged ||
				(destinationStat.size === sourceStat.size &&
					destinationStat.mtimeMs >= sourceStat.mtimeMs))
		) {
			continue;
		}

		await mkdir(dirname(destination), { recursive: true });
		await copyFile(source, destination);
		await utimes(destination, sourceStat.atime, sourceStat.mtime);
	}
}

async function pruneRetainedAssets(): Promise<void> {
	if (!(await exists(RETAINED_IMMUTABLE_DIR))) return;

	const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
	for await (const file of walkFiles(RETAINED_IMMUTABLE_DIR)) {
		const fileStat = await stat(file);
		if (fileStat.mtimeMs < cutoff) await rm(file, { force: true });
	}
}

async function* walkFiles(root: string): AsyncGenerator<string> {
	const entries = await readdir(root, { withFileTypes: true });
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			yield* walkFiles(path);
		} else if (entry.isFile()) {
			yield path;
		}
	}
}

async function exists(path: string): Promise<boolean> {
	return (await maybeStat(path)) !== null;
}

async function maybeStat(path: string) {
	try {
		return await stat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
