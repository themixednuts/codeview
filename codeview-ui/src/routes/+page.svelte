<script lang="ts">
	import { resolve } from '$app/paths';
	import { Icon, KindBadge } from '$lib/components/design';
	import { searchRegistry } from '$lib/rpc/crate.remote';
	import type { CrateSearchResult, CrateSummary } from '$lib/schema';
	import { Debounced } from 'runed';
	import type { PageProps } from './$types';

	type CrateListItem = CrateSearchResult | CrateSummary;
	type SectionId = 'workspace' | 'popular';

	let { data }: PageProps = $props();

	const workspaceCrates = $derived(data.workspaceCrates);
	const topCratesPromise = $derived(data.topCrates);

	let selectedSection = $state<SectionId>('workspace');
	let searchInput = $state('');

	const searchTerm = $derived(searchInput.trim());
	const debouncedSearch = new Debounced(() => searchTerm, 250);
	const debouncedTerm = $derived(debouncedSearch.current);
	const isDebouncing = $derived(searchTerm.length >= 2 && searchTerm !== debouncedTerm);
	const showSearchResults = $derived(searchTerm.length >= 2);
	const visibleSection = $derived(showSearchResults ? 'search' : selectedSection);
	const searchQuery = $derived(
		debouncedTerm.length >= 2 ? searchRegistry({ q: debouncedTerm }) : null,
	);

	const sidebarSections = $derived([
		{
			id: 'workspace' as const,
			label: 'Workspace',
			meta: `${workspaceCrates.length} crate${workspaceCrates.length === 1 ? '' : 's'}`,
			icon: 'layers' as const,
		},
		{
			id: 'popular' as const,
			label: 'Popular',
			meta: 'registry',
			icon: 'trending' as const,
		},
	]);

	function crateHref(crate: CrateListItem) {
		return resolve(`/${crate.id ?? crate.name}/${crate.version}`);
	}

	function crateKey(crate: CrateListItem) {
		return `${crate.id ?? crate.name}:${crate.version}`;
	}
</script>

<div class="flex flex-1 overflow-auto">
	<main class="w-full">
		<div class="border-b border-(--panel-border-soft)">
			<div class="mx-auto flex max-w-[1180px] flex-col gap-3 px-4 py-4 sm:px-6 lg:px-8">
				<div
					class="corner-squircle relative rounded-(--radius-control) border border-(--panel-border) bg-(--panel-solid) shadow-(--shadow-soft) transition-all focus-within:border-(--accent) focus-within:shadow-(--shadow-glow) focus-within:ring-1 focus-within:ring-(--accent)"
				>
					<span
						class="absolute top-1/2 left-3.5 -translate-y-1/2 text-(--muted)"
						aria-hidden="true"
					>
						<Icon name="search" size={14} />
					</span>
					<input
						id="home-library-search"
						type="search"
						aria-label="Search registry crates"
						placeholder="Search registry crates..."
						bind:value={searchInput}
						class="w-full bg-transparent py-2.5 pr-20 pl-10 font-mono text-[13px] text-(--ink) outline-none placeholder:text-(--muted-soft)"
					/>
					<div
						class="absolute top-1/2 right-3 hidden -translate-y-1/2 items-center gap-1 sm:flex"
						aria-hidden="true"
					>
						<span class="kbd">⌘</span>
						<span class="kbd">K</span>
					</div>
				</div>
				<div class="flex flex-wrap items-center gap-2 text-[12px] text-(--muted)">
					<span>Showing</span>
					<span class="badge badge-sm bg-(--panel) text-(--ink)">
						{visibleSection === 'search'
							? 'search results'
							: visibleSection === 'workspace'
								? 'workspace'
								: 'popular crates'}
					</span>
					<span class="text-(--muted-soft)" aria-hidden="true">·</span>
					<span class="font-mono">
						{visibleSection === 'workspace'
							? `${workspaceCrates.length} local`
							: visibleSection === 'search'
								? searchTerm
								: 'deferred registry'}
					</span>
				</div>
			</div>
		</div>

		<div
			class="mx-auto grid w-full max-w-[1180px] gap-8 px-4 py-8 sm:px-6 lg:grid-cols-[260px_minmax(0,1fr)] lg:gap-10 lg:px-8"
		>
			<aside class="min-w-0">
				<div class="mb-3 flex items-center justify-between">
					<h1
						class="text-[10.5px] font-semibold tracking-[0.22em] text-(--ink-soft) uppercase"
					>
						Browse
					</h1>
				</div>
				<ul class="space-y-0.5">
					{#if showSearchResults}
						<li>
							<div
								class="group flex items-center gap-3 rounded-md px-2.5 py-1.5 text-(--accent-strong)"
								style="background: var(--accent-soft)"
								aria-current="true"
							>
								<span class="grid w-5 place-items-center text-(--accent)" aria-hidden="true">
									<Icon name="search" size={13} />
								</span>
								<span class="min-w-0 flex-1 truncate text-[13px] font-medium">Search results</span>
								<span class="font-mono text-[11px] text-(--muted-soft)">live</span>
							</div>
						</li>
					{/if}
					{#each sidebarSections as section (section.id)}
						<li>
							<button
								type="button"
								class={`group flex w-full items-center gap-3 rounded-md px-2.5 py-1.5 text-left transition hover:bg-(--panel-muted) hover:text-(--ink) ${
									visibleSection === section.id
										? 'bg-(--accent-soft) text-(--accent-strong)'
										: 'text-(--ink)'
								}`}
								aria-current={visibleSection === section.id ? 'true' : undefined}
								onclick={() => (selectedSection = section.id)}
							>
								<span
									class={`grid w-5 place-items-center ${
										visibleSection === section.id ? 'text-(--accent)' : 'text-(--muted-soft)'
									}`}
									aria-hidden="true"
								>
									<Icon name={section.icon} size={13} />
								</span>
								<span class="min-w-0 flex-1 truncate text-[13px] font-medium">
									{section.label}
								</span>
								<span class="font-mono text-[11px] text-(--muted-soft)">
									{section.meta}
								</span>
							</button>
						</li>
					{/each}
				</ul>

				<div
					class="corner-squircle mt-7 rounded-(--radius-card) border border-(--panel-border-soft) bg-(--panel) p-4"
				>
					<div
						class="mb-2 text-[10.5px] font-semibold tracking-[0.22em] text-(--ink-soft) uppercase"
					>
						Data sources
					</div>
					<div class="space-y-2 text-[12px] text-(--muted)">
						<div class="flex items-center justify-between gap-3">
							<span>Workspace</span>
							<span class="font-mono text-(--ink-soft)">{workspaceCrates.length}</span>
						</div>
						<div class="flex items-center justify-between gap-3">
							<span>Registry</span>
							<span class="font-mono text-(--ink-soft)">search + top</span>
						</div>
					</div>
				</div>
			</aside>

			<section class="min-w-0">
				{#if visibleSection === 'search'}
					<div class="mb-3 flex items-center justify-between gap-3">
						<div class="flex min-w-0 items-center gap-2">
							<Icon name="search" size={13} class="text-(--accent)" />
							<h2 class="font-display text-[18px] font-semibold text-(--ink)">
								Registry search
							</h2>
						</div>
						<span class="truncate font-mono text-[11px] text-(--muted-soft)">
							{searchTerm}
						</span>
					</div>

					{#if isDebouncing}
						<div class="space-y-2">
							{#each Array.from({ length: 4 }) as _, i (i)}
								<div
									class="corner-squircle rounded-(--radius-card) border border-(--panel-border) bg-(--panel) px-4 py-3.5 opacity-80"
								>
									<div class="h-4 w-36 rounded bg-(--panel-strong)"></div>
									<div class="mt-3 h-3 w-2/3 rounded bg-(--panel-strong)"></div>
								</div>
							{/each}
						</div>
					{:else if searchQuery}
						<svelte:boundary>
							{@const results = await searchQuery}
							{#if results.length > 0}
								<ol class="space-y-0">
									{#each results as crate, index (crateKey(crate))}
										<li>
											<a
												href={crateHref(crate)}
												data-sveltekit-preload-data="off"
												class="group flex items-start gap-3 border-t border-(--panel-border-soft) py-3 transition-colors first:border-t-0 hover:bg-(--panel-muted)"
											>
												<span
													class="mt-0.5 w-7 shrink-0 font-mono text-[11px] tabular-nums text-(--muted-soft)"
												>
													{String(index + 1).padStart(2, '0')}
												</span>
												<div class="min-w-0 flex-1">
													<div class="flex min-w-0 items-baseline gap-2">
														<KindBadge kind="crate" size={14} />
														<span class="truncate font-mono text-[13.5px] font-semibold text-(--ink)">
															{crate.name}
														</span>
														<span class="shrink-0 font-mono text-[10.5px] text-(--muted-soft)">
															{crate.version}
														</span>
													</div>
													{#if crate.description}
														<p class="mt-1 line-clamp-2 text-[12px] leading-snug text-(--muted)">
															{crate.description}
														</p>
													{/if}
												</div>
												<Icon
													name="chevron-right"
													size={12}
													class="mt-1 shrink-0 text-(--muted-soft) transition-transform group-hover:translate-x-0.5 group-hover:text-(--accent)"
												/>
											</a>
										</li>
									{/each}
								</ol>
							{:else}
								<div
									class="corner-squircle rounded-(--radius-card) border border-(--panel-border) bg-(--panel) px-4 py-10 text-center"
								>
									<p class="text-sm font-medium text-(--ink)">No matches found</p>
									<p class="mt-1 text-xs text-(--muted)">Try a different crate name.</p>
								</div>
							{/if}
							{#snippet pending()}
								<div class="space-y-2">
									{#each Array.from({ length: 4 }) as _, i (i)}
										<div
											class="corner-squircle rounded-(--radius-card) border border-(--panel-border) bg-(--panel) px-4 py-3.5 opacity-80"
										>
											<div class="h-4 w-36 rounded bg-(--panel-strong)"></div>
											<div class="mt-3 h-3 w-2/3 rounded bg-(--panel-strong)"></div>
										</div>
									{/each}
								</div>
							{/snippet}
						</svelte:boundary>
					{/if}
				{:else if visibleSection === 'workspace'}
					<div class="mb-3 flex items-center justify-between gap-3">
						<div class="flex min-w-0 items-center gap-2">
							<Icon name="layers" size={13} class="text-(--accent)" />
							<h2 class="font-display text-[18px] font-semibold text-(--ink)">
								Your workspace
							</h2>
							<span class="font-mono text-[11px] text-(--muted-soft)">
								{workspaceCrates.length} crate{workspaceCrates.length === 1 ? '' : 's'}
							</span>
						</div>
					</div>
					{#if workspaceCrates.length > 0}
						<div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
							{#each workspaceCrates as crate (crateKey(crate))}
								<a
									href={crateHref(crate)}
									data-sveltekit-preload-data="off"
									class="group corner-squircle flex min-w-0 items-center gap-2.5 rounded-(--radius-control) border border-(--panel-border) bg-(--panel-solid) px-3 py-2.5 transition-all hover:border-(--accent-ring) hover:bg-(--panel-strong) hover:shadow-(--shadow-soft)"
								>
									<KindBadge kind="crate" size={14} />
									<span class="min-w-0 flex-1 truncate font-mono text-[13px] font-medium text-(--ink)">
										{crate.name}
									</span>
									<span class="shrink-0 font-mono text-[10.5px] text-(--muted-soft)">
										{crate.version}
									</span>
								</a>
							{/each}
						</div>
					{:else}
						<div
							class="corner-squircle rounded-(--radius-card) border border-(--panel-border) bg-(--panel) px-4 py-10 text-center"
						>
							<p class="text-sm font-medium text-(--ink)">No workspace crates loaded</p>
							<p class="mt-1 text-xs text-(--muted)">Registry results are still available.</p>
						</div>
					{/if}
				{:else}
					<div class="mb-3 flex items-center justify-between gap-3">
						<div class="flex min-w-0 items-center gap-2">
							<Icon name="trending" size={13} class="text-(--accent)" />
							<h2 class="font-display text-[18px] font-semibold text-(--ink)">
								Popular crates
							</h2>
						</div>
						<span class="font-mono text-[11px] text-(--muted-soft)">registry provider</span>
					</div>
					<svelte:boundary>
						{#await topCratesPromise}
							<div class="grid gap-3 sm:grid-cols-2">
								{#each Array.from({ length: 6 }) as _, i (i)}
									<div
										class="corner-squircle rounded-(--radius-card) border border-(--panel-border) bg-(--panel) px-4 py-3.5 opacity-80"
									>
										<div class="h-4 w-28 rounded bg-(--panel-strong)"></div>
										<div class="mt-3 h-3 w-2/3 rounded bg-(--panel-strong)"></div>
									</div>
								{/each}
							</div>
						{:then topCrates}
							{#if topCrates.length > 0}
								<div class="grid gap-3 sm:grid-cols-2">
									{#each topCrates as crate (crateKey(crate))}
										<a
											href={crateHref(crate)}
											data-sveltekit-preload-data="off"
											class="group corner-squircle block rounded-(--radius-card) border border-(--panel-border) bg-(--panel) px-4 py-3.5 transition-all hover:-translate-y-0.5 hover:border-(--accent-ring) hover:bg-(--panel-strong) hover:shadow-(--shadow-soft)"
										>
											<div class="flex items-start justify-between gap-3">
												<div class="min-w-0">
													<div class="flex min-w-0 items-baseline gap-2">
														<KindBadge kind="crate" size={14} />
														<span class="truncate font-mono text-[14px] font-semibold text-(--ink)">
															{crate.name}
														</span>
														<span class="shrink-0 font-mono text-[10.5px] text-(--muted-soft)">
															{crate.version}
														</span>
													</div>
													{#if crate.description}
														<p class="mt-2 line-clamp-2 text-[12.5px] leading-snug text-(--muted)">
															{crate.description}
														</p>
													{/if}
												</div>
												<Icon
													name="arrow-right"
													size={13}
													class="-translate-x-1 shrink-0 text-(--muted) opacity-0 transition-all duration-150 group-hover:translate-x-0 group-hover:opacity-70"
												/>
											</div>
										</a>
									{/each}
								</div>
							{:else}
								<div
									class="corner-squircle rounded-(--radius-card) border border-(--panel-border) bg-(--panel) px-4 py-10 text-center"
								>
									<p class="text-sm font-medium text-(--ink)">No popular crates available</p>
									<p class="mt-1 text-xs text-(--muted)">Search the registry above.</p>
								</div>
							{/if}
						{/await}
					</svelte:boundary>
				{/if}
			</section>
		</div>
	</main>
</div>
