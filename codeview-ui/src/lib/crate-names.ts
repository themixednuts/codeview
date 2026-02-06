const UNDERSCORE_RE = /_/g;
const HYPHEN_RE = /-/g;

/** Canonical Rust crate name: hyphens -> underscores (idempotent). */
export function normalizeCrateName(name: string): string {
	return name.replace(HYPHEN_RE, '_');
}

/** URL/storage convention: underscores -> hyphens (idempotent). */
export function hyphenateCrateName(name: string): string {
	return name.replace(UNDERSCORE_RE, '-');
}

/** Returns [underscore_form, hyphen_form] for registry lookups. */
export function crateNameVariants(name: string): [string, string] {
	return [name.replace(HYPHEN_RE, '_'), name.replace(UNDERSCORE_RE, '-')];
}
