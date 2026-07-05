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

	function focusRelationships() {
		const el = typeof document !== 'undefined' ? document.getElementById('relationships') : null;
		if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}
</script>

<div
	class="doc-classic mx-auto grid min-h-full w-full max-w-[1180px] grid-cols-1 gap-8 px-5 py-6 xl:grid-cols-[minmax(0,1fr)_220px] xl:px-8"
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
		/>
	</article>

	<aside class="hidden min-w-0 xl:block" aria-label="Documentation table of contents">
		<DocToc
			entries={model.tocEntries}
			related={model.whereUsed}
			{getNodeUrl}
			onOpenGraph={focusRelationships}
			nodeId={detail.node.id}
		/>
	</aside>
</div>
