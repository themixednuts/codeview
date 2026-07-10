<script lang="ts">
	import type { NodeDetail, NodeSummary } from '$lib/schema';
	import type { MaterializedDetailDocModel } from '$lib/detail-model';
	import DocToc from '$lib/components/DocToc.svelte';
	import DocArticle from './DocArticle.svelte';

	let {
		detail,
		ancestors,
		model,
		theme = 'light',
		getNodeUrl,
		openGraphHref,
		onOpenGraph,
		crateName,
		crateVersion,
		crateVersions = {},
	} = $props<{
		detail: NodeDetail;
		ancestors: NodeSummary[];
		model: MaterializedDetailDocModel;
		theme?: 'dark' | 'light';
		getNodeUrl: (id: string) => string;
		openGraphHref?: string;
		onOpenGraph?: () => void;
		crateName?: string;
		crateVersion?: string;
		crateVersions?: Record<string, string>;
	}>();
</script>

<div
	class="doc-classic mx-auto grid min-h-full w-full max-w-[1180px] grid-cols-1 gap-8 px-4 py-5 sm:px-6 sm:py-6 md:px-8 xl:grid-cols-[minmax(0,1fr)_220px]"
>
	<article class="min-w-0">
		<DocArticle
			{detail}
			{ancestors}
			{model}
			{theme}
			{getNodeUrl}
			{crateName}
			{crateVersion}
			{crateVersions}
			className="doc-article--classic"
		/>
	</article>

	<aside class="hidden min-w-0 xl:block" aria-label="Documentation table of contents">
		<DocToc entries={model.tocEntries} {openGraphHref} nodeId={detail.node.id} />
	</aside>
</div>

<style>
	.doc-classic :global(.doc-article--classic > .max-w-3xl) {
		max-width: none;
	}
</style>
