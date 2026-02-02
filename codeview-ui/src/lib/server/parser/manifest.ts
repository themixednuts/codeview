export interface ManifestEntry {
	path: string;
	content: string;
	packageName?: string;
	workspaceMembers: string[];
	workspaceExclude: string[];
	libPath?: string;
	bins: { name?: string; path?: string }[];
}

export function collectManifests(sourceFiles: Map<string, string>): ManifestEntry[] {
	const manifests: ManifestEntry[] = [];
	for (const [path, content] of sourceFiles) {
		if (!path.endsWith('Cargo.toml')) continue;
		const normalized = normalizePath(path);
		const packageName = parsePackageName(content) ?? undefined;
		const { libPath, bins } = parseManifestPaths(content);
		const { members, exclude } = parseWorkspace(content);
		manifests.push({
			path: normalized,
			content,
			packageName,
			workspaceMembers: members,
			workspaceExclude: exclude,
			libPath,
			bins
		});
	}
	return manifests;
}

export function selectManifestForCrate(
	crateName: string,
	manifests: ManifestEntry[]
): ManifestEntry | null {
	if (manifests.length === 0) return null;

	const byPath = new Map(manifests.map((m) => [m.path, m]));
	const exact = manifests.filter((m) => m.packageName === crateName);
	if (exact.length > 0) return pickShortest(exact);

	const workspaces = manifests.filter((m) => m.workspaceMembers.length > 0);
	for (const workspace of workspaces.sort((a, b) => a.path.length - b.path.length)) {
		const memberPaths = resolveWorkspaceMembers(
			workspace,
			manifests.map((m) => m.path)
		);
		for (const memberPath of memberPaths) {
			const entry = byPath.get(memberPath);
			if (entry?.packageName === crateName) {
				return entry;
			}
		}
	}

	const withPackage = manifests.filter((m) => m.packageName);
	if (withPackage.length > 0) return pickShortest(withPackage);

	const root = manifests.find((m) => m.path === 'Cargo.toml');
	return root ?? pickShortest(manifests);
}

export function filterSourceFilesForManifest(
	sourceFiles: Map<string, string>,
	manifest: ManifestEntry
): Map<string, string> {
	const baseDir = manifestDir(manifest.path);
	if (!baseDir) return new Map(sourceFiles);
	const prefix = `${baseDir}/`;
	const filtered = new Map<string, string>();
	for (const [path, content] of sourceFiles) {
		if (path === manifest.path || path.startsWith(prefix)) {
			filtered.set(path, content);
		}
	}
	return filtered;
}

export function resolveRootFile(
	manifest: ManifestEntry,
	sourceFiles: Map<string, string>
): string | null {
	const baseDir = manifestDir(manifest.path);
	const candidates: string[] = [];

	if (manifest.libPath) {
		candidates.push(joinPath(baseDir, manifest.libPath));
	}

	for (const bin of manifest.bins) {
		if (bin.path) {
			candidates.push(joinPath(baseDir, bin.path));
		} else if (bin.name) {
			candidates.push(joinPath(baseDir, `src/bin/${bin.name}.rs`));
		}
	}

	if (!manifest.libPath && manifest.bins.length === 0) {
		candidates.push(joinPath(baseDir, 'src/lib.rs'));
		candidates.push(joinPath(baseDir, 'src/main.rs'));
	}

	for (const candidate of candidates) {
		if (sourceFiles.has(candidate)) return candidate;
	}

	return null;
}

export function resolveRootFileForCrate(
	crateName: string,
	sourceFiles: Map<string, string>
): string | null {
	const manifests = collectManifests(sourceFiles);
	const manifest = selectManifestForCrate(crateName, manifests);
	if (manifest) {
		const resolved = resolveRootFile(manifest, sourceFiles);
		if (resolved) return resolved;
	}

	const fallback = ['src/lib.rs', 'src/main.rs', 'lib.rs', 'main.rs'];
	for (const candidate of fallback) {
		if (sourceFiles.has(candidate)) return candidate;
	}
	return null;
}

export function manifestDir(path: string): string {
	const normalized = normalizePath(path);
	if (normalized === 'Cargo.toml') return '';
	return normalized.replace(/\/?Cargo\.toml$/, '');
}

export function normalizePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
}

function parsePackageName(content: string): string | null {
	const section = extractSection(content, 'package');
	return section ? readKey(section, 'name') : null;
}

function parseManifestPaths(content: string): {
	libPath?: string;
	bins: { name?: string; path?: string }[];
} {
	const libSection = extractSection(content, 'lib');
	const libPath = libSection ? readKey(libSection, 'path') ?? undefined : undefined;
	const binSections = extractArraySections(content, 'bin');
	const bins = binSections.map((section) => ({
		name: readKey(section, 'name') ?? undefined,
		path: readKey(section, 'path') ?? undefined
	}));
	return { libPath, bins };
}

function parseWorkspace(content: string): { members: string[]; exclude: string[] } {
	const section = extractSection(content, 'workspace');
	if (!section) return { members: [], exclude: [] };
	return {
		members: parseStringArray(section, 'members'),
		exclude: parseStringArray(section, 'exclude')
	};
}

function parseStringArray(section: string, key: string): string[] {
	const match = section.match(new RegExp(`^\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm'));
	if (!match) return [];
	const body = match[1];
	const values: string[] = [];
	const regex = /"([^"]*)"|'([^']*)'/g;
	for (const line of body.split('\n')) {
		const clean = line.replace(/#.*$/, '');
		let m: RegExpExecArray | null;
		while ((m = regex.exec(clean))) {
			values.push(m[1] ?? m[2]);
		}
	}
	return values.map((value) => normalizePath(value));
}

function resolveWorkspaceMembers(
	root: ManifestEntry,
	manifestPaths: string[]
): string[] {
	const rootDir = manifestDir(root.path);
	const rootPrefix = rootDir ? `${rootDir}/` : '';
	const candidates = manifestPaths
		.filter((path) => path.startsWith(rootPrefix))
		.map((path) => ({
			path,
			rel: path.slice(rootPrefix.length)
		}));

	const include = new Set<string>();
	const exclude = new Set<string>();

	for (const pattern of root.workspaceMembers) {
		const normalized = normalizeWorkspacePattern(pattern);
		if (normalized === '.') {
			include.add(root.path);
			continue;
		}
		const regex = globToRegex(appendCargoToml(normalized));
		for (const candidate of candidates) {
			if (regex.test(candidate.rel)) {
				include.add(candidate.path);
			}
		}
	}

	for (const pattern of root.workspaceExclude) {
		const normalized = normalizeWorkspacePattern(pattern);
		if (normalized === '.') {
			exclude.add(root.path);
			continue;
		}
		const regex = globToRegex(appendCargoToml(normalized));
		for (const candidate of candidates) {
			if (regex.test(candidate.rel)) {
				exclude.add(candidate.path);
			}
		}
	}

	return [...include].filter((path) => !exclude.has(path));
}

function normalizeWorkspacePattern(pattern: string): string {
	const normalized = normalizePath(pattern);
	return normalized === '' ? '.' : normalized;
}

function appendCargoToml(pattern: string): string {
	if (pattern.endsWith('Cargo.toml')) return pattern;
	return `${pattern.replace(/\/$/, '')}/Cargo.toml`;
}

function globToRegex(glob: string): RegExp {
	const placeholder = '__GLOBSTAR__';
	let pattern = glob.replace(/\*\*/g, placeholder);
	pattern = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	pattern = pattern.replace(new RegExp(placeholder, 'g'), '.*');
	pattern = pattern.replace(/\\\*/g, '[^/]*');
	pattern = pattern.replace(/\\\?/g, '[^/]');
	return new RegExp(`^${pattern}$`);
}

function extractSection(content: string, name: string): string | null {
	const match = content.match(new RegExp(`\\[${name}\\][\\s\\S]*?(?=\\n\\[|$)`, 'i'));
	return match?.[0] ?? null;
}

function extractArraySections(content: string, name: string): string[] {
	const regex = new RegExp(`\\[\\[${name}\\]\\][\\s\\S]*?(?=\\n\\[|$)`, 'gi');
	return Array.from(content.matchAll(regex), (m) => m[0]);
}

function readKey(section: string, key: string): string | null {
	const match = section.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm'));
	return match?.[1] ?? null;
}

function joinPath(base: string, rel: string): string {
	if (!base) return normalizePath(rel);
	return normalizePath(`${base}/${rel}`);
}

function pickShortest(entries: ManifestEntry[]): ManifestEntry {
	return entries.slice().sort((a, b) => a.path.length - b.path.length)[0];
}
