<script lang="ts">
  import { highlightCode, type SupportedLanguage } from '$lib/highlight';

  let {
    code,
    lang = 'rust',
    theme = 'dark'
  } = $props<{
    code: string;
    lang?: SupportedLanguage;
    theme?: 'dark' | 'light';
  }>();

  let highlightedHtml = $state<string | null>(null);

  $effect(() => {
    highlightCode(code, lang, theme).then((html) => {
      highlightedHtml = html;
    });
  });
</script>

<div class="code-block overflow-x-auto rounded-lg text-sm">
  {#if highlightedHtml}
    {@html highlightedHtml}
  {:else}
    <pre class="p-3 bg-[#24292e] text-[#e1e4e8] rounded-lg"><code>{code}</code></pre>
  {/if}
</div>

<style>
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
