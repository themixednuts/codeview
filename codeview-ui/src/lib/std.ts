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
	'unwind',
]);

// Subset whose rustdoc JSON is indexed from the Rust toolchain
export const STD_JSON_CRATES = ['std', 'core', 'alloc', 'proc_macro', 'test'] as const;

export const RUST_CHANNEL_ORDER = ['stable', 'beta', 'nightly'] as const;
export type RustChannel = (typeof RUST_CHANNEL_ORDER)[number];
export const DEFAULT_RUST_CHANNEL: RustChannel = 'stable';
export const RUST_CHANNELS: ReadonlySet<RustChannel> = new Set(RUST_CHANNEL_ORDER);

const TOOLCHAIN_CRATE_DESCRIPTIONS: Record<(typeof STD_JSON_CRATES)[number], string> = {
	std: 'Rust standard library',
	core: 'Rust core library',
	alloc: 'Rust allocation library',
	proc_macro: 'Rust procedural macro API',
	test: 'Rust test harness library',
};

export type ToolchainCrateSearchResult = {
	id: string;
	name: (typeof STD_JSON_CRATES)[number];
	version: RustChannel;
	description: string;
};

export function isStdCrate(name: string): boolean {
	return STD_CRATES.has(name);
}

export function isStdJsonCrate(name: string): name is (typeof STD_JSON_CRATES)[number] {
	return (STD_JSON_CRATES as readonly string[]).includes(name);
}

export function isRustChannel(version: string): boolean {
	return RUST_CHANNELS.has(version as RustChannel);
}

function normalizedToolchainQuery(query: string): {
	needle: string;
	channel?: RustChannel;
} {
	let value = query
		.trim()
		.toLowerCase()
		.replace(/proc[\s-]+macro/g, 'proc_macro');
	let channel: RustChannel | undefined;
	const channelMatch = value.match(/(?:^|[@:\s])(stable|beta|nightly)$/);
	if (channelMatch) {
		channel = channelMatch[1] as RustChannel;
		value = value.slice(0, channelMatch.index).trim();
	}
	return {
		needle: value.replace(/[\s-]+/g, '_'),
		channel,
	};
}

/** Search the five rustdoc toolchain crates, optionally qualified as `crate@channel`. */
export function searchToolchainCrates(query: string): ToolchainCrateSearchResult[] {
	const { needle, channel } = normalizedToolchainQuery(query);
	if (!needle && !channel) return [];
	const channels = channel ? [channel] : RUST_CHANNEL_ORDER;

	return STD_JSON_CRATES.flatMap((name) => {
		const description = TOOLCHAIN_CRATE_DESCRIPTIONS[name];
		const searchable = `${name} ${name.replace(/_/g, '-')} ${description}`.toLowerCase();
		if (needle && !name.includes(needle) && !searchable.includes(needle.replace(/_/g, ' '))) {
			return [];
		}
		return channels.map((version) => ({
			id: name.replace(/_/g, '-'),
			name,
			version,
			description: `${description} (${version})`,
		}));
	});
}
