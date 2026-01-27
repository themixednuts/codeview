<script lang="ts">
  import {
    parseDocumentation,
    highlightDocumentation,
    type SupportedLanguage
  } from '$lib/highlight';
  import CodeBlock from './CodeBlock.svelte';

  let {
    docs,
    defaultLang = 'rust',
    theme = 'dark'
  } = $props<{
    docs: string;
    defaultLang?: SupportedLanguage;
    theme?: 'dark' | 'light';
  }>();

  // Parse documentation into segments
  const segments = $derived(parseDocumentation(docs, defaultLang));

  // Track highlighted HTML for code blocks
  let highlightedSegments = $state<
    Array<{ type: 'text' | 'code'; content: string; html?: string }>
  >([]);

  $effect(() => {
    highlightDocumentation(segments, theme).then((result) => {
      highlightedSegments = result;
    });
  });
</script>

<div class="documentation space-y-3">
  {#each highlightedSegments as segment, i (i)}
    {#if segment.type === 'text'}
      <p class="documentation-text whitespace-pre-wrap text-sm text-[var(--ink)] leading-relaxed">{segment.content}</p>
    {:else if segment.type === 'code' && segment.html}
      <div class="code-block overflow-x-auto rounded-lg text-sm">
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

  .code-block :global(pre) {
    margin: 0;
    padding: 0.75rem;
    border-radius: 0.5rem;
    overflow-x: auto;
  }

  .code-block :global(code) {
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 0.8125rem;
    line-height: 1.5;
  }
</style>
