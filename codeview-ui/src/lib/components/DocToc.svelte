<script lang="ts">
	import type { Node } from '$lib/graph';
	import { resolve } from '$app/paths';
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';

	type TocEntry = { anchor: string; title: string; count?: number | null };
	type RelatedRef = { id: string; name: string };

	let {
		entries,
		related = [],
		getNodeUrl,
		openGraphHref,
		onOpenGraph,
		nodeId,
	} = $props<{
		entries: TocEntry[];
		related?: RelatedRef[];
		getNodeUrl?: (id: string) => string;
		openGraphHref?: string;
		onOpenGraph?: () => void;
		nodeId?: string;
	}>();

	let activeAnchor = $state<string | null>(null);

	// Use IntersectionObserver to track which section is currently in view.
	// We watch all section elements with the anchors we know about and pick
	// the topmost intersecting one.
	onMount(() => {
		if (!browser) return;
		const ids = entries.map((e: TocEntry) => e.anchor);
		const observer = new IntersectionObserver(
			(records) => {
				// Sort by Y position; pick the first intersecting section.
				const visible = records
					.filter((r) => r.isIntersecting)
					.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
				if (visible.length > 0) {
					activeAnchor = (visible[0].target as HTMLElement).id;
				}
			},
			{ rootMargin: '-80px 0px -60% 0px', threshold: 0 },
		);
		const els: HTMLElement[] = [];
		for (const id of ids) {
			const el = document.getElementById(id);
			if (el) {
				observer.observe(el);
				els.push(el);
			}
		}
		// If nothing intersects on mount, default to first entry
		if (entries.length > 0 && !activeAnchor) activeAnchor = entries[0].anchor;
		return () => {
			for (const el of els) observer.unobserve(el);
			observer.disconnect();
		};
	});

	function jumpTo(e: MouseEvent, anchor: string) {
		e.preventDefault();
		const el = browser ? document.getElementById(anchor) : null;
		if (el) {
			el.scrollIntoView({ behavior: 'smooth', block: 'start' });
			history.replaceState(null, '', `#${anchor}`);
			activeAnchor = anchor;
		}
	}

	function handleOpenGraph(event: MouseEvent) {
		if (!onOpenGraph) return;
		if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		event.preventDefault();
		onOpenGraph();
	}
</script>

{#if entries.length > 0}
	<aside class="doc-toc">
		<div
			class="mb-2 text-[10px] font-semibold tracking-[0.22em] text-(--muted-soft) uppercase"
		>
			On this page
		</div>
		<nav class="doc-toc-list">
			{#each entries as entry (entry.anchor)}
				{@const active = activeAnchor === entry.anchor}
				<a
					href={`#${entry.anchor}`}
					onclick={(e) => jumpTo(e, entry.anchor)}
					class="doc-toc-link {active ? 'is-active' : ''}"
				>
					<span class="flex-1 truncate">{entry.title}</span>
					{#if entry.count != null}
						<span class="font-mono text-[10px] text-(--muted-soft) tabular-nums">{entry.count}</span>
					{/if}
				</a>
			{/each}
		</nav>

		{#if related.length > 0}
			<div
				class="corner-squircle mt-6 rounded-(--radius-card) border border-(--panel-border-soft) bg-(--panel) p-3"
			>
				<div
					class="mb-2 text-[10px] font-semibold tracking-[0.22em] text-(--muted-soft) uppercase"
				>
					Where used
				</div>
				<ul class="space-y-1 font-mono text-[11.5px] text-(--ink-soft)">
					{#each related.slice(0, 6) as ref (ref.id)}
						<li>
							{#if getNodeUrl}
								<a
									href={resolve(getNodeUrl(ref.id))}
									data-sveltekit-noscroll
									class="hover:text-(--accent) hover:underline"
									title={ref.id}
								>
									{ref.name}
								</a>
							{:else}
								<span title={ref.id}>{ref.name}</span>
							{/if}
						</li>
					{/each}
				</ul>
				{#if (openGraphHref || onOpenGraph) && nodeId}
					{#if openGraphHref}
						<a
							href={resolve(openGraphHref)}
							data-sveltekit-noscroll
							class="mt-3 inline-flex items-center gap-1 text-[10.5px] font-mono text-(--accent-strong) hover:text-(--accent)"
							onclick={handleOpenGraph}
						>
							Open in graph
							<span aria-hidden="true">→</span>
						</a>
					{:else}
						<button
							type="button"
							class="mt-3 inline-flex items-center gap-1 text-[10.5px] font-mono text-(--accent-strong) hover:text-(--accent)"
							onclick={handleOpenGraph}
						>
							Open in graph
							<span aria-hidden="true">→</span>
						</button>
					{/if}
				{/if}
			</div>
		{/if}
	</aside>
{/if}

<style>
	.doc-toc {
		position: sticky;
		top: 1.5rem;
		max-height: calc(100vh - 8rem);
		overflow-y: auto;
		padding-right: 0.25rem;
	}

	.doc-toc-list {
		display: flex;
		flex-direction: column;
	}

	.doc-toc-link {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		padding: 3px 0 3px 10px;
		font-size: 12px;
		color: var(--muted);
		border-left: 2px solid transparent;
		transition: color 0.12s, border-color 0.12s;
	}

	.doc-toc-link:hover {
		color: var(--ink);
	}

	.doc-toc-link.is-active {
		color: var(--ink);
		border-left-color: var(--accent);
		font-weight: 600;
	}
</style>
