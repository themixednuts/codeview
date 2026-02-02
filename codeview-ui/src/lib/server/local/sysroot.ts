import { execFile as execFileCb } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { getLogger } from '$lib/log';

const execFile = promisify(execFileCb);
const log = getLogger('sysroot');

const EXEC_TIMEOUT = 30_000;
const INSTALL_TIMEOUT = 120_000;

export interface SysrootInfo {
	sysrootPath: string;
	jsonDir: string;
	toolchainVersion: string;
	availableCrates: string[];
}

export interface StdJsonResult {
	available: boolean;
	jsonPath?: string;
	installedVersion?: string;
}

// Module-level cache for sysroots (with pending dedup)
let cachedSysroot: SysrootInfo | null = null;
let pendingDetect: Promise<SysrootInfo> | null = null;
// Per-toolchain cache for non-default toolchains
const toolchainCache = new Map<string, SysrootInfo>();
const pendingToolchainDetect = new Map<string, Promise<SysrootInfo>>();

/**
 * Extract the nightly/beta/stable version string from a rustc version line.
 * e.g. "rustc 1.94.0-nightly (abc123 2025-01-01)" → "1.94.0-nightly"
 */
function parseRustcVersion(versionLine: string): string {
	const match = versionLine.match(/rustc\s+([\d]+\.[\d]+\.[\d]+(?:-[\w.]+)?)/);
	return match?.[1] ?? '';
}

/**
 * Map a version string to a toolchain name for rustup.
 * - "1.94.0-nightly" → "nightly"
 * - "1.82.0" → "stable" (or the exact version)
 * - "nightly" → "nightly"
 */
function versionToToolchain(version: string): string {
	if (version === 'nightly' || version === 'stable' || version === 'beta') {
		return version;
	}
	if (version.includes('-nightly')) return 'nightly';
	if (version.includes('-beta')) return 'beta';
	// Bare semver — assume it's the default/stable toolchain
	return 'stable';
}

async function execRustc(args: string[], timeout = EXEC_TIMEOUT): Promise<string> {
	const { stdout } = await execFile('rustc', args, {
		timeout,
		windowsHide: true,
		encoding: 'utf-8',
	});
	return stdout.trim();
}

async function execRustup(args: string[], timeout = EXEC_TIMEOUT): Promise<string> {
	const { stdout } = await execFile('rustup', args, {
		timeout,
		windowsHide: true,
		encoding: 'utf-8',
	});
	return stdout.trim();
}

/**
 * Detect the sysroot for a given toolchain (or the default if none specified).
 * Returns paths, version, and available JSON crate docs.
 */
export async function detectSysroot(toolchain?: string): Promise<SysrootInfo> {
	const rustcArgs = toolchain
		? [`+${toolchain}`, '--print', 'sysroot']
		: ['--print', 'sysroot'];
	const sysrootPath = await execRustc(rustcArgs);

	const versionArgs = toolchain
		? [`+${toolchain}`, '--version']
		: ['--version'];
	const versionLine = await execRustc(versionArgs);
	const toolchainVersion = parseRustcVersion(versionLine);

	const jsonDir = join(sysrootPath, 'share', 'doc', 'rust', 'json');
	let availableCrates: string[] = [];
	try {
		const entries = await readdir(jsonDir);
		availableCrates = entries
			.filter((e) => e.endsWith('.json'))
			.map((e) => e.replace(/\.json$/, ''));
	} catch {
		// json dir doesn't exist — rust-docs-json not installed
	}

	return { sysrootPath, jsonDir, toolchainVersion, availableCrates };
}

async function getDefaultSysroot(): Promise<SysrootInfo | null> {
	if (cachedSysroot) return cachedSysroot;
	if (!pendingDetect) {
		pendingDetect = detectSysroot().then((info) => {
			cachedSysroot = info;
			log.info`Detected sysroot: ${info.sysrootPath} (${info.toolchainVersion}), json crates: ${info.availableCrates.join(', ') || 'none'}`;
			return info;
		}).finally(() => {
			pendingDetect = null;
		});
	}
	try {
		return await pendingDetect;
	} catch (err) {
		log.error`Failed to detect sysroot: ${String(err)}`;
		return null;
	}
}

async function getToolchainSysroot(toolchain: string): Promise<SysrootInfo | null> {
	const cached = toolchainCache.get(toolchain);
	if (cached) return cached;
	let pending = pendingToolchainDetect.get(toolchain);
	if (!pending) {
		pending = detectSysroot(toolchain).then((info) => {
			toolchainCache.set(toolchain, info);
			log.info`Detected ${toolchain} sysroot: ${info.sysrootPath} (${info.toolchainVersion}), json crates: ${info.availableCrates.join(', ') || 'none'}`;
			return info;
		}).finally(() => {
			pendingToolchainDetect.delete(toolchain);
		});
		pendingToolchainDetect.set(toolchain, pending);
	}
	try {
		return await pending;
	} catch {
		return null;
	}
}

function versionMatchesSysroot(version: string, info: SysrootInfo): boolean {
	return (
		version === info.toolchainVersion ||
		version === versionToToolchain(info.toolchainVersion) ||
		// "stable" matches any non-prerelease version
		(version === 'stable' && !info.toolchainVersion.includes('-'))
	);
}

function checkCrateInSysroot(crateName: string, info: SysrootInfo): StdJsonResult {
	const installedVersion = info.toolchainVersion || undefined;
	if (info.availableCrates.includes(crateName)) {
		return {
			available: true,
			jsonPath: join(info.jsonDir, `${crateName}.json`),
			installedVersion,
		};
	}
	return { available: false, installedVersion };
}

/**
 * Find the std JSON file for a given crate name + version.
 * Returns availability info and the path if found.
 * Checks the default toolchain first, then falls back to the
 * toolchain implied by the version string (e.g. nightly for "1.94.0-nightly").
 */
export async function findStdJson(
	crateName: string,
	version: string
): Promise<StdJsonResult> {
	// Try default toolchain first
	const defaultInfo = await getDefaultSysroot();
	if (defaultInfo && versionMatchesSysroot(version, defaultInfo)) {
		return checkCrateInSysroot(crateName, defaultInfo);
	}

	// Try the toolchain implied by the version
	const toolchain = versionToToolchain(version);
	const defaultToolchain = defaultInfo ? versionToToolchain(defaultInfo.toolchainVersion) : null;
	if (toolchain !== defaultToolchain) {
		const altInfo = await getToolchainSysroot(toolchain);
		if (altInfo && versionMatchesSysroot(version, altInfo)) {
			return checkCrateInSysroot(crateName, altInfo);
		}
	}

	return {
		available: false,
		installedVersion: defaultInfo?.toolchainVersion || undefined,
	};
}

/**
 * Install rust-docs-json for a given toolchain via rustup.
 * Returns updated sysroot info after installation.
 */
export async function installStdDocs(toolchain: string): Promise<SysrootInfo> {
	log.info`Installing rust-docs-json for toolchain ${toolchain}`;
	await execRustup(
		['component', 'add', 'rust-docs-json', '--toolchain', toolchain],
		INSTALL_TIMEOUT
	);

	// Clear all caches and re-detect
	cachedSysroot = null;
	pendingDetect = null;
	toolchainCache.delete(toolchain);
	pendingToolchainDetect.delete(toolchain);
	const info = await detectSysroot(toolchain);
	toolchainCache.set(toolchain, info);
	log.info`Installed rust-docs-json: ${info.availableCrates.length} crates available`;
	return info;
}

/** Reset the cached sysroot (for testing). */
export function resetSysrootCache(): void {
	cachedSysroot = null;
	pendingDetect = null;
	toolchainCache.clear();
	pendingToolchainDetect.clear();
}
