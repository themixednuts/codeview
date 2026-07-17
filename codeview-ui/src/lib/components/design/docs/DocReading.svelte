<script lang="ts">
	import type { NodeDetail, NodeSummary } from '$lib/schema';
	import type { MaterializedDetailDocModel } from '$lib/detail-model';
	import DocArticle from './DocArticle.svelte';

	let {
		detail,
		ancestors,
		model,
		theme = 'light',
		getNodeUrl,
		crateName,
		crateVersion,
		crateVersions = {},
	} = $props<{
		detail: NodeDetail;
		ancestors: NodeSummary[];
		model: MaterializedDetailDocModel;
		theme?: 'dark' | 'light';
		getNodeUrl: (id: string) => string;
		crateName?: string;
		crateVersion?: string;
		crateVersions?: Record<string, string>;
	}>();
</script>

{#snippet readingToc()}
	{#if model.tocEntries.length >= 3}
		<details class="reading-toc mb-8 border-y border-(--panel-border-soft) py-3">
			<summary class="cursor-pointer font-medium text-(--ink)">On this page</summary>
			<nav aria-label="On this page" class="mt-3">
				<ol class="grid gap-1.5 pl-5">
					{#each model.tocEntries as entry (entry.anchor)}
						<li>
							<a
								href={`#${entry.anchor}`}
								class="text-(--link-strong) underline-offset-2 hover:underline"
							>
								{entry.title}
								{#if entry.count != null}
									<span class="ml-1 font-mono text-[0.8em] text-(--muted)">{entry.count}</span>
								{/if}
							</a>
						</li>
					{/each}
				</ol>
			</nav>
		</details>
	{/if}
{/snippet}

<div class="doc-reading min-h-full overflow-y-auto">
	<article class="mx-auto min-h-full w-full px-4 py-6 sm:px-8 sm:py-10 lg:py-12">
		<DocArticle
			{detail}
			{ancestors}
			{model}
			{theme}
			{getNodeUrl}
			{crateName}
			{crateVersion}
			{crateVersions}
			afterHeader={readingToc}
			className="doc-article--reading"
		/>
	</article>
</div>

<style>
	.doc-reading {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		width: 100%;
		min-width: 0;
		scrollbar-gutter: stable both-edges;
		background:
			linear-gradient(90deg, transparent, var(--panel-muted) 50%, transparent) top center /
				min(var(--doc-measure), 100%) 1px no-repeat,
			var(--bg);
	}

	.doc-reading > article {
		width: min(100%, var(--doc-measure, 66ch));
		max-width: none;
		margin-inline: auto;
		justify-self: center;
	}

	.doc-reading :global(.doc-article--reading > div:first-child) {
		margin-bottom: 2rem;
	}

	.doc-reading :global(.doc-section h2) {
		font-size: var(--text-xl);
		letter-spacing: 0;
	}
</style>
