// All toolchain crates not published on crates.io
export const STD_CRATES = new Set([
	'std',
	'core',
	'alloc',
	'proc_macro',
	'test',
	'compiler_builtins',
	'rustc_std_workspace_alloc',
	'rustc_std_workspace_core',
	'std_detect',
	'panic_unwind',
	'panic_abort',
	'unwind'
]);

// Subset that ships rustdoc JSON via the `rust-docs-json` component
export const STD_JSON_CRATES = ['std', 'core', 'alloc', 'proc_macro', 'test'];

export const RUST_CHANNELS = new Set(['stable', 'nightly', 'beta']);

export function isStdCrate(name: string): boolean {
	return STD_CRATES.has(name);
}

export function isRustChannel(version: string): boolean {
	return RUST_CHANNELS.has(version);
}
