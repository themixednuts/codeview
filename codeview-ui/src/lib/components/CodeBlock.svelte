<script lang="ts">
  import { highlightCode, type SupportedLanguage } from '$lib/highlight';

  let {
    code,
    lang = 'rust',
    theme = 'light',
    variant = 'default',
    startLine,
    highlightLines,
    showLineNumbers = false
  } = $props<{
    code: string;
    lang?: SupportedLanguage;
    theme?: 'dark' | 'light';
    variant?: 'default' | 'flat';
    startLine?: number;
    highlightLines?: number[];
    showLineNumbers?: boolean;
  }>();

  let highlightedHtml = $state<string | null>(null);

  $effect(() => {
    highlightCode(code, lang, theme, { startLine, highlightLines, showLineNumbers }).then((html) => {
      highlightedHtml = html;
    });
  });
</script>

<div
  class="code-block overflow-x-auto rounded-[var(--radius-control)] corner-squircle text-sm"
  class:code-block--flat={variant === 'flat'}
>
  {#if highlightedHtml}
    {@html highlightedHtml}
  {:else}
    <pre class="rounded-[var(--radius-control)] corner-squircle border border-[var(--code-border)] bg-[var(--code-bg)] p-3 text-[var(--code-ink)]">
      <code>{code}</code>
    </pre>
  {/if}
</div>

<style>
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

  .code-block--flat :global(pre) {
    margin: 0;
    padding: 0;
    border-radius: 0;
    background: transparent !important;
    border: none;
  }

  .code-block :global(.line.has-line-number)::before {
    content: attr(data-line);
    display: inline-block;
    width: 3ch;
    margin-right: 1.5ch;
    text-align: right;
    color: var(--muted, #6e7781);
    opacity: 0.5;
    user-select: none;
  }

  .code-block :global(.line.highlighted) {
    background: var(--highlight-bg, rgba(255, 213, 0, 0.12));
    display: inline-block;
    width: 100%;
  }
</style>
