<script lang="ts">
	import { Debounced } from 'runed';
	import { LoaderCircleIcon, SearchIcon, ArrowRightIcon } from '@lucide/svelte';
	import { searchRegistry } from '$lib/rpc/crate.remote';
	import { resolve } from '$app/paths';
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

	// TODO: abort in-flight searches when the term changes once SvelteKit
	// remote functions support abort signals: https://github.com/sveltejs/kit/issues/14502
	const searchQuery = $derived(
		debouncedTerm.length >= 2 ? searchRegistry({ q: debouncedTerm }) : null,
	);
	const showSearchResults = $derived(searchTerm.length >= 2);
</script>

<div class="flex flex-1 overflow-auto">
	<div class="mx-auto flex w-full max-w-6xl flex-col px-6 pt-8 pb-12">
		<!-- Hero -->
		<section
			class="corner-squircle relative overflow-hidden rounded-(--radius-panel) border border-(--panel-border) bg-(--panel) shadow-(--shadow-glow)"
		>
			<!-- Animated graph background -->
			<div class="pointer-events-none absolute inset-0" aria-hidden="true">
				<svg
					class="absolute inset-0 size-full"
					viewBox="0 0 800 320"
					preserveAspectRatio="xMidYMid slice"
				>
					<!-- Edges — flowing dash animation -->
					<g fill="none" stroke="var(--muted)" stroke-width="1" stroke-linecap="round">
						<path
							class="hero-edge"
							stroke-opacity="0.12"
							style="--delay: 0s"
							d="M400 160 Q310 130 220 115"
						/>
						<path
							class="hero-edge"
							stroke-opacity="0.12"
							style="--delay: -1.5s"
							d="M400 160 Q490 132 580 120"
						/>
						<path
							class="hero-edge"
							stroke-opacity="0.12"
							style="--delay: -0.8s"
							d="M400 160 Q350 108 320 70"
						/>
						<path
							class="hero-edge"
							stroke-opacity="0.12"
							style="--delay: -2.2s"
							d="M400 160 Q450 110 480 75"
						/>
						<path
							class="hero-edge"
							stroke-opacity="0.10"
							style="--delay: -0.5s"
							d="M220 115 Q170 148 140 185"
						/>
						<path
							class="hero-edge"
							stroke-opacity="0.10"
							style="--delay: -1.8s"
							d="M220 115 Q258 160 280 210"
						/>
						<path
							class="hero-edge"
							stroke-opacity="0.10"
							style="--delay: -2.5s"
							d="M580 120 Q542 158 520 200"
						/>
						<path
							class="hero-edge"
							stroke-opacity="0.10"
							style="--delay: -0.3s"
							d="M580 120 Q628 145 660 175"
						/>
						<path
							class="hero-edge"
							stroke-opacity="0.08"
							style="--delay: -1.2s"
							d="M320 70 Q355 160 370 250"
						/>
						<path
							class="hero-edge"
							stroke-opacity="0.08"
							style="--delay: -3.0s"
							d="M480 75 Q455 160 450 245"
						/>
						<path
							class="hero-edge"
							stroke-opacity="0.08"
							style="--delay: -0.7s"
							d="M220 115 Q155 85 100 70"
						/>
						<path
							class="hero-edge"
							stroke-opacity="0.08"
							style="--delay: -2.0s"
							d="M320 70 Q275 50 240 45"
						/>
						<path
							class="hero-edge"
							stroke-opacity="0.08"
							style="--delay: -1.4s"
							d="M480 75 Q455 50 440 40"
						/>
						<path
							class="hero-edge"
							stroke-opacity="0.08"
							style="--delay: -2.8s"
							d="M580 120 Q595 82 600 55"
						/>
						<path
							class="hero-edge"
							stroke-opacity="0.08"
							style="--delay: -0.2s"
							d="M580 120 Q645 100 700 95"
						/>
						<path
							class="hero-edge-impl"
							stroke-opacity="0.06"
							stroke-dasharray="3 5"
							style="--delay: -1.6s"
							d="M170 155 Q192 130 220 115"
						/>
						<path
							class="hero-edge-impl"
							stroke-opacity="0.06"
							stroke-dasharray="3 5"
							style="--delay: -2.4s"
							d="M630 230 Q598 172 580 120"
						/>
					</g>

					<!-- Nodes — gentle drift animation -->
					<circle
						class="hero-node"
						cx="400"
						cy="160"
						r="9"
						fill="var(--kind-crate)"
						opacity="0.55"
						style="--dur: 16s; --delay: 0s"
					/>
					<circle
						class="hero-node"
						cx="220"
						cy="115"
						r="6.5"
						fill="var(--kind-module)"
						opacity="0.45"
						style="--dur: 13s; --delay: -2s"
					/>
					<circle
						class="hero-node"
						cx="580"
						cy="120"
						r="6.5"
						fill="var(--kind-module)"
						opacity="0.45"
						style="--dur: 14s; --delay: -4s"
					/>
					<circle
						class="hero-node"
						cx="320"
						cy="70"
						r="5.5"
						fill="var(--kind-module)"
						opacity="0.40"
						style="--dur: 11s; --delay: -1s"
					/>
					<circle
						class="hero-node"
						cx="480"
						cy="75"
						r="5.5"
						fill="var(--kind-module)"
						opacity="0.40"
						style="--dur: 12s; --delay: -3s"
					/>
					<circle
						class="hero-node"
						cx="140"
						cy="185"
						r="5"
						fill="var(--kind-struct)"
						opacity="0.35"
						style="--dur: 15s; --delay: -5s"
					/>
					<circle
						class="hero-node"
						cx="280"
						cy="210"
						r="5"
						fill="var(--kind-struct)"
						opacity="0.35"
						style="--dur: 17s; --delay: -2s"
					/>
					<circle
						class="hero-node"
						cx="520"
						cy="200"
						r="5"
						fill="var(--kind-struct)"
						opacity="0.35"
						style="--dur: 14s; --delay: -6s"
					/>
					<circle
						class="hero-node"
						cx="660"
						cy="175"
						r="5"
						fill="var(--kind-struct)"
						opacity="0.35"
						style="--dur: 16s; --delay: -1s"
					/>
					<circle
						class="hero-node"
						cx="370"
						cy="250"
						r="4.5"
						fill="var(--kind-trait)"
						opacity="0.30"
						style="--dur: 18s; --delay: -3s"
					/>
					<circle
						class="hero-node"
						cx="450"
						cy="245"
						r="4.5"
						fill="var(--kind-trait)"
						opacity="0.30"
						style="--dur: 15s; --delay: -7s"
					/>
					<circle
						class="hero-node"
						cx="100"
						cy="70"
						r="3.5"
						fill="var(--kind-function)"
						opacity="0.25"
						style="--dur: 10s; --delay: -2s"
					/>
					<circle
						class="hero-node"
						cx="240"
						cy="45"
						r="3.5"
						fill="var(--kind-function)"
						opacity="0.25"
						style="--dur: 11s; --delay: -4s"
					/>
					<circle
						class="hero-node"
						cx="440"
						cy="40"
						r="3.5"
						fill="var(--kind-function)"
						opacity="0.25"
						style="--dur: 12s; --delay: -1s"
					/>
					<circle
						class="hero-node"
						cx="600"
						cy="55"
						r="3.5"
						fill="var(--kind-function)"
						opacity="0.25"
						style="--dur: 9s; --delay: -3s"
					/>
					<circle
						class="hero-node"
						cx="700"
						cy="95"
						r="3.5"
						fill="var(--kind-function)"
						opacity="0.25"
						style="--dur: 10s; --delay: -5s"
					/>
					<circle
						class="hero-node"
						cx="170"
						cy="155"
						r="3.5"
						fill="var(--kind-impl)"
						opacity="0.25"
						style="--dur: 14s; --delay: -2s"
					/>
					<circle
						class="hero-node"
						cx="630"
						cy="230"
						r="3.5"
						fill="var(--kind-impl)"
						opacity="0.25"
						style="--dur: 13s; --delay: -4s"
					/>
				</svg>

				<!-- Vignette overlays -->
				<div
					class="absolute inset-0"
					style="background: radial-gradient(ellipse at center, transparent 15%, var(--panel) 72%)"
				></div>
				<div
					class="absolute inset-0"
					style="background: linear-gradient(to bottom, var(--panel) 0%, transparent 25%, transparent 75%, var(--panel) 100%)"
				></div>
			</div>

			<!-- Glow orbs -->
			<div
				class="absolute top-1/3 left-1/3 size-48 -translate-1/2 rounded-full bg-(--accent) opacity-[0.05] blur-[60px]"
			></div>
			<div
				class="absolute right-1/4 bottom-1/4 size-32 rounded-full bg-(--kind-struct) opacity-[0.04] blur-[50px]"
			></div>

			<!-- Hero content -->
			<div class="relative z-10 flex flex-col items-center px-8 pt-16 pb-20 text-center">
				<span
					class="hero-label inline-block text-[10px] font-semibold tracking-[0.35em] text-(--accent) uppercase"
				>
					Codeview
				</span>
				<h1
					class="hero-title mt-5 leading-tight font-bold text-(--ink)"
					style="font-size: clamp(2.25rem, 5vw, 3.5rem)"
				>
					Code, visualized.
				</h1>
			</div>
		</section>

		<!-- Search bar (overlaps hero bottom) -->
		<div class="relative z-20 mx-auto -mt-9 w-full max-w-xl px-2">
			<div class="search-enter relative">
				<SearchIcon class="absolute top-1/2 left-4 -translate-y-1/2 text-(--muted)" size={16} />
				<input
					id="global-search"
					type="search"
					placeholder="Search crates, types, functions..."
					bind:value={searchInput}
					class="corner-squircle w-full rounded-(--radius-control) border border-(--panel-border) bg-(--panel-solid) py-3 pr-4 pl-11 text-sm shadow-(--shadow-strong) transition-all duration-200 outline-none focus:border-(--accent) focus:shadow-(--shadow-glow) focus:ring-1 focus:ring-(--accent)"
				/>
			</div>
			{#if showSearchResults}
				<div
					class="corner-squircle absolute right-2 left-2 z-30 mt-2 rounded-(--radius-card) border border-(--panel-border) bg-(--panel-solid) p-2 shadow-(--shadow-strong)"
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
									{#each results as result (result.name)}
										<a
											href={resolve(`/${result.name}/${result.version}`)}
											data-sveltekit-preload-data="off"
											class="group corner-squircle flex items-center gap-3 rounded-(--radius-chip) px-3 py-2.5 transition-colors hover:bg-(--panel-strong)"
										>
											<div class="min-w-0 flex-1">
												<p class="text-sm font-medium text-(--ink)">
													{result.name}
												</p>
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

		<!-- Crate sections -->
		<div class="mt-14">
			{#if workspaceCrates.length > 0}
				<section id="workspace-crates" class="space-y-5">
					<div class="flex items-center gap-4">
						<h2 class="shrink-0 text-lg font-semibold text-(--ink)">Workspace</h2>
						<div class="h-px flex-1 bg-(--panel-border)"></div>
					</div>
					<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
						{#each workspaceCrates as crate, i (crate.id)}
							<a
								href={resolve(`/${crate.id}/${crate.version}`)}
								data-sveltekit-preload-data="off"
								class="crate-card group corner-squircle flex items-center justify-between gap-3 rounded-(--radius-card) border border-(--panel-border) bg-(--panel-solid) px-5 py-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-(--accent) hover:shadow-(--shadow-soft)"
								style="animation-delay: {i * 60}ms"
							>
								<span class="text-sm font-semibold text-(--ink)">{crate.name}</span>
								<div class="flex shrink-0 items-center gap-2">
									<span class="badge">{crate.version}</span>
									<ArrowRightIcon
										class="-translate-x-1 text-(--muted) opacity-0 transition-all duration-150 group-hover:translate-x-0 group-hover:opacity-70"
										size={14}
									/>
								</div>
							</a>
						{/each}
					</div>
				</section>
				<div class="mt-10"></div>
			{/if}

			<section class="space-y-5">
				<div class="flex items-center gap-4">
					<h2 class="shrink-0 text-lg font-semibold text-(--ink)">Explore</h2>
					<div class="h-px flex-1 bg-(--panel-border)"></div>
				</div>
				<svelte:boundary>
					{#await topCratesPromise}
						<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
							{#each Array.from({ length: 6 }) as _, i (i)}
								<div
									class="corner-squircle rounded-(--radius-card) border border-(--panel-border) bg-(--panel-solid) px-5 py-4 opacity-80"
								>
									<div class="h-4 w-24 rounded bg-(--panel-strong)"></div>
									<div class="mt-3 h-3 w-32 rounded bg-(--panel-strong)"></div>
								</div>
							{/each}
						</div>
					{:then topCrates}
						{#if topCrates.length > 0}
							<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
								{#each topCrates as crate, i (crate.id)}
									<a
										href={resolve(`/${crate.id}/${crate.version}`)}
										data-sveltekit-preload-data="off"
										class="crate-card group corner-squircle block rounded-(--radius-card) border border-(--panel-border) bg-(--panel-solid) px-5 py-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-(--accent) hover:shadow-(--shadow-soft)"
										style="animation-delay: {i * 60}ms"
									>
										<div class="flex items-center justify-between gap-3">
											<span class="truncate text-sm font-semibold text-(--ink)">
												{crate.name}
											</span>
											<div class="flex shrink-0 items-center gap-2">
												<span class="badge badge-sm">{crate.version}</span>
												<ArrowRightIcon
													class="-translate-x-1 text-(--muted) opacity-0 transition-all duration-150 group-hover:translate-x-0 group-hover:opacity-70"
													size={14}
												/>
											</div>
										</div>
										{#if crate.description}
											<p class="mt-1.5 text-xs/relaxed text-(--muted)">
												{crate.description}
											</p>
										{/if}
									</a>
								{/each}
							</div>
						{:else}
							<div
								class="corner-squircle flex flex-col items-center gap-2 rounded-(--radius-card) border border-(--panel-border) bg-(--panel-solid) py-10"
							>
								<p class="text-sm font-medium text-(--ink)">No crates available</p>
								<p class="text-xs text-(--muted)">Search for a crate above to get started.</p>
							</div>
						{/if}
					{/await}
				</svelte:boundary>
			</section>
		</div>
	</div>
</div>

<style>
	/* Hero content entrance animations */
	.hero-label {
		animation: hero-fade 0.6s ease-out 0.1s backwards;
	}
	.hero-title {
		animation: hero-fade 0.7s ease-out 0.25s backwards;
	}

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

	/* Animated graph nodes — gentle orbital drift */
	.hero-node {
		animation: node-drift var(--dur, 12s) ease-in-out infinite;
		animation-delay: var(--delay, 0s);
	}

	@keyframes node-drift {
		0%,
		100% {
			transform: translate(0px, 0px);
		}
		20% {
			transform: translate(4px, -3px);
		}
		40% {
			transform: translate(-2px, 5px);
		}
		60% {
			transform: translate(-5px, -2px);
		}
		80% {
			transform: translate(3px, 4px);
		}
	}

	/* Animated graph edges — flowing dash effect */
	.hero-edge {
		stroke-dasharray: 4 8;
		animation: edge-flow 4s linear infinite;
		animation-delay: var(--delay, 0s);
	}

	.hero-edge-impl {
		animation: edge-flow 6s linear infinite;
		animation-delay: var(--delay, 0s);
	}

	@keyframes edge-flow {
		to {
			stroke-dashoffset: -24;
		}
	}

	/* Card staggered entrance */
	.crate-card {
		animation: float-in 0.45s ease-out backwards;
	}
</style>
