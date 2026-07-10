<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import Icon from '$lib/components/design/Icon.svelte';
	import KindBadge from '$lib/components/design/KindBadge.svelte';
	import type { CrateSearchResult, CrateSummary } from '$lib/schema';
	import {
		parseHomeState,
		serializeHomeState,
		type HomeTab,
		type HomeViewState,
	} from '$lib/url-state';
	import type { PageProps } from './$types';

	type CrateListItem = CrateSearchResult | CrateSummary;

	let { data }: PageProps = $props();

	const hasLocalWorkspace = $derived(data.hasLocalWorkspace);
	const localCrates = $derived(data.localCrates);
	const topCrates = $derived(data.topCrates);
	const defaultHomeTab = $derived(
		hasLocalWorkspace && localCrates.length > 0 ? ('workspace' as const) : ('popular' as const),
	);

	const homeState = $derived(parseHomeState(page.url, { defaultTab: defaultHomeTab }));
	const selectedSection = $derived(
		!hasLocalWorkspace && homeState.tab === 'workspace' ? 'popular' : homeState.tab,
	);
	const visibleSection = $derived(selectedSection);

	const sidebarSections = $derived([
		...(hasLocalWorkspace
			? [
					{
						id: 'workspace' as const,
						label: 'Workspace',
						meta: `${localCrates.length} crate${localCrates.length === 1 ? '' : 's'}`,
						icon: 'layers' as const,
					},
				]
			: []),
		{
			id: 'popular' as const,
			label: 'Popular',
			meta: 'crates.io',
			icon: 'trending' as const,
		},
	]);

	function crateHref(crate: CrateListItem) {
		return resolve(`/${crate.id ?? crate.name}/${crate.version || 'latest'}`);
	}

	function crateKey(crate: CrateListItem) {
		return `${crate.id ?? crate.name}:${crate.version || 'latest'}`;
	}

	function updateHomeState(patch: Partial<HomeViewState>) {
		void goto(serializeHomeState(page.url, patch, { defaultTab: defaultHomeTab }), {
			replaceState: true,
			noScroll: true,
			keepFocus: true,
		});
	}

	function setSelectedSection(tab: HomeTab) {
		updateHomeState({ tab });
	}
</script>

<div class="flex flex-1 overflow-auto">
	<main class="w-full">
		<div class="border-b border-(--panel-border-soft)">
			<div class="mx-auto flex max-w-[1180px] flex-col gap-3 px-4 py-4 sm:px-6 lg:px-8">
				<div class="flex flex-wrap items-center gap-2 text-[12px] text-(--muted)">
					<span>Showing</span>
					<span class="badge badge-sm bg-(--panel) text-(--ink)">
						{visibleSection === 'workspace' ? 'workspace' : 'popular crates'}
					</span>
					<span class="text-(--muted-soft)" aria-hidden="true">·</span>
					<span class="font-mono">
						{visibleSection === 'workspace' ? `${localCrates.length} local` : 'from crates.io'}
					</span>
				</div>
			</div>
		</div>

		<div
			class="mx-auto grid w-full max-w-[1180px] gap-8 px-4 py-8 sm:px-6 lg:grid-cols-[260px_minmax(0,1fr)] lg:gap-10 lg:px-8"
		>
			<aside class="min-w-0">
				<div class="mb-3 flex items-center justify-between">
					<h1 class="text-[10.5px] font-semibold tracking-[0.22em] text-(--ink-soft) uppercase">
						Browse
					</h1>
				</div>
				<ul class="space-y-0.5">
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
								onclick={() => setSelectedSection(section.id)}
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
			</aside>

			<section class="min-w-0">
				{#if visibleSection === 'workspace' && hasLocalWorkspace}
					<div class="mb-3 flex items-center justify-between gap-3">
						<div class="flex min-w-0 items-center gap-2">
							<Icon name="layers" size={13} class="text-(--accent)" />
							<h2 class="font-display text-[18px] font-semibold text-(--ink)">Your workspace</h2>
							<span class="font-mono text-[11px] text-(--muted-soft)">
								{localCrates.length} crate{localCrates.length === 1 ? '' : 's'}
							</span>
						</div>
					</div>
					{#if localCrates.length > 0}
						<div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
							{#each localCrates as crate (crateKey(crate))}
								<a
									href={crateHref(crate)}
									data-sveltekit-preload-data="off"
									class="group corner-squircle flex min-w-0 items-center gap-2.5 rounded-(--radius-control) border border-(--panel-border) bg-(--panel-solid) px-3 py-2.5 transition-all hover:border-(--accent-ring) hover:bg-(--panel-strong) hover:shadow-(--shadow-soft)"
								>
									<KindBadge kind="crate" size={14} />
									<span
										class="min-w-0 flex-1 truncate font-mono text-[13px] font-medium text-(--ink)"
									>
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
							<p class="mt-1 text-xs text-(--muted)">Crates.io results are still available.</p>
						</div>
					{/if}
				{:else}
					<div class="mb-3 flex items-center justify-between gap-3">
						<div class="flex min-w-0 items-center gap-2">
							<Icon name="trending" size={13} class="text-(--accent)" />
							<h2 class="font-display text-[18px] font-semibold text-(--ink)">Popular crates</h2>
						</div>
						<span class="font-mono text-[11px] text-(--muted-soft)">crates.io</span>
					</div>
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
											class="shrink-0 -translate-x-1 text-(--muted) opacity-0 transition-all duration-150 group-hover:translate-x-0 group-hover:opacity-70"
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
						</div>
					{/if}
				{/if}
			</section>
		</div>
	</main>
</div>
