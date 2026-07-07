<script lang="ts">
	import { Icon, KindBadge } from '$lib/components/design';
	import * as Command from '$lib/shadcn/ui/command';
	import { getCrateVersions, searchRegistry } from '$lib/rpc/crate.remote';
	import type { CrateSearchResult } from '$lib/schema';
	import { normalizeCrateName } from '$lib/crate-names';
	import { isStdCrate, STD_JSON_CRATES } from '$lib/std';

	type RemoteResource<T> =
		| Promise<T>
		| {
				run?: () => Promise<T>;
				current?: T;
		  };

	const TOOLCHAIN_VERSIONS = ['stable', 'beta', 'nightly'];
	const TOOLCHAIN_DESCRIPTIONS: Record<string, string> = {
		std: 'Rust standard library',
		core: 'Rust core library',
		alloc: 'Rust allocation library',
		proc_macro: 'Rust procedural macro API',
		test: 'Rust test harness library',
	};
	const TOOLCHAIN_CRATES: CrateSearchResult[] = STD_JSON_CRATES.map((name) => ({
		id: name,
		name,
		version: 'stable',
		description: TOOLCHAIN_DESCRIPTIONS[name] ?? 'Rust library crate',
	}));

	let crateQuery = $state('');
	let crateResults = $state.raw<CrateSearchResult[]>([]);
	let selectedCrate = $state<CrateSearchResult | null>(null);
	let selectedVersion = $state('');
	let versions = $state.raw<string[]>([]);
	let searching = $state(false);
	let loadingVersions = $state(false);
	let searchSeq = 0;
	let versionSeq = 0;

	const trimmedQuery = $derived(crateQuery.trim());
	const toolchainResults = $derived(filterToolchainCrates(trimmedQuery));
	const canSubmit = $derived(Boolean(selectedCrate?.name && selectedVersion));

	function isCrateResult(value: unknown): value is CrateSearchResult {
		if (!value || typeof value !== 'object') return false;
		const raw = value as Partial<CrateSearchResult>;
		return typeof raw.name === 'string' && typeof raw.version === 'string';
	}

	function crateKey(crate: CrateSearchResult): string {
		return `${crate.id ?? crate.name}:${crate.version}`;
	}

	function isToolchainCrate(crate: CrateSearchResult | null): boolean {
		return !!crate && isStdCrate(normalizeCrateName(crate.name));
	}

	function filterToolchainCrates(term: string): CrateSearchResult[] {
		if (term.length < 2) return [];
		const needle = normalizeCrateName(term).toLowerCase();
		return TOOLCHAIN_CRATES.filter((crate) => {
			const normalized = normalizeCrateName(crate.name).toLowerCase();
			const hyphenated = normalized.replace(/_/g, '-');
			return (
				normalized.includes(needle) ||
				hyphenated.includes(term.toLowerCase()) ||
				(crate.description ?? '').toLowerCase().includes(term.toLowerCase())
			);
		});
	}

	async function resolveResource<T>(resource: RemoteResource<T>): Promise<T> {
		if (resource && typeof (resource as { run?: unknown }).run === 'function') {
			return await (resource as { run: () => Promise<T> }).run();
		}
		return await (resource as Promise<T>);
	}

	function selectCrate(crate: CrateSearchResult) {
		const seq = ++versionSeq;
		selectedCrate = crate;
		selectedVersion = crate.version;
		versions = crate.version ? [crate.version] : [];
		crateQuery = crate.name;
		if (isToolchainCrate(crate)) {
			versions = TOOLCHAIN_VERSIONS;
			selectedVersion = 'stable';
			loadingVersions = false;
			return;
		}
		loadingVersions = true;
		void resolveResource(getCrateVersions({ name: crate.name }) as RemoteResource<string[]>)
			.then((value) => {
				if (seq !== versionSeq) return;
				const nextVersions = Array.isArray(value)
					? value.filter((version): version is string => typeof version === 'string')
					: [];
				versions = nextVersions.length > 0 ? nextVersions : versions;
				selectedVersion = versions[0] ?? crate.version;
			})
			.catch(() => {
				if (seq === versionSeq) versions = crate.version ? [crate.version] : [];
			})
			.finally(() => {
				if (seq === versionSeq) loadingVersions = false;
			});
	}

	$effect(() => {
		const term = trimmedQuery;
		const seq = ++searchSeq;
		if (selectedCrate && term === selectedCrate.name) {
			crateResults = [];
			searching = false;
			return;
		}
		selectedCrate = null;
		selectedVersion = '';
		versions = [];
		if (term.length < 2) {
			crateResults = [];
			searching = false;
			return;
		}
		searching = true;
		const timer = setTimeout(() => {
			void resolveResource(searchRegistry({ q: term }) as RemoteResource<CrateSearchResult[]>)
				.then((value) => {
					if (seq !== searchSeq) return;
					crateResults = Array.isArray(value) ? value.filter(isCrateResult) : [];
				})
				.catch(() => {
					if (seq === searchSeq) crateResults = [];
				})
				.finally(() => {
					if (seq === searchSeq) searching = false;
				});
		}, 180);
		return () => clearTimeout(timer);
	});
</script>

<form method="POST" action="?/forceParse" class="grid gap-3">
	<input type="hidden" name="name" value={selectedCrate?.name ?? ''} />
	<input type="hidden" name="version" value={selectedVersion} />

	<div class="rounded-md border border-(--panel-border-soft) bg-(--panel-solid)">
		<Command.Root shouldFilter={false} class="bg-transparent">
			<Command.Input
				bind:value={crateQuery}
				placeholder="Search crate..."
				class="font-mono text-[13px]"
				aria-label="Search crate to force parse"
			/>
			<Command.List class="max-h-64">
				{#if searching && toolchainResults.length === 0}
					<div class="flex items-center gap-2 px-4 py-4 text-sm text-(--muted)">
						<span
							class="size-3 animate-spin rounded-full border border-(--accent) border-t-transparent"
						></span>
						<span>Searching</span>
					</div>
				{:else if selectedCrate}
					<div class="px-3 py-3">
						<div class="flex items-start gap-2 rounded-md bg-(--accent-soft) px-2.5 py-2">
							<KindBadge kind="crate" size={14} />
							<div class="min-w-0 flex-1">
								<div class="truncate font-mono text-[13px] font-semibold text-(--ink)">
									{selectedCrate.name}
								</div>
								{#if selectedCrate.description}
									<div class="mt-0.5 line-clamp-1 text-[11.5px] text-(--muted)">
										{selectedCrate.description}
									</div>
								{/if}
								{#if isToolchainCrate(selectedCrate)}
									<div class="mt-1 font-mono text-[10.5px] text-(--muted-soft)">
										stable · beta · nightly
									</div>
								{/if}
							</div>
						</div>
					</div>
				{:else if trimmedQuery.length >= 2 && (toolchainResults.length > 0 || crateResults.length > 0)}
					{#if toolchainResults.length > 0}
						<Command.Group heading="Rust">
							{#each toolchainResults as crate (crateKey(crate))}
								<Command.Item
									value={`${crate.name} ${crate.name.replace(/_/g, '-')} ${crate.description ?? ''}`}
									onSelect={() => selectCrate(crate)}
									class="cursor-pointer px-3 py-2.5"
								>
									<KindBadge kind="crate" size={14} />
									<div class="min-w-0 flex-1">
										<div class="flex min-w-0 items-baseline gap-2">
											<span class="truncate font-mono text-[13px] font-semibold text-(--ink)">
												{crate.name}
											</span>
											<span class="shrink-0 font-mono text-[10.5px] text-(--muted-soft)">
												stable · beta · nightly
											</span>
										</div>
										{#if crate.description}
											<p class="mt-0.5 line-clamp-1 text-[11.5px] text-(--muted)">
												{crate.description}
											</p>
										{/if}
									</div>
								</Command.Item>
							{/each}
						</Command.Group>
					{/if}
					{#if crateResults.length > 0}
						<Command.Group heading="Crates">
							{#each crateResults as crate (crateKey(crate))}
								<Command.Item
									value={`${crate.name} ${crate.version} ${crate.description ?? ''}`}
									onSelect={() => selectCrate(crate)}
									class="cursor-pointer px-3 py-2.5"
								>
									<KindBadge kind="crate" size={14} />
									<div class="min-w-0 flex-1">
										<div class="flex min-w-0 items-baseline gap-2">
											<span class="truncate font-mono text-[13px] font-semibold text-(--ink)">
												{crate.name}
											</span>
											<span class="shrink-0 font-mono text-[10.5px] text-(--muted-soft)">
												{crate.version}
											</span>
										</div>
										{#if crate.description}
											<p class="mt-0.5 line-clamp-1 text-[11.5px] text-(--muted)">
												{crate.description}
											</p>
										{/if}
									</div>
								</Command.Item>
							{/each}
						</Command.Group>
					{/if}
				{:else if trimmedQuery.length >= 2}
					<Command.Empty>No crates found</Command.Empty>
				{:else}
					<div class="px-4 py-5 text-center text-sm text-(--muted)">
						Type at least two characters
					</div>
				{/if}
			</Command.List>
		</Command.Root>
	</div>

	<div class="grid gap-2">
		<label
			class="text-[10px] font-semibold tracking-wider text-(--muted) uppercase"
			for="force-version"
		>
			Version
		</label>
		<select
			id="force-version"
			bind:value={selectedVersion}
			disabled={!selectedCrate || loadingVersions || versions.length === 0}
			class="corner-squircle h-9 rounded-(--radius-control) border border-(--panel-border) bg-(--panel-solid) px-3 font-mono text-sm text-(--ink) transition-colors outline-none focus:border-(--accent-ring) disabled:cursor-not-allowed disabled:text-(--muted-soft)"
		>
			{#if loadingVersions}
				<option value={selectedVersion}>Loading versions...</option>
			{:else if isToolchainCrate(selectedCrate)}
				{#each versions as version (version)}
					<option value={version}>{version}</option>
				{/each}
			{:else if versions.length > 0}
				{#each versions as version (version)}
					<option value={version}>{version}</option>
				{/each}
			{:else}
				<option value="">Select a crate first</option>
			{/if}
		</select>
	</div>

	<button
		type="submit"
		disabled={!canSubmit}
		class="corner-squircle inline-flex items-center justify-center gap-2 rounded-(--radius-control) border border-(--accent-ring) bg-(--accent) px-3 py-2 text-sm font-semibold text-(--on-accent) transition-colors hover:bg-(--accent-strong) disabled:cursor-not-allowed disabled:border-(--panel-border) disabled:bg-(--panel-strong) disabled:text-(--muted-soft)"
	>
		<Icon name="sparkle" size={13} />
		Force parse
	</button>
</form>
