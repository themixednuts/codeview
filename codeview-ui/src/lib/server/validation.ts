const CRATE_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const VERSION_RE = /^\d{1,10}\.\d{1,10}\.\d{1,10}(?:-[\w.]+)?(?:\+[\w.]+)?$/;
const ALLOWED_ECOSYSTEMS = new Set(['rust']);
const EDGE_NODE_ID_MAX = 512;

export function isValidCrateName(name: string): boolean {
	return CRATE_NAME_RE.test(name);
}

export function isValidVersion(version: string): boolean {
	return version === 'latest' || VERSION_RE.test(version);
}

export function isValidEcosystem(ecosystem: string): boolean {
	return ALLOWED_ECOSYSTEMS.has(ecosystem);
}

export function parseCrateKey(
	key: string
): { ecosystem: string; name: string; version: string } | null {
	const parts = key.split(':');
	if (parts.length !== 3) return null;
	const [ecosystem, name, version] = parts;
	if (!isValidEcosystem(ecosystem) || !isValidCrateName(name) || !isValidVersion(version)) {
		return null;
	}
	return { ecosystem, name, version };
}

export function parseEdgeKey(key: string): { nodeId: string } | null {
	if (!key.startsWith('edge:')) return null;
	const nodeId = key.slice('edge:'.length);
	if (!nodeId || nodeId.length > EDGE_NODE_ID_MAX) return null;
	return { nodeId };
}

export function sanitizeSearchQuery(q: string): string {
	return q.slice(0, 100).trim();
}
