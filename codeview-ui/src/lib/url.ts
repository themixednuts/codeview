import { isStdCrate } from '$lib/std';

/**
 * Convert a node ID to a URL path using a version lookup map.
 * e.g. nodeUrl("drizzle_core::builder::OrderByClause", { drizzle_core: "0.1.4" })
 *   → "/drizzle_core/0.1.4/builder/OrderByClause"
 */
export function nodeUrl(nodeId: string, crateVersions: Record<string, string>): string {
	const parts = nodeId.split('::');
	const crate = parts[0];
	const routeCrate = crate.replace(/_/g, '-');
	const version = crateVersions[crate] ?? (isStdCrate(crate) ? 'stable' : 'latest');
	const path = parts.slice(1).join('/');
	return path ? `/${routeCrate}/${version}/${path}` : `/${routeCrate}/${version}`;
}

/**
 * Convert URL path params back to a node ID.
 * e.g. nodeIdFromPath("drizzle_core", "builder/OrderByClause") → "drizzle_core::builder::OrderByClause"
 */
export function nodeIdFromPath(crate: string, path?: string): string {
	const normalizedCrate = crate.replace(/-/g, '_');
	if (!path) return normalizedCrate;
	return `${normalizedCrate}::${path.replace(/\//g, '::')}`;
}
