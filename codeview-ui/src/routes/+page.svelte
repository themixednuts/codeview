<script lang="ts">
	import { Debounced } from 'runed';
	import { LoaderCircleIcon, SearchIcon, ArrowRightIcon, ClockIcon } from '@lucide/svelte';
	import { searchRegistry } from '$lib/rpc/crate.remote';
	import { resolve } from '$app/paths';
	import { kindColors, kindIcons } from '$lib/tree';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const workspaceCrates = $derived(data.workspaceCrates);
	const topCratesPromise = $derived(data.topCrates);

	let searchInput = $state('');
	const searchTerm = $derived(searchInput.trim());
	const debouncedSearch = new Debounced(() => searchTerm, 250);
	const debouncedTerm = $derived(debouncedSearch.current);

	// True while the user is typing but debounce hasn't fired yet
	const isDebouncing = $derived(searchTerm.length >= 2 && searchTerm !== debouncedTerm);

	const searchQuery = $derived(
		debouncedTerm.length >= 2 ? searchRegistry({ q: debouncedTerm }) : null,
	);
	const showSearchResults = $derived(searchTerm.length >= 2);

	const EXAMPLES = ['tokio::spawn', 'Vec<T>', 'axum::Router', 'std::sync::Arc'];

	function fillExample(t: string) {
		searchInput = t;
	}
</script>

<div class="flex flex-1 overflow-auto">
	<main class="mx-auto w-full max-w-[1080px] px-8 pt-12 pb-12">
		<!-- ════════════════════════════════════════════
		     HERO — calm, type-driven
		     ════════════════════════════════════════════ -->
		<section>
			<!-- Pill: codeview build tag -->
			<div
				class="inline-flex items-center gap-2 rounded-full border border-(--accent-ring) bg-(--accent-soft) px-2.5 py-1"
			>
				<span class="size-1.5 rounded-full bg-(--accent)"></span>
				<span
					class="font-mono text-[10.5px] font-medium tracking-wider text-(--accent) uppercase"
				>
					codeview · faster index, cross-crate jump
				</span>
			</div>

			<h1
				class="font-display mt-5 leading-[1.04] tracking-tight text-(--ink)"
				style="font-size: clamp(2.5rem, 5.6vw, 3.5rem); font-weight: 500; max-width: 760px;"
			>
				A faster, friendlier<br />
				<span style="color: var(--accent); font-style: italic;">rustdoc</span> for the web.
			</h1>

			<p class="mt-4 max-w-[560px] text-[14px] leading-relaxed text-(--muted)">
				Browse every public item, jump between crates, and see how types relate — without the
				page reload.
			</p>

			<!-- SEARCH -->
			<div class="mt-7 max-w-[640px]">
				<div
					class="search-enter corner-squircle relative rounded-(--radius-control) border border-(--panel-border-strong) bg-(--panel-solid) shadow-(--shadow-strong) transition-all focus-within:border-(--accent) focus-within:shadow-(--shadow-glow) focus-within:ring-1 focus-within:ring-(--accent)"
				>
					<SearchIcon
						class="absolute top-1/2 left-3.5 -translate-y-1/2 text-(--muted)"
						size={15}
					/>
					<input
						id="global-search"
						type="search"
						placeholder="serde::Deserialize"
						bind:value={searchInput}
						class="w-full bg-transparent py-3 pr-28 pl-10 font-mono text-[13.5px] text-(--ink) outline-none placeholder:text-(--muted-soft)"
					/>
					<div class="absolute top-1/2 right-3 flex -translate-y-1/2 items-center gap-1">
						<span class="kbd">⌘</span><span class="kbd">K</span>
					</div>
				</div>
				<div class="mt-2.5 flex flex-wrap items-center gap-2 text-[11px] text-(--muted-soft)">
					<span>Examples</span>
					{#each EXAMPLES as t (t)}
						<button
							type="button"
							class="font-mono rounded bg-(--panel-muted) px-1.5 py-0.5 hover:text-(--accent)"
							onclick={() => fillExample(t)}
						>
							{t}
						</button>
					{/each}
				</div>

				{#if showSearchResults}
					<div
						class="corner-squircle relative z-30 mt-2 rounded-(--radius-card) border border-(--panel-border) bg-(--panel-solid) p-2 shadow-(--shadow-strong)"
					>
						{#if isDebouncing}
							<div class="flex items-center gap-2 px-3 py-2.5 text-xs text-(--muted)">
								<LoaderCircleIcon class="animate-spin" size={12} />
								Searching...
							</div>
						{:else if searchQuery}
							<svelte:boundary>
								{@const results = (await searchQuery).slice(0, 6)}
								{#if results.length > 0}
									<div class="space-y-0.5">
										{#each results as result (result.id ?? result.name)}
											<a
												href={resolve(`/${result.id ?? result.name}/${result.version}`)}
												data-sveltekit-preload-data="off"
												class="group corner-squircle flex items-center gap-3 rounded-(--radius-chip) px-3 py-2.5 transition-colors hover:bg-(--panel-strong)"
											>
												<div class="min-w-0 flex-1">
													<p class="text-sm font-medium text-(--ink)">{result.name}</p>
													{#if result.description}
														<p class="mt-0.5 truncate text-xs text-(--muted)">
															{result.description}
														</p>
													{/if}
												</div>
												<div class="flex shrink-0 items-center gap-2">
													<span class="badge badge-sm">{result.version}</span>
													<ArrowRightIcon
														class="-translate-x-1 text-(--muted) opacity-0 transition-all duration-150 group-hover:translate-x-0 group-hover:opacity-70"
														size={12}
													/>
												</div>
											</a>
										{/each}
									</div>
								{:else}
									<div class="px-3 py-2.5 text-xs text-(--muted)">No matches found.</div>
								{/if}
								{#snippet pending()}
									<div class="flex items-center gap-2 px-3 py-2.5 text-xs text-(--muted)">
										<LoaderCircleIcon class="animate-spin" size={12} />
										Searching...
									</div>
								{/snippet}
							</svelte:boundary>
						{/if}
					</div>
				{/if}
			</div>
		</section>

		<!-- ════════════════════════════════════════════
		     WORKSPACE — pill row of local crates
		     ════════════════════════════════════════════ -->
		{#if workspaceCrates.length > 0}
			{@const CrateIcon = kindIcons.Crate}
			<section class="mt-10">
				<div class="mb-3 flex items-center justify-between">
					<div class="flex items-center gap-2">
						<span class="size-1.5 rounded-full bg-(--accent)"></span>
						<span
							class="font-mono text-[10.5px] font-semibold tracking-[0.18em] text-(--ink-soft) uppercase"
						>
							workspace
						</span>
						<span class="font-mono text-[11px] text-(--muted-soft)">
							{workspaceCrates.length} crate{workspaceCrates.length === 1 ? '' : 's'}
						</span>
					</div>
				</div>
				<div class="flex flex-wrap gap-1.5">
					{#each workspaceCrates as crate (crate.id)}
						<a
							href={resolve(`/${crate.id}/${crate.version}`)}
							data-sveltekit-preload-data="off"
							class="group corner-squircle inline-flex items-center gap-2 rounded-(--radius-control) border border-(--panel-border) bg-(--panel) px-2.5 py-1.5 transition-colors hover:border-(--accent-ring) hover:bg-(--panel-strong)"
						>
							<span
								class="kind-glyph"
								style="background: {kindColors.Crate}; width: 14px; height: 14px; font-size: 9px;"
							>
								C
							</span>
							<span class="font-mono text-[12.5px] font-medium text-(--ink)">
								{crate.name}
							</span>
							<span class="font-mono text-[10.5px] text-(--muted-soft)">{crate.version}</span>
						</a>
					{/each}
				</div>
			</section>
		{/if}

		<!-- ════════════════════════════════════════════
		     EXPLORE — trending grid (real data)
		     ════════════════════════════════════════════ -->
		<section class="mt-10">
			<div class="mb-3 flex items-center justify-between">
				<h2 class="font-display text-[18px] font-semibold text-(--ink)">
					Explore
				</h2>
				<span class="font-mono text-[11px] text-(--muted)">popular crates →</span>
			</div>
			<svelte:boundary>
				{#await topCratesPromise}
					<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
						{#each Array.from({ length: 6 }) as _, i (i)}
							<div
								class="corner-squircle rounded-(--radius-card) border border-(--panel-border) bg-(--panel) px-4 py-3.5 opacity-80"
							>
								<div class="h-4 w-24 rounded bg-(--panel-strong)"></div>
								<div class="mt-3 h-3 w-32 rounded bg-(--panel-strong)"></div>
							</div>
						{/each}
					</div>
				{:then topCrates}
					{#if topCrates.length > 0}
						<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
							{#each topCrates as crate (crate.id)}
								<a
									href={resolve(`/${crate.id}/${crate.version}`)}
									data-sveltekit-preload-data="off"
									class="group corner-squircle block rounded-(--radius-card) border border-(--panel-border) bg-(--panel) px-4 py-3.5 transition-all hover:-translate-y-0.5 hover:border-(--accent-ring) hover:bg-(--panel-strong) hover:shadow-(--shadow-soft)"
								>
									<div class="flex items-start justify-between gap-3">
										<div class="min-w-0">
											<div class="flex items-baseline gap-2">
												<span
													class="kind-glyph"
													style="background: {kindColors.Crate}; width: 14px; height: 14px; font-size: 9px;"
												>
													C
												</span>
												<span class="font-mono text-[14px] font-semibold text-(--ink)">
													{crate.name}
												</span>
												<span class="font-mono text-[10.5px] text-(--muted-soft)">
													{crate.version}
												</span>
											</div>
											{#if crate.description}
												<p class="mt-2 line-clamp-2 text-[12.5px] leading-snug text-(--muted)">
													{crate.description}
												</p>
											{/if}
										</div>
										<ArrowRightIcon
											class="-translate-x-1 text-(--muted) opacity-0 transition-all duration-150 group-hover:translate-x-0 group-hover:opacity-70"
											size={14}
										/>
									</div>
								</a>
							{/each}
						</div>
					{:else}
						<div
							class="corner-squircle flex flex-col items-center gap-2 rounded-(--radius-card) border border-(--panel-border) bg-(--panel) py-10"
						>
							<p class="text-sm font-medium text-(--ink)">No crates available</p>
							<p class="text-xs text-(--muted)">Search for a crate above to get started.</p>
						</div>
					{/if}
				{/await}
			</svelte:boundary>
		</section>

		<!-- ════════════════════════════════════════════
		     FOOT — quiet meta
		     ════════════════════════════════════════════ -->
		<footer
			class="mt-16 flex items-center justify-between border-t border-(--panel-border-soft) pt-5 text-[11px] text-(--muted-soft)"
		>
			<div class="flex items-center gap-2">
				<ClockIcon size={11} />
				<span class="font-mono">Live index — last refreshed on page load</span>
			</div>
			<a
				href="https://github.com/jonfontaine/codeview"
				target="_blank"
				rel="noopener noreferrer"
				class="ulink"
			>
				source
			</a>
		</footer>
	</main>
</div>

<style>
	.search-enter {
		animation: hero-fade 0.5s ease-out 0.55s backwards;
	}

	@keyframes hero-fade {
		from {
			opacity: 0;
			transform: translateY(20px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
</style>
