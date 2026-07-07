<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Icon, KindBadge } from '$lib/components/design';
	import * as Command from '$lib/shadcn/ui/command';
	import { searchRegistry } from '$lib/rpc/crate.remote';
	import type { CrateSearchResult } from '$lib/schema';
	import { onMount } from 'svelte';

	type RemoteResource<T> =
		| Promise<T>
		| {
				run?: () => Promise<T>;
				current?: T;
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

	function isCrateResult(value: unknown): value is CrateSearchResult {
		if (!value || typeof value !== 'object') return false;
		const raw = value as Partial<CrateSearchResult>;
		return typeof raw.name === 'string' && typeof raw.version === 'string';
	}

	function crateKey(crate: CrateSearchResult): string {
		return `${crate.id ?? crate.name}:${crate.version}`;
	}

	function crateHref(crate: CrateSearchResult): string {
		return resolve(`/${encodeURIComponent(crate.id ?? crate.name)}/${encodeURIComponent(crate.version)}`);
	}

	async function resolveResource<T>(resource: RemoteResource<T>): Promise<T> {
		if (resource && typeof (resource as { run?: unknown }).run === 'function') {
			return await (resource as { run: () => Promise<T> }).run();
		}
		return await (resource as Promise<T>);
	}

	async function selectCrate(crate: CrateSearchResult) {
		open = false;
		query = '';
		results = [];
		await goto(crateHref(crate));
	}

	function close() {
		open = false;
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
			void resolveResource(searchRegistry({ q: term }) as RemoteResource<CrateSearchResult[]>)
				.then((value) => {
					if (seq !== searchSeq) return;
					results = Array.isArray(value) ? value.filter(isCrateResult) : [];
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

	onMount(() => {
		const handleKeydown = (event: KeyboardEvent) => {
			if (!open) return;
			if (event.key === 'Escape') {
				event.preventDefault();
				close();
			}
		};
		window.addEventListener('keydown', handleKeydown);
		return () => window.removeEventListener('keydown', handleKeydown);
	});
</script>

{#if open}
	<div class="fixed inset-0 z-50 grid place-items-start bg-black/35 px-3 pt-[12vh] backdrop-blur-sm sm:px-6">
		<button class="absolute inset-0 cursor-default" type="button" aria-label="Close search" onclick={close}></button>
		<div
			class="corner-squircle relative mx-auto w-full max-w-2xl overflow-hidden rounded-(--radius-card) border border-(--panel-border) bg-(--panel-solid) shadow-2xl"
			role="dialog"
			aria-modal="true"
			aria-label="Search crates"
		>
			<Command.Root shouldFilter={false} class="bg-(--panel-solid)">
				<Command.Input
					bind:value={query}
					autofocus
					placeholder="Search crates..."
					class="font-mono text-[13px]"
					aria-label="Search crates"
				/>
				<Command.List class="max-h-[420px]">
					{#if loading}
						<div class="flex items-center gap-2 px-4 py-5 text-sm text-(--muted)">
							<span class="size-3 animate-spin rounded-full border border-(--accent) border-t-transparent"></span>
							<span>Searching</span>
						</div>
					{:else if canSearch && results.length > 0}
						<Command.Group heading="Crates">
							{#each results as crate (crateKey(crate))}
								<Command.Item
									value={`${crate.name} ${crate.version} ${crate.description ?? ''}`}
									onSelect={() => void selectCrate(crate)}
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
									<Icon name="chevron-right" size={12} class="text-(--muted-soft)" />
								</Command.Item>
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
				<div class="flex items-center justify-between border-t border-(--panel-border-soft) px-3 py-2 text-[11px] text-(--muted-soft)">
					<span class="font-mono">Enter opens result</span>
					<span class="kbd">Esc</span>
				</div>
			</Command.Root>
		</div>
	</div>
{/if}
