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

<div class="doc-reading min-h-full overflow-y-auto">
	<article class="mx-auto min-h-full w-full max-w-[760px] px-4 py-6 sm:px-8 sm:py-10 lg:py-12">
		<DocArticle
			{detail}
			{ancestors}
			{model}
			{theme}
			{getNodeUrl}
			{crateName}
			{crateVersion}
			{crateVersions}
			className="doc-article--reading"
		/>
	</article>
</div>

<style>
	.doc-reading {
		background:
			linear-gradient(90deg, transparent, var(--panel-muted) 50%, transparent) top center /
				min(760px, 100%) 1px no-repeat,
			var(--bg);
	}

	.doc-reading :global(.doc-article--reading > div:first-child) {
		margin-bottom: 2rem;
	}

	.doc-reading :global(.doc-section h2) {
		font-size: 1.75rem;
	}
</style>
