<script lang="ts">
	import type { NodeDetail, NodeSummary } from '$lib/schema';
	import type { MaterializedDetailDocModel } from '$lib/detail-model';
	import { getSource } from '$lib/rpc/source.remote';
	import { sourceProviderModeCtx } from '$lib/context';
	import CodeBlock from '$lib/components/design/CodeBlock.svelte';
	import DocArticle from './DocArticle.svelte';
	import DocClassic from './DocClassic.svelte';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';

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

	const sourceProviderMode = $derived(sourceProviderModeCtx.getOr('auto'));
	const span = $derived(detail.node.span ?? null);
	const sourceRequest = $derived(
		span?.file
			? getSource({
					file: span.file,
					crateName,
					crateVersion,
					sourceProvider: sourceProviderMode,
				})
			: null,
	);
	const displayFile = $derived(span?.file ? span.file.replace(/\\/g, '/') : '');
	const highlightLines = $derived.by(() => {
		if (!span) return [];
		const start = span.line;
		const end = span.end_line ?? span.line;
		const lines: number[] = [];
		for (let line = start; line <= end; line += 1) lines.push(line);
		return lines;
	});
	const lineLabel = $derived.by(() => {
		if (!span) return '';
		const end = span.end_line ?? span.line;
		return end === span.line ? `L${span.line}` : `L${span.line}-L${end}`;
	});

	function langFromFile(file: string): 'rust' | 'toml' | 'json' | 'text' {
		if (file.endsWith('.rs')) return 'rust';
		if (file.endsWith('.toml')) return 'toml';
		if (file.endsWith('.json')) return 'json';
		return 'text';
	}
</script>

{#snippet classicFallback()}
	<DocClassic
		{detail}
		{ancestors}
		{model}
		{theme}
		{getNodeUrl}
		{crateName}
		{crateVersion}
		{crateVersions}
	/>
{/snippet}

{#snippet splitFrame(sourceContent: string | null, repoUrl: string | null)}
	<div class="doc-split grid min-h-full grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(480px,44%)]">
		<article class="min-w-0 overflow-y-auto px-6 py-7 xl:border-r xl:border-(--panel-border-soft) xl:px-8">
			<DocArticle
				{detail}
				{ancestors}
				{model}
				{theme}
				{getNodeUrl}
				{crateName}
				{crateVersion}
				{crateVersions}
				className="doc-article--split"
			/>
		</article>

		<aside
			class="flex min-h-[420px] flex-col overflow-hidden bg-(--code-bg) text-(--code-ink)"
			aria-label={`Source for ${detail.node.name}`}
		>
			<div
				class="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-[color:var(--code-border)] bg-(--code-bg-soft) px-4 font-mono text-[11.5px]"
				style="color: var(--syntax-comment)"
			>
				<div class="flex min-w-0 items-center gap-2">
					<span class="truncate" title={displayFile}>{displayFile}</span>
					{#if lineLabel}
						<span
							class="shrink-0 rounded px-1.5 py-[1px] text-[10px]"
							style="background: var(--accent-soft); color: var(--accent)"
						>
							{lineLabel}
						</span>
					{/if}
				</div>
				{#if repoUrl}
					<a
						href={repoUrl}
						target="_blank"
						rel="noopener noreferrer"
						class="shrink-0 text-[10.5px] hover:underline"
						style="color: var(--link)"
					>
						open source
					</a>
				{/if}
			</div>

			<div class="min-h-0 flex-1 overflow-auto">
				{#if sourceContent}
					<CodeBlock
						code={sourceContent}
						lang={langFromFile(displayFile)}
						{theme}
						startLine={1}
						highlightLines={highlightLines}
						showLineNumbers={true}
						variant="flat"
					/>
				{:else}
					<div class="flex h-full min-h-[280px] items-center justify-center gap-2 p-6 text-sm text-(--muted)">
						<LoaderCircleIcon class="animate-spin" size={14} />
						<span>Loading source...</span>
					</div>
				{/if}
			</div>

			<div
				class="flex h-9 shrink-0 items-center gap-3 border-t border-[color:var(--code-border)] bg-(--code-bg-soft) px-4 font-mono text-[10.5px]"
				style="color: var(--syntax-comment)"
			>
				<span>{langFromFile(displayFile)}</span>
				<span aria-hidden="true">·</span>
				<span>UTF-8</span>
				{#if sourceContent}
					<span aria-hidden="true">·</span>
					<span>{sourceContent.split('\n').length.toLocaleString()} lines</span>
				{/if}
			</div>
		</aside>
	</div>
{/snippet}

{#if !span?.file || !sourceRequest}
	{@render classicFallback()}
{:else}
	<svelte:boundary>
		{@const sourceResult = await sourceRequest}
		{#if sourceResult?.content}
			{@render splitFrame(sourceResult.content, sourceResult.repoUrl)}
		{:else}
			{@render classicFallback()}
		{/if}

		{#snippet pending()}
			{@render splitFrame(null, null)}
		{/snippet}
	</svelte:boundary>
{/if}

<style>
	.doc-split {
		background: var(--bg);
	}

	.doc-split :global(.doc-article--split .doc-section h2) {
		font-size: 1.375rem;
	}

	.doc-split :global(.design-codeblock) {
		border-radius: 0;
	}

	.doc-split :global(.design-codeblock pre) {
		min-height: 100%;
	}
</style>
