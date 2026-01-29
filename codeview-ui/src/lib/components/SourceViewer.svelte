<script lang="ts">
  import type { Span } from '$lib/graph';
  import { pushState } from '$app/navigation';
  import { page } from '$app/state';
  import { browser } from '$app/environment';
  import { getSource } from '$lib/source.remote';
  import { Memo } from '$lib/reactivity.svelte';
  import { getContext } from 'svelte';
  import CodeBlock from './CodeBlock.svelte';
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
  const isHosted = $derived(getContext<() => boolean>('isHosted')?.() ?? false);


  let source = $state<{ error: string | null; content: string | null } | null>(null);
  let loading = $state(false);

  /** Unique key for this span */
  const spanKey = $derived(`${span.file}:${span.line}:${span.end_line ?? span.line}`);

  const isOpen = $derived(browser && page.state?.sourceSpanKey === spanKey);

  async function open() {
    if (isHosted && crateName) {
      const targetVersion = crateVersion ?? 'latest';
      const url = docsSourceUrl(crateName, targetVersion, span.file);
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    if (!source) {
      loading = true;
      try {
        source = await getSource({ file: span.file });
      } catch {
        source = { error: 'Failed to fetch source', content: null };
      }
      loading = false;
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

  // Auto-fetch source when state opens this modal
  $effect(() => {
    if (isOpen && !source && !loading) {
      loading = true;
      getSource({ file: span.file })
        .then((result) => { source = result; })
        .catch(() => { source = { error: 'Failed to fetch source', content: null }; })
        .finally(() => { loading = false; });
    }
  });

  // Scroll to highlighted line when modal body mounts
  function attachModalBody(container: HTMLDivElement) {
    // Wait for CodeBlock to render, then scroll
    requestAnimationFrame(() => {
      const firstHighlighted = container.querySelector('.line.highlighted');
      if (firstHighlighted) {
        const lineTop = (firstHighlighted as HTMLElement).offsetTop;
        const offset = Math.max(0, lineTop - container.clientHeight / 3);
        container.scrollTo({ top: offset, behavior: 'instant' });
      }
    });
  }

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
  {#if loading}
    <span class="loading-indicator"></span>
  {/if}
</button>

{#if isOpen && source}
  <div class="modal-backdrop" role="presentation" onclick={handleBackdropClick}>
    <div class="modal-panel" role="dialog" aria-modal="true" aria-label="Source: {span.file}">
      <header class="modal-header">
        <div class="modal-title">
          <span class="modal-file">{span.file}</span>
          <span class="modal-line">:{span.line}:{span.column}</span>
        </div>
        <button type="button" class="modal-close" onclick={close} aria-label="Close">
          <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>
      </header>
      <div class="modal-body" {@attach attachModalBody}>
        {#if source.error}
          <p class="source-error">{source.error}</p>
        {:else if source.content}
          <CodeBlock
            code={source.content}
            lang={langFromFile(span.file)}
            {theme}
            startLine={1}
            highlightLines={highlightRange}
            showLineNumbers={true}
          />
        {/if}
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

  .loading-indicator {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 1.5px solid var(--muted);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
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
