<script lang="ts">
	import type { Node, NodeDetail, NodeSummary } from '$lib/schema';
	import type { MaterializedDetailDocModel } from '$lib/detail-model';
	import { kindLabels } from '$lib/display-names';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import NodeDetails from '$lib/components/NodeDetails.svelte';
	import DocReadAloud from './DocReadAloud.svelte';
	import type { Snippet } from 'svelte';

	let {
		detail,
		ancestors,
		model,
		theme = 'light',
		getNodeUrl,
		crateName,
		crateVersion,
		crateVersions = {},
		showBreadcrumb = true,
		afterHeader,
		className = '',
	} = $props<{
		detail: NodeDetail;
		ancestors: NodeSummary[];
		model: MaterializedDetailDocModel;
		theme?: 'dark' | 'light';
		getNodeUrl: (id: string) => string;
		crateName?: string;
		crateVersion?: string;
		crateVersions?: Record<string, string>;
		showBreadcrumb?: boolean;
		afterHeader?: Snippet;
		className?: string;
	}>();

	const selected = $derived(detail.node);

	function displayNode(id: string) {
		return model.relatedNodeMap.get(id)?.name ?? id.split('::').pop() ?? id;
	}

	function nodeExists(nodeId: string): boolean {
		return model.relatedNodeMap.has(nodeId);
	}

	function nodeMeta(nodeId: string): Node | undefined {
		return model.relatedNodeMap.get(nodeId);
	}
</script>

<div class={`doc-article min-w-0 ${className}`}>
	{#if showBreadcrumb}
		<div
			class="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-(--panel-border-soft) pb-3"
		>
			<div class="min-w-0">
				<Breadcrumbs {ancestors} {selected} {getNodeUrl} />
			</div>
			<DocReadAloud node={selected} />
		</div>
	{/if}
	{@render afterHeader?.()}

	<NodeDetails
		{selected}
		sourceImpls={model.sourceImpls}
		blanketImpls={model.blanketImpls}
		methodGroups={model.methodGroups}
		traitImplGroups={model.traitImplGroups}
		requiredTraitMethods={model.requiredTraitMethods}
		providedTraitMethods={model.providedTraitMethods}
		traitAssocItems={model.traitAssocItems}
		directItems={model.directItems}
		{kindLabels}
		{displayNode}
		implementers={model.whereUsed}
		{theme}
		{getNodeUrl}
		{nodeExists}
		{nodeMeta}
		{crateName}
		{crateVersion}
		{crateVersions}
	/>
</div>

<style>
	.doc-article :global(h1),
	.doc-article :global(h2),
	.doc-article :global(h3) {
		letter-spacing: 0;
	}
</style>
