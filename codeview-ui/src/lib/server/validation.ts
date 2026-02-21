import { isRustChannel } from '$lib/std';
import { isValidCrateNameParam, isValidVersionParam } from '$lib/crate-ref';

const ALLOWED_ECOSYSTEMS = new Set(['rust']);
export { normalizeCrateName, hyphenateCrateName, crateNameVariants } from '$lib/crate-names';
const EDGE_NODE_ID_MAX = 512;

export function isValidCrateName(name: string): boolean {
	return isValidCrateNameParam(name);
}

export function isValidVersion(version: string): boolean {
	return isRustChannel(version) || isValidVersionParam(version);
}

export function isValidEcosystem(ecosystem: string): boolean {
	return ALLOWED_ECOSYSTEMS.has(ecosystem);
}

export function parseCrateKey(
	key: string,
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
