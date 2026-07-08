import type { VcsMode } from '$lib/context';

export function repoBaseUrl(url: string): string {
	const blobIdx = url.indexOf('/blob/');
	return blobIdx !== -1 ? url.slice(0, blobIdx) : url;
}

export function cloneCommand(repoUrl: string, vcsMode: VcsMode): string {
	const base = repoBaseUrl(repoUrl);
	return vcsMode === 'jj' ? `jj git clone ${base}` : `git clone ${base}`;
}

export function normalizeSourceRoot(root: string): string {
	return root.trim().replace(/[\\/]+$/, '');
}

export function normalizeSourceFile(file: string): string {
	return file.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/^\/+/, '');
}

export function sourcePathFromRoot(root: string, file: string): string | null {
	const cleanRoot = normalizeSourceRoot(root);
	const cleanFile = normalizeSourceFile(file);
	if (!cleanRoot || !cleanFile) return null;
	const separator = cleanRoot.includes('\\') && !cleanRoot.includes('/') ? '\\' : '/';
	return `${cleanRoot}${separator}${cleanFile.replace(/\//g, separator)}`;
}

export function resolveEditorPath(
	absolutePath: string | null | undefined,
	sourceRoot: string,
	file: string,
): string | null {
	if (absolutePath) return absolutePath;
	return sourcePathFromRoot(sourceRoot, file);
}

export function editorUri(scheme: string, path: string, line: number): string {
	return scheme.replaceAll('{path}', path).replaceAll('{line}', String(line));
}
