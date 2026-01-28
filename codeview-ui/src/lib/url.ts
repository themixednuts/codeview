/**
 * Convert a node ID to a URL path using a version lookup map.
 * e.g. nodeUrl("drizzle_core::builder::OrderByClause", { drizzle_core: "0.1.4" })
 *   → "/drizzle_core/0.1.4/builder/OrderByClause"
 */
export function nodeUrl(nodeId: string, crateVersions: Record<string, string>): string {
	const parts = nodeId.split('::');
	const crate = parts[0];
	const version = crateVersions[crate] ?? 'latest';
	const path = parts.slice(1).join('/');
	return path ? `/${crate}/${version}/${path}` : `/${crate}/${version}`;
}

/**
 * Convert URL path params back to a node ID.
 * e.g. nodeIdFromPath("drizzle_core", "builder/OrderByClause") → "drizzle_core::builder::OrderByClause"
 */
export function nodeIdFromPath(crate: string, path?: string): string {
	if (!path) return crate;
	return `${crate}::${path.replace(/\//g, '::')}`;
}
