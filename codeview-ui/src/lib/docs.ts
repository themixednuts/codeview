import type { NodeKind } from '$lib/graph';
import { isStdCrate } from '$lib/std';

/** Map NodeKind to the rustdoc URL kind prefix (e.g. struct.Foo.html) */
function kindPrefix(kind: NodeKind): string | null {
	switch (kind) {
		case 'Struct':
			return 'struct';
		case 'Enum':
			return 'enum';
		case 'Trait':
			return 'trait';
		case 'Function':
			return 'fn';
		case 'Method':
			return 'fn';
		case 'TypeAlias':
			return 'type';
		case 'Union':
			return 'union';
		case 'TraitAlias':
			return 'traitalias';
		case 'Module':
			return null; // modules use index.html
		case 'Crate':
			return null; // crates use index.html
		case 'Impl':
			return null; // impls don't have standalone pages
		default:
			return null;
	}
}

/**
 * Build an external documentation URL (docs.rs or doc.rust-lang.org).
 * Used when external link mode is set to "docs".
 *
 * @param nodeId  Fully-qualified path like "core::clone::Clone"
 * @param kind    Optional NodeKind for the target — enables kind-prefixed URLs
 * @param version Optional version string (defaults to "latest" / "stable")
 */
export function externalDocsUrl(
	nodeId: string,
	kind?: NodeKind,
	version?: string
): string {
	const parts = nodeId.split('::');
	const crate = parts[0];
	if (!crate) return `https://docs.rs/${nodeId}`;

	const isStd = isStdCrate(crate);
	// doc.rust-lang.org accepts exact versions ("1.91.0"), channels ("stable",
	// "nightly"), and suffixed versions ("1.85.0-nightly").  Pass through whatever
	// version we have; fall back to "stable" when unknown.
	const baseVersion = isStd ? (version ?? 'stable') : (version ?? 'latest');
	const baseUrl = isStd
		? `https://doc.rust-lang.org/${baseVersion}/${crate}`
		: `https://docs.rs/${crate}/${baseVersion}/${crate}`;

	// Crate root
	if (parts.length <= 1) {
		return `${baseUrl}/index.html`;
	}

	// Build module path (everything except the last segment)
	const modulePath = parts.slice(1, -1).join('/');
	const itemName = parts[parts.length - 1];
	const prefix = kind ? kindPrefix(kind) : null;

	if (prefix) {
		// Kind-prefixed URL: .../module/struct.Name.html
		const modulePrefix = modulePath ? `${modulePath}/` : '';
		return `${baseUrl}/${modulePrefix}${prefix}.${itemName}.html`;
	}

	if (kind === 'Module' || kind === 'Crate') {
		// Module: .../module/submodule/index.html
		const fullPath = parts.slice(1).join('/');
		return `${baseUrl}/${fullPath}/index.html`;
	}

	// Fallback: no kind info — use path-only URL (docs.rs will resolve)
	const fullPath = parts.slice(1).join('/');
	return isStd
		? `${baseUrl}/${fullPath}/index.html`
		: `${baseUrl}/${fullPath}/`;
}

