<script lang="ts">
	import Icon from '$lib/components/design/Icon.svelte';
	import KindBadge from '$lib/components/design/KindBadge.svelte';
	import * as Command from '$lib/shadcn/ui/command';
	import { Button } from '$lib/shadcn/ui/button';
	import * as Field from '$lib/shadcn/ui/field';
	import * as NativeSelect from '$lib/shadcn/ui/native-select';
	import { getCrateVersions, searchRegistry } from '$lib/rpc/crate.remote';
	import type { CrateSearchResult } from '$lib/schema';
	import { normalizeCrateName } from '$lib/crate-names';
	import { DEFAULT_RUST_CHANNEL, isRustChannel, isStdCrate, RUST_CHANNEL_ORDER } from '$lib/std';

	type RemoteResource<T> =
		| Promise<T>
		| {
				run?: () => Promise<T>;
				current?: T;
		  };

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
	const toolchainResults = $derived(crateResults.filter((crate) => isToolchainCrate(crate)));
	const registryResults = $derived(crateResults.filter((crate) => !isToolchainCrate(crate)));

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
			versions = [...RUST_CHANNEL_ORDER];
			selectedVersion = isRustChannel(crate.version) ? crate.version : DEFAULT_RUST_CHANNEL;
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
	<div class="rounded-md border border-(--panel-border-soft) bg-(--panel-solid)">
		<Command.Root shouldFilter={false} class="bg-transparent">
			<Command.Input
				bind:value={crateQuery}
				name="name"
				placeholder="Search crate..."
				class="font-mono text-sm"
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
								<div class="truncate font-mono text-sm font-semibold text-(--ink)">
									{selectedCrate.name}
								</div>
								{#if selectedCrate.description}
									<div class="mt-0.5 line-clamp-1 text-xs text-(--muted)">
										{selectedCrate.description}
									</div>
								{/if}
								{#if isToolchainCrate(selectedCrate)}
									<div class="mt-1 font-mono text-xs text-(--muted-soft)">
										{selectedVersion} toolchain
									</div>
								{/if}
							</div>
						</div>
					</div>
				{:else if trimmedQuery.length >= 2 && (toolchainResults.length > 0 || registryResults.length > 0)}
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
											<span class="truncate font-mono text-sm font-semibold text-(--ink)">
												{crate.name}
											</span>
											<span class="shrink-0 font-mono text-xs text-(--muted-soft)">
												{crate.version}
											</span>
										</div>
										{#if crate.description}
											<p class="mt-0.5 line-clamp-1 text-xs text-(--muted)">
												{crate.description}
											</p>
										{/if}
									</div>
								</Command.Item>
							{/each}
						</Command.Group>
					{/if}
					{#if registryResults.length > 0}
						<Command.Group heading="Crates">
							{#each registryResults as crate (crateKey(crate))}
								<Command.Item
									value={`${crate.name} ${crate.version} ${crate.description ?? ''}`}
									onSelect={() => selectCrate(crate)}
									class="cursor-pointer px-3 py-2.5"
								>
									<KindBadge kind="crate" size={14} />
									<div class="min-w-0 flex-1">
										<div class="flex min-w-0 items-baseline gap-2">
											<span class="truncate font-mono text-sm font-semibold text-(--ink)">
												{crate.name}
											</span>
											<span class="shrink-0 font-mono text-xs text-(--muted-soft)">
												{crate.version}
											</span>
										</div>
										{#if crate.description}
											<p class="mt-0.5 line-clamp-1 text-xs text-(--muted)">
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

	<Field.Field class="js-only">
		<Field.Label for="force-version">Version</Field.Label>
		<NativeSelect.Root
			id="force-version"
			name="version"
			bind:value={selectedVersion}
			disabled={!selectedCrate || loadingVersions || versions.length === 0}
			class="w-full font-mono"
		>
			{#if loadingVersions}
				<NativeSelect.Option value={selectedVersion}>Loading versions...</NativeSelect.Option>
			{:else if isToolchainCrate(selectedCrate)}
				{#each versions as version (version)}
					<NativeSelect.Option value={version}>{version}</NativeSelect.Option>
				{/each}
			{:else if versions.length > 0}
				{#each versions as version (version)}
					<NativeSelect.Option value={version}>{version}</NativeSelect.Option>
				{/each}
			{:else}
				<NativeSelect.Option value="">Select a crate first</NativeSelect.Option>
			{/if}
		</NativeSelect.Root>
	</Field.Field>

	<noscript>
		<div class="grid gap-2">
			<label for="force-version-fallback" class="text-sm font-medium">Version</label>
			<input
				id="force-version-fallback"
				name="version"
				value="latest"
				class="h-8 w-full rounded-lg border border-(--panel-border) bg-transparent px-2.5 font-mono text-sm"
			/>
			<p class="text-xs text-(--muted)">Enter an exact version or use latest.</p>
		</div>
	</noscript>

	<Button type="submit">
		<Icon name="sparkle" size={13} />
		Force parse
	</Button>
</form>
