<script lang="ts">
	import { parseDocumentation } from '$lib/highlight/documentation';
	import type { SupportedLanguage } from '$lib/highlight/languages';
	import type { DocLinks } from '$lib/highlight/markdown';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
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

	// Parse documentation into segments (with intra-doc link resolution)
	const segments = $derived(parseDocumentation(docs, defaultLang, docLinks));

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
	{#each segments as segment, i (i)}
		{#if segment.type === 'text'}
			<div class="documentation-text prose prose-sm text-(--ink)">
				<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized markdown-it output -->
				{@html segment.html}
			</div>
		{:else if segment.type === 'code'}
			<CodeBlock code={segment.content} lang={segment.lang} {theme} />
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

	/* doc-classic styling for in-prose headings (Examples / Safety / etc.).
	   Markdown `## Heading` / `### Heading` lands here. Use Fraunces with a
	   modest size step per level so they read as part of the same family
	   as the page-level Documentation/Methods section headers. */
	.documentation-text :global(h1),
	.documentation-text :global(h2),
	.documentation-text :global(h3),
	.documentation-text :global(h4),
	.documentation-text :global(h5),
	.documentation-text :global(h6) {
		font-family: var(--font-display);
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--ink);
		line-height: 1.25;
	}
	.documentation-text :global(h1) {
		font-size: 20px;
		margin-top: 1.5rem;
		margin-bottom: 0.5rem;
	}
	.documentation-text :global(h2) {
		font-size: 17px;
		margin-top: 1.25rem;
		margin-bottom: 0.5rem;
	}
	.documentation-text :global(h3) {
		font-size: 15px;
		margin-top: 1rem;
		margin-bottom: 0.4rem;
	}
	.documentation-text :global(h4),
	.documentation-text :global(h5),
	.documentation-text :global(h6) {
		font-size: 13.5px;
		margin-top: 0.75rem;
		margin-bottom: 0.3rem;
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
