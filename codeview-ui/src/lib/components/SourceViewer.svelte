<script lang="ts">
  import type { Span } from '$lib/graph';
  import type { Attachment } from 'svelte/attachments';
  import { Loader2Icon } from '@lucide/svelte';
  import { pushState } from '$app/navigation';
  import { page } from '$app/state';
  import { browser } from '$app/environment';
  import { getSource } from '$lib/rpc/source.remote';
  import { cached, cacheKey } from '$lib/cache.svelte';
  import { sourceProviderModeCtx } from '$lib/context';
  import CodeBlock from './CodeBlock.svelte';
  import X from '@lucide/svelte/icons/x';

  interface Props {
    span: Span;
    theme?: 'dark' | 'light';
    crateName?: string;
    crateVersion?: string;
  }

  let {
    span,
    theme = 'light',
    crateName,
    crateVersion
  }: Props = $props();

  const sourceProviderMode = $derived(sourceProviderModeCtx.getOr('auto'));

  /** Unique key for this span */
  const spanKey = $derived(`${span.file}:${span.line}:${span.end_line ?? span.line}`);

  const isOpen = $derived(browser && page.state?.sourceSpanKey === spanKey);

  const sourceQuery = $derived(
    isOpen
      ? cached(
          cacheKey('source', sourceProviderMode, crateName ?? 'workspace', crateVersion ?? 'unknown', span.file),
          getSource({ file: span.file, crateName, crateVersion, sourceProvider: sourceProviderMode })
        )
      : null
  );
  const isLoading = $derived(sourceQuery?.loading ?? false);
  const sourceContent = $derived(sourceQuery?.current?.content ?? null);

  const highlightRange = $derived.by(() => {
    const start = span.line;
    const end = span.end_line ?? span.line;
    const lines: number[] = [];
    for (let i = start; i <= end; i++) lines.push(i);
    return lines;
  });

  function open() {
    pushState('', { ...page.state, sourceSpanKey: spanKey });
  }

  function close() {
    history.back();
  }

  function handleDialogClose() {
    if (isOpen) history.back();
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) close();
  }

  function langFromFile(file: string): 'rust' | 'toml' | 'json' | 'text' {
    if (file.endsWith('.rs')) return 'rust';
    if (file.endsWith('.toml')) return 'toml';
    if (file.endsWith('.json')) return 'json';
    return 'text';
  }

  // Attachment to sync dialog open/close with isOpen state
  const syncDialog: Attachment<HTMLDialogElement> = (dialog) => {
    $effect(() => {
      if (isOpen && !dialog.open) {
        dialog.showModal();
      } else if (!isOpen && dialog.open) {
        dialog.close();
      }
    });
  };

  // Attachment to scroll to highlighted line when content loads
  const scrollToHighlight: Attachment<HTMLDivElement> = (container) => {
    let lastKey: string | null = null;
    
    $effect(() => {
      if (!isOpen || !sourceContent) {
        lastKey = null;
        return;
      }
      if (lastKey === spanKey) return;
      lastKey = spanKey;
      
      requestAnimationFrame(() => {
        const firstHighlighted = container.querySelector('.line.highlighted');
        if (firstHighlighted) {
          const lineTop = (firstHighlighted as HTMLElement).offsetTop;
          const offset = Math.max(0, lineTop - container.clientHeight / 3);
          container.scrollTo({ top: offset, behavior: 'instant' });
        }
      });
    });
  };
</script>

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

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<dialog
  {@attach syncDialog}
  onclose={handleDialogClose}
  onclick={handleBackdropClick}
  aria-label="Source: {span.file}"
>
  <div class="modal-panel">
    <header class="modal-header">
      <div class="modal-title">
        <span class="modal-file">{span.file}</span>
        <span class="modal-line">:{span.line}:{span.column}</span>
      </div>
      <button type="button" class="modal-close" onclick={close} aria-label="Close">
        <X size={18} />
      </button>
    </header>
    <div class="modal-body" {@attach scrollToHighlight}>
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
          <div class="flex items-center gap-2 p-4">
            <Loader2Icon class="animate-spin" size={12} />
            <span class="text-xs text-[var(--muted)]">Loading source...</span>
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
</dialog>

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

  dialog {
    padding: 0;
    border: none;
    background: transparent;
    max-width: none;
    max-height: none;
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  dialog::backdrop {
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(4px);
  }

  dialog:not([open]) {
    display: none;
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
