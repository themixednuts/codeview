<script lang="ts">
	import {
		parseDocumentation,
		highlightDocumentation,
		type SupportedLanguage,
		type DocLinks,
	} from '$lib/highlight';
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { tick } from 'svelte';
	import { externalDocsUrl } from '$lib/docs';
	import CodeBlock from './CodeBlock.svelte';
	import { extLinkModeCtx } from '$lib/context';

	const extLinkMode = $derived(extLinkModeCtx.get());

	let {
		docs,
		defaultLang = 'rust',
		theme = 'light',
		docLinks = {},
		getNodeUrl,
		nodeExists,
	} = $props<{
		docs: string;
		defaultLang?: SupportedLanguage;
		theme?: 'dark' | 'light';
		docLinks?: DocLinks;
		/** Returns URL for navigating to a node */
		getNodeUrl?: (id: string) => string;
		/** Check if a node exists in the graph (for determining internal vs external links) */
		nodeExists?: (nodeId: string) => boolean;
	}>();

	type RenderedSegment = { type: 'text' | 'code'; content: string; html: string };

	// Parse documentation into segments (with intra-doc link resolution)
	const segments = $derived(parseDocumentation(docs, defaultLang, docLinks));

	function escapeHtml(text: string): string {
		return text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#039;');
	}

	function buildPlainCodeHtml(code: string): string {
		return `<pre class="shiki"><code>${escapeHtml(code)}</code></pre>`;
	}

	const fallbackSegments = $derived.by<RenderedSegment[]>(() =>
		segments.map((segment) =>
			segment.type === 'code'
				? { type: 'code', content: segment.content, html: buildPlainCodeHtml(segment.content) }
				: { type: 'text', content: segment.content, html: segment.html },
		),
	);

	let highlightedOverride = $state<RenderedSegment[] | null>(null);
	const highlightedSegments = $derived(highlightedOverride ?? fallbackSegments);

	$effect(() => {
		highlightedOverride = null;
		if (!browser) return;
		let cancelled = false;
		highlightDocumentation(segments, theme).then(async (result) => {
			if (cancelled) return;
			await tick();
			if (cancelled) return;
			highlightedOverride = result;
		});
		return () => {
			cancelled = true;
		};
	});

	/**
	 * Handle clicks on the documentation container.
	 * Uses event delegation to catch clicks on intra-doc links.
	 *
	 * When extLinkMode is 'docs', opens external docs in a new tab.
	 * Otherwise navigates within codeview.
	 */
	function handleClick(event: Event) {
		const target = event.target as HTMLElement;
		const link = target.closest('a.intra-doc-link') as HTMLAnchorElement | null;

		if (!link) return;

		event.preventDefault();

		const nodeId = link.dataset.nodeId;
		if (!nodeId) return;

		if (extLinkMode === 'docs') {
			// Documentation links don't carry kind info, so externalDocsUrl uses fallback path
			window.open(externalDocsUrl(nodeId), '_blank', 'noopener,noreferrer');
			return;
		}

		// Navigate within codeview
		if (getNodeUrl) {
			goto(resolve(getNodeUrl(nodeId)), { noScroll: true });
		}
	}

</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="documentation space-y-3" onclick={handleClick}>
	{#each highlightedSegments as segment, i (i)}
		{#if segment.type === 'text'}
			<div class="documentation-text prose prose-sm text-(--ink)">
				<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized markdown-it output -->
				{@html segment.html}
			</div>
		{:else if segment.type === 'code' && segment.html}
			<div class="code-block corner-squircle overflow-x-auto rounded-(--radius-control) text-sm">
				<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized Shiki output -->
				{@html segment.html}
			</div>
		{:else if segment.type === 'code'}
			<CodeBlock code={segment.content} lang={defaultLang} {theme} />
		{/if}
	{/each}
</div>

<style>
	.documentation-text {
		font-family: var(--font-body);
	}

	.documentation-text :global(p) {
		margin: 0.5rem 0;
		line-height: 1.6;
	}

	.documentation-text :global(p:first-child) {
		margin-top: 0;
	}

	.documentation-text :global(p:last-child) {
		margin-bottom: 0;
	}

	.documentation-text :global(a) {
		color: var(--accent);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.documentation-text :global(a:hover) {
		opacity: 0.8;
	}

	/* Intra-doc links (links to other items in the crate) */
	.documentation-text :global(a.intra-doc-link) {
		cursor: pointer;
	}

	.documentation-text :global(a.intra-doc-link code) {
		color: var(--accent);
	}

	.documentation-text :global(code) {
		font-family: var(--font-code);
		font-size: 0.875em;
		background: var(--code-bg);
		padding: 0.125rem 0.375rem;
		border-radius: 0.25rem;
		border: 1px solid var(--code-border);
	}

	.documentation-text :global(img) {
		display: inline;
	}

	.documentation-text :global(strong) {
		font-weight: 600;
	}

	.documentation-text :global(ul),
	.documentation-text :global(ol) {
		margin: 0.5rem 0;
		padding-left: 1.5rem;
	}

	.documentation-text :global(li) {
		margin: 0.25rem 0;
	}

</style>
