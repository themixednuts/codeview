<script lang="ts">
	import { resolve } from '$app/paths';
	import Icon from '#lib/components/design/Icon.svelte';
	import KindBadge from '#lib/components/design/KindBadge.svelte';
	import * as Command from '#lib/components/ui/command/index.js';
	import { searchRegistry } from '#lib/rpc/crate.remote.js';
	import type { CrateSearchResult } from '#lib/schema.js';
	import * as Predicate from 'effect/Predicate';

	type RunnableResource<T> = {
		run: () => Promise<T>;
	};

	let {
		open = $bindable(false),
	}: {
		open: boolean;
	} = $props();

	let query = $state('');
	let results = $state.raw<CrateSearchResult[]>([]);
	let loading = $state(false);
	let searchSeq = 0;

	const trimmedQuery = $derived(query.trim());
	const canSearch = $derived(trimmedQuery.length >= 2);

	function crateKey(crate: CrateSearchResult): string {
		return `${crate.id ?? crate.name}:${crate.version}`;
	}

	function crateHref(crate: CrateSearchResult): string {
		return resolve('/[crate]/[version]', {
			crate: crate.id ?? crate.name,
			version: crate.version,
		});
	}

	function hasRun<T>(resource: Promise<T> | RunnableResource<T>): resource is RunnableResource<T> {
		return Predicate.isObject(resource) && 'run' in resource && Predicate.isFunction(resource.run);
	}

	async function resolveResource<T>(resource: Promise<T> | RunnableResource<T>): Promise<T> {
		if (hasRun(resource)) return await resource.run();
		return await resource;
	}

	function closeCommand() {
		open = false;
		query = '';
		results = [];
	}

	$effect(() => {
		if (!open) return;
		const term = trimmedQuery;
		const seq = ++searchSeq;
		if (term.length < 2) {
			results = [];
			loading = false;
			return;
		}
		loading = true;
		const timer = setTimeout(() => {
			void resolveResource(searchRegistry({ q: term }))
				.then((value) => {
					if (seq !== searchSeq) return;
					results = Array.isArray(value) ? value : [];
				})
				.catch(() => {
					if (seq === searchSeq) results = [];
				})
				.finally(() => {
					if (seq === searchSeq) loading = false;
				});
		}, 180);
		return () => clearTimeout(timer);
	});
</script>

<Command.Dialog
	bind:open
	title="Search crates"
	description="Search crates.io and Rust toolchain crates."
	shouldFilter={false}
	class="max-w-2xl"
>
	<Command.Input
		bind:value={query}
		autofocus
		placeholder="Search crates..."
		class="font-mono text-sm"
		aria-label="Search crates"
	/>
	<Command.List class="max-h-[420px]">
		{#if loading}
			<div class="flex items-center gap-2 px-4 py-5 text-sm text-(--muted)">
				<span
					class="size-3 animate-spin rounded-full border border-(--accent) border-t-transparent"
				></span>
				<span>Searching</span>
			</div>
		{:else if canSearch && results.length > 0}
			<Command.Group heading="Crates">
				{#each results as crate (crateKey(crate))}
					<Command.LinkItem
						href={crateHref(crate)}
						value={`${crate.name} ${crate.version} ${crate.description ?? ''}`}
						onclick={closeCommand}
						class="cursor-pointer px-3 py-2.5 no-underline"
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
						<Icon name="chevron-right" size={12} class="text-(--muted-soft)" />
					</Command.LinkItem>
				{/each}
			</Command.Group>
		{:else if canSearch}
			<Command.Empty>No crates found</Command.Empty>
		{:else}
			<div class="px-4 py-8 text-center">
				<Icon name="search" size={18} class="text-(--muted-soft)" />
				<p class="mt-2 text-sm text-(--muted)">Type a crate name</p>
			</div>
		{/if}
	</Command.List>
	<div
		class="flex items-center justify-between border-t border-(--panel-border-soft) px-3 py-2 text-xs text-(--muted-soft)"
	>
		<span class="font-mono">Enter opens result</span>
		<span class="kbd">Esc</span>
	</div>
</Command.Dialog>
