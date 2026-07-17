<script lang="ts">
	import { parseDocumentation } from '$lib/highlight/documentation';
	import type { SupportedLanguage } from '$lib/highlight/languages';
	import type { DocLinks } from '$lib/highlight/markdown';
	import { resolveAppPath } from '$lib/app-paths';
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
		compact = false,
	} = $props<{
		docs: string;
		defaultLang?: SupportedLanguage;
		theme?: 'dark' | 'light';
		docLinks?: DocLinks;
		/** Returns URL for navigating to a node */
		getNodeUrl?: (id: string) => string;
		compact?: boolean;
	}>();

	const resolveDocLink = $derived.by(() => {
		if (!getNodeUrl) return undefined;
		return (nodeId: string) => resolveAppPath(getNodeUrl(nodeId));
	});

	// Resolve route hrefs while rendering so links work before hydration and
	// remain ordinary progressively-enhanced SvelteKit navigation afterward.
	const segments = $derived(parseDocumentation(docs, defaultLang, docLinks, resolveDocLink));

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

		const nodeId = link.dataset.nodeId;
		if (!nodeId) return;

		if (extLinkMode === 'docs') {
			event.preventDefault();
			// Documentation links don't carry kind info, so externalDocsUrl uses fallback path
			window.open(externalDocsUrl(nodeId), '_blank', 'noopener,noreferrer');
		}
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="documentation"
	class:space-y-3={!compact}
	class:documentation-compact={compact}
	onclick={handleClick}
>
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
		max-inline-size: var(--doc-prose-measure, 70ch);
		font-family: var(--font-prose);
		font-size: var(--doc-fs, 1.0625rem);
		font-size-adjust: 0.52;
		line-height: var(--doc-leading, 1.65);
	}

	.documentation-text :global(p) {
		margin: 0 0 0.9em;
		line-height: inherit;
	}

	.documentation-text :global(p:first-child) {
		margin-top: 0;
	}

	.documentation-text :global(p:last-child) {
		margin-bottom: 0;
	}

	.documentation-compact .documentation-text :global(p) {
		margin: 0;
	}

	.documentation-compact .documentation-text {
		font-size: inherit;
		line-height: inherit;
	}

	/* Prose headings use the neutral interface face for fast scanning. */
	.documentation-text :global(h1),
	.documentation-text :global(h2),
	.documentation-text :global(h3),
	.documentation-text :global(h4),
	.documentation-text :global(h5),
	.documentation-text :global(h6) {
		font-family: var(--font-display);
		font-weight: 600;
		letter-spacing: 0;
		color: var(--ink);
		line-height: 1.25;
	}
	.documentation-text :global(h1) {
		font-size: 1.45em;
		margin-top: 1.75em;
		margin-bottom: 0.5em;
	}
	.documentation-text :global(h2) {
		font-size: 1.28em;
		margin-top: 1.55em;
		margin-bottom: 0.45em;
	}
	.documentation-text :global(h3) {
		font-size: 1.12em;
		margin-top: 1.35em;
		margin-bottom: 0.4em;
	}
	.documentation-text :global(h4),
	.documentation-text :global(h5),
	.documentation-text :global(h6) {
		font-size: 1em;
		margin-top: 1.2em;
		margin-bottom: 0.35em;
	}

	.documentation-text :global(a) {
		color: var(--accent);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.documentation-text :global(a:hover) {
		text-decoration-thickness: 2px;
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
		font-size: 0.9em;
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
		margin: 0.45em 0;
	}
</style>
