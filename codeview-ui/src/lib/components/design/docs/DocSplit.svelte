<script lang="ts">
	import type { NodeDetail, NodeSummary, SourceResult } from '#lib/schema.js';
	import type { MaterializedDetailDocModel } from '#lib/detail-model.js';
	import { getSource } from '#lib/rpc/source.remote.js';
	import { sourceProviderModeCtx } from '#lib/context.js';
	import CodeBlock from '#lib/components/design/CodeBlock.svelte';
	import SourceActions from '#lib/components/SourceActions.svelte';
	import DocArticle from './DocArticle.svelte';
	import DocClassic from './DocClassic.svelte';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';

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

	const sourceProviderMode = $derived(sourceProviderModeCtx.getOr('auto'));
	const span = $derived(detail.node.span ?? null);
	const sourceInput = $derived(
		span?.file
			? {
					file: span.file,
					crateName,
					crateVersion,
					sourceProvider: sourceProviderMode,
				}
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
	let sourceResult = $state<SourceResult | null>(null);
	let sourceLoaded = $state(false);
	let sourceScroller = $state<HTMLDivElement | null>(null);
	let sourceHighlightReady = $state(false);
	const sourceContent = $derived(sourceResult?.content ?? null);
	const absolutePath = $derived(sourceResult?.absolutePath ?? null);
	const repoUrl = $derived(sourceResult?.repoUrl ?? null);

	$effect(() => {
		if (!sourceInput) {
			sourceResult = null;
			sourceLoaded = false;
			return;
		}

		let cancelled = false;
		sourceResult = null;
		sourceLoaded = false;
		sourceHighlightReady = false;

		void getSource(sourceInput)
			.then((result) => {
				if (cancelled) return;
				sourceResult = result;
				sourceLoaded = true;
			})
			.catch((error) => {
				if (cancelled) return;
				sourceResult = {
					error: error instanceof Error ? error.message : String(error),
					content: null,
					absolutePath: null,
					repoUrl: null,
				};
				sourceLoaded = true;
			});

		return () => {
			cancelled = true;
		};
	});

	function langFromFile(file: string): 'rust' | 'toml' | 'json' | 'text' {
		if (file.endsWith('.rs')) return 'rust';
		if (file.endsWith('.toml')) return 'toml';
		if (file.endsWith('.json')) return 'json';
		return 'text';
	}

	function onSourceHighlightReady(ready: boolean) {
		sourceHighlightReady = ready;
	}

	$effect(() => {
		if (!sourceHighlightReady || !sourceScroller) return;
		const line = highlightLines[0];
		if (line == null) return;
		const target = sourceScroller.querySelector(`[data-line="${String(line)}"]`);
		if (!(target instanceof HTMLElement)) return;
		const scroller = sourceScroller;
		const offset =
			target.getBoundingClientRect().top -
			scroller.getBoundingClientRect().top +
			scroller.scrollTop -
			scroller.clientHeight / 3;
		scroller.scrollTo({ top: Math.max(0, offset) });
	});
</script>

{#snippet classicFallback()}
	<DocClassic
		{detail}
		{ancestors}
		{model}
		{theme}
		{getNodeUrl}
		{openGraphHref}
		{onOpenGraph}
		{crateName}
		{crateVersion}
		{crateVersions}
	/>
{/snippet}

{#snippet splitFrame(sourceContent: string | null, repoUrl: string | null)}
	<div class="doc-split grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,44%)]">
		<article
			class="min-h-0 min-w-0 overflow-y-auto px-4 py-5 sm:px-8 sm:py-7 xl:border-r xl:border-(--panel-border-soft)"
		>
			<DocArticle
				{detail}
				{ancestors}
				{model}
				{theme}
				{getNodeUrl}
				{crateName}
				{crateVersion}
				{crateVersions}
				showBreadcrumb={false}
				className="doc-article--split"
			/>
		</article>

		<aside
			class="doc-split-source flex min-h-0 flex-col overflow-hidden bg-(--code-bg) text-(--code-ink)"
			aria-label={`Source for ${detail.node.name}`}
		>
			<div
				class="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-[color:var(--code-border)] bg-(--code-bg-soft) px-4 font-mono text-xs"
				style="color: var(--syntax-comment)"
			>
				<div class="flex min-w-0 items-center gap-2">
					<span class="truncate" title={displayFile}>{displayFile}</span>
					{#if lineLabel}
						<span
							class="shrink-0 rounded px-1.5 py-[1px] text-2xs"
							style="background: var(--accent-soft); color: var(--accent)"
						>
							{lineLabel}
						</span>
					{/if}
				</div>
				<SourceActions
					{repoUrl}
					{absolutePath}
					sourceFile={span?.file ?? ''}
					line={span?.line ?? 1}
					className="split-source-actions"
				/>
			</div>

			<div bind:this={sourceScroller} class="min-h-0 flex-1 overflow-auto">
				{#if sourceContent}
					<CodeBlock
						code={sourceContent}
						lang={langFromFile(displayFile)}
						{theme}
						startLine={1}
						{highlightLines}
						showLineNumbers={true}
						variant="flat"
						onHighlightStateChange={onSourceHighlightReady}
					/>
				{:else}
					<div
						class="flex h-full min-h-[280px] items-center justify-center gap-2 p-6 text-sm text-(--muted)"
					>
						<LoaderCircleIcon class="animate-spin" size={14} />
						<span>Loading source...</span>
					</div>
				{/if}
			</div>

			<div
				class="flex h-9 shrink-0 items-center gap-3 border-t border-[color:var(--code-border)] bg-(--code-bg-soft) px-4 font-mono text-xs"
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

{#if !span?.file || !sourceInput}
	{@render classicFallback()}
{:else if sourceLoaded && !sourceContent}
	{@render classicFallback()}
{:else}
	{@render splitFrame(sourceContent, repoUrl)}
{/if}

<style>
	.doc-split {
		background: var(--bg);
		min-height: 100%;
	}

	.doc-split-source {
		min-height: min(26rem, 70dvh);
		max-height: 70dvh;
	}

	.doc-split :global(.doc-article--split .doc-section h2) {
		font-size: var(--text-xl);
	}

	.doc-split :global(.doc-article--split > .max-w-3xl) {
		max-width: none;
	}

	.doc-split :global(.design-codeblock) {
		border-radius: 0;
	}

	.doc-split :global(.design-codeblock pre) {
		min-height: 100%;
	}

	@media (min-width: 1280px) {
		.doc-split {
			height: 100%;
			min-height: 0;
			max-height: 100%;
		}

		.doc-split-source {
			min-height: 0;
			max-height: none;
		}
	}
</style>
