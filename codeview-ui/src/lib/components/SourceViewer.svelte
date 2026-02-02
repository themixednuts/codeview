<script lang="ts">
  import type { Span } from '$lib/graph';
  import { Loader2Icon } from '@lucide/svelte';
  import { pushState } from '$app/navigation';
  import { page } from '$app/state';
  import { browser } from '$app/environment';
  import { getSource } from '$lib/source.remote';
  import { cached, cacheKey } from '$lib/query-cache.svelte';
  import { Memo } from '$lib/reactivity.svelte';
  import { isHosted } from '$lib/platform';
  import CodeBlock from './CodeBlock.svelte';
  import X from '@lucide/svelte/icons/x';
  let {
    span,
    theme = 'light',
    crateName,
    crateVersion
  } = $props<{
    span: Span;
    theme?: 'dark' | 'light';
    crateName?: string;
    crateVersion?: string;
  }>();


  let modalBody = $state<HTMLDivElement | null>(null);
  let lastScrollKey: string | null = null;

  /** Unique key for this span */
  const spanKey = $derived(`${span.file}:${span.line}:${span.end_line ?? span.line}`);

  const isOpen = $derived(browser && page.state?.sourceSpanKey === spanKey);

  const sourceQuery = $derived(
    isOpen
      ? cached(
          cacheKey('source', crateName ?? 'workspace', span.file),
          getSource({ file: span.file })
        )
      : null
  );
  const isLoading = $derived(sourceQuery?.loading ?? false);
  const sourcePreview = $derived(sourceQuery?.current ?? null);

  function open() {
    if (isHosted && crateName) {
      const targetVersion = crateVersion ?? 'latest';
      const url = docsSourceUrl(crateName, targetVersion, span.file);
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    pushState('', { ...page.state, sourceSpanKey: spanKey });
  }

  function close() {
    history.back();
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) close();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') close();
  }

  const highlightRangeMemo = new Memo(() => {
    const start = span.line;
    const end = span.end_line ?? span.line;
    const lines: number[] = [];
    for (let i = start; i <= end; i++) lines.push(i);
    return lines;
  });
  const highlightRange = $derived(highlightRangeMemo.current);

  // Scroll to highlighted line when content is ready
  function scrollToHighlight(container: HTMLDivElement) {
    requestAnimationFrame(() => {
      const firstHighlighted = container.querySelector('.line.highlighted');
      if (firstHighlighted) {
        const lineTop = (firstHighlighted as HTMLElement).offsetTop;
        const offset = Math.max(0, lineTop - container.clientHeight / 3);
        container.scrollTo({ top: offset, behavior: 'instant' });
      }
    });
  }

  $effect(() => {
    if (!isOpen) {
      lastScrollKey = null;
      return;
    }
    if (!modalBody || !sourcePreview?.content) return;
    if (lastScrollKey === spanKey) return;
    lastScrollKey = spanKey;
    scrollToHighlight(modalBody);
  });

  function langFromFile(file: string): 'rust' | 'toml' | 'json' | 'text' {
    if (file.endsWith('.rs')) return 'rust';
    if (file.endsWith('.toml')) return 'toml';
    if (file.endsWith('.json')) return 'json';
    return 'text';
  }

  function docsSourceUrl(crate: string, version: string, file: string): string {
    const cleaned = file.replace(/^\.\/+/, '');
    const path = cleaned.startsWith('src/') ? cleaned : `src/${cleaned}`;
    return `https://docs.rs/${crate}/${version}/src/${crate}/${path}.html`;
  }
</script>

<svelte:window onkeydown={isOpen ? handleKeydown : undefined} />

<button
  type="button"
  class="source-link"
  onclick={open}
  title="View source"
>
  <span class="token-name">{span.file}</span><span class="token-meta">:{span.line}:{span.column}</span>
  {#if isLoading}
    <Loader2Icon class="inline-block animate-spin" size={12} />
  {/if}
</button>

{#if isOpen}
  <div class="modal-backdrop" role="presentation" onclick={handleBackdropClick}>
    <div class="modal-panel" role="dialog" aria-modal="true" aria-label="Source: {span.file}">
      <header class="modal-header">
        <div class="modal-title">
          <span class="modal-file">{span.file}</span>
          <span class="modal-line">:{span.line}:{span.column}</span>
        </div>
        <button type="button" class="modal-close" onclick={close} aria-label="Close">
          <X size={18} />
        </button>
      </header>
      <div class="modal-body" bind:this={modalBody}>
        <svelte:boundary>
          {@const result = sourceQuery ? await sourceQuery : null}
          {#if result?.error}
            <p class="source-error">{result.error}</p>
          {:else if result?.content}
            <CodeBlock
              code={result.content}
              lang={langFromFile(span.file)}
              {theme}
              startLine={1}
              highlightLines={highlightRange}
              showLineNumbers={true}
            />
          {:else}
            <p class="source-error">Source unavailable.</p>
          {/if}
          {#snippet pending()}
            <div class="flex items-center gap-2 p-4 text-xs text-[var(--muted)]">
              <Loader2Icon class="animate-spin" size={12} />
              Loading source...
            </div>
          {/snippet}
          {#snippet failed(error, reset)}
            <div class="p-4 text-xs text-[var(--danger)]">
              <p>Failed to load source</p>
              <button type="button" class="mt-2 text-[var(--accent)] hover:underline" onclick={reset}>Retry</button>
            </div>
          {/snippet}
        </svelte:boundary>
      </div>
    </div>
  </div>
{/if}

<style>
  .source-link {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-family: var(--font-code);
    font-size: 0.8125rem;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: var(--ink);
    transition: color 0.15s;
  }

  .source-link:hover {
    color: var(--accent);
  }


  .modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(4px);
    padding: 2rem;
  }

  .modal-panel {
    display: flex;
    flex-direction: column;
    width: min(90vw, 900px);
    max-height: 85vh;
    border-radius: var(--radius-panel, 12px);
    border: 1px solid var(--panel-border);
    background: var(--panel-solid);
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.4);
    overflow: hidden;
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--panel-border);
    flex-shrink: 0;
  }

  .modal-title {
    font-family: var(--font-code);
    font-size: 0.875rem;
  }

  .modal-file {
    font-weight: 600;
    color: var(--ink);
  }

  .modal-line {
    color: var(--accent);
  }

  .modal-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    border: none;
    background: none;
    color: var(--muted);
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }

  .modal-close:hover {
    background: var(--panel-strong);
    color: var(--ink);
  }

  .modal-body {
    overflow: auto;
    flex: 1;
    min-height: 0;
  }

  .modal-body :global(pre) {
    margin: 0;
    border-radius: 0;
    border: none;
  }

  .source-error {
    color: var(--error, #dc2626);
    font-size: 0.8125rem;
    padding: 1rem;
  }
</style>
