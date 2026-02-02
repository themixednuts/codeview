<script lang="ts">
  import {
    parseDocumentation,
    highlightDocumentation,
    type SupportedLanguage,
    type DocLinks
  } from '$lib/highlight';
  import { goto } from '$app/navigation';
  import { externalDocsUrl } from '$lib/docs-url';
  import CodeBlock from './CodeBlock.svelte';
  import { extLinkModeCtx } from '$lib/context';

  const extLinkMode = $derived(extLinkModeCtx.get());

  let {
    docs,
    defaultLang = 'rust',
    theme = 'light',
    docLinks = {},
    getNodeUrl,
    nodeExists
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

  // Track highlighted HTML for all segments
  let highlightedSegments = $state<
    Array<{ type: 'text' | 'code'; content: string; html: string }>
  >([]);

  $effect(() => {
    highlightDocumentation(segments, theme).then((result) => {
      highlightedSegments = result;
    });
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
      goto(getNodeUrl(nodeId), { noScroll: true });
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ' ') {
      handleClick(event);
    }
  }
</script>

<div
  class="documentation space-y-3"
  role="presentation"
  onclick={handleClick}
  onkeydown={handleKeydown}
>
  {#each highlightedSegments as segment, i (i)}
    {#if segment.type === 'text'}
      <div class="documentation-text prose prose-sm text-[var(--ink)]">
        {@html segment.html}
      </div>
    {:else if segment.type === 'code' && segment.html}
      <div class="code-block overflow-x-auto rounded-[var(--radius-control)] corner-squircle text-sm">
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

  .code-block :global(pre) {
    margin: 0;
    padding: 0.75rem;
    border-radius: var(--radius-control);
    overflow-x: auto;
    background: var(--code-bg) !important;
    border: 1px solid var(--code-border);
  }

  .code-block :global(code) {
    font-family: var(--font-code);
    font-size: 0.8125rem;
    line-height: 1.6;
    color: var(--code-ink);
  }
</style>
