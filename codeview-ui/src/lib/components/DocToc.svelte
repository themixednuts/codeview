<script lang="ts">
	import { resolve } from '$app/paths';
	import type { Attachment } from 'svelte/attachments';

	type TocEntry = { anchor: string; title: string; count?: number | null };

	let { entries, openGraphHref, nodeId } = $props<{
		entries: TocEntry[];
		openGraphHref?: string;
		nodeId?: string;
	}>();

	let activeAnchor = $state<string | null>(null);

	// Progressive enhancement: hash links work without JS.
	// IntersectionObserver only upgrades the "active" highlight.
	const observeSections: Attachment<HTMLElement> = () => {
		const ids = entries.map((e: TocEntry) => e.anchor);
		if (ids.length === 0) return;

		const observer = new IntersectionObserver(
			(records) => {
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
		if (entries.length > 0 && !activeAnchor) activeAnchor = entries[0].anchor;

		return () => {
			for (const el of els) observer.unobserve(el);
			observer.disconnect();
		};
	};
</script>

{#if entries.length >= 3 || (openGraphHref && nodeId)}
	<aside class="doc-toc" {@attach observeSections}>
		{#if entries.length >= 3}
			<div class="mb-2 text-xs font-semibold text-(--muted) uppercase">On this page</div>
			<nav class="doc-toc-list" aria-label="On this page">
				{#each entries as entry (entry.anchor)}
					{@const active = activeAnchor === entry.anchor}
					<a href={`#${entry.anchor}`} class="doc-toc-link {active ? 'is-active' : ''}">
						<span class="flex-1 truncate">{entry.title}</span>
						{#if entry.count != null}
							<span class="font-mono text-2xs text-(--muted-soft) tabular-nums">
								{entry.count}
							</span>
						{/if}
					</a>
				{/each}
			</nav>
		{/if}

		{#if openGraphHref && nodeId}
			<div
				class="corner-squircle rounded-(--radius-card) border border-(--panel-border-soft) bg-(--panel) p-3"
				class:mt-6={entries.length >= 3}
			>
				<a
					href={resolve(openGraphHref)}
					data-sveltekit-noscroll
					class="inline-flex items-center gap-1 font-mono text-xs text-(--accent-strong) hover:text-(--accent)"
				>
					Open in graph
					<span aria-hidden="true">→</span>
				</a>
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
		padding: 0.1875rem 0 0.1875rem 0.625rem;
		font-size: var(--text-sm);
		color: var(--muted);
		border-left: 2px solid transparent;
		transition:
			color 0.12s,
			border-color 0.12s;
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
