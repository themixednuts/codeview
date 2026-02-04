import { isRustChannel } from '$lib/std';
import { isValidCrateNameParam, isValidVersionParam } from '$lib/crate-ref';

const ALLOWED_ECOSYSTEMS = new Set(['rust']);
const UNDERSCORE_RE = /_/g;
const HYPHEN_RE = /-/g;
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

/** Canonical Rust crate name: hyphens → underscores (idempotent). */
export function normalizeCrateName(name: string): string {
	return name.replace(HYPHEN_RE, '_');
}

/** Returns [underscore_form, hyphen_form] for registry lookups. */
export function crateNameVariants(name: string): [string, string] {
	const underscore = name.replace(HYPHEN_RE, '_');
	const hyphen = name.replace(UNDERSCORE_RE, '-');
	return [underscore, hyphen];
}
