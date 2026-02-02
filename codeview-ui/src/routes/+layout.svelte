<script lang="ts">
  import '../app.css';
  import { browser } from '$app/environment';
  import { afterNavigate, onNavigate } from '$app/navigation';
  import { getProcessingCrates } from '$lib/graph.remote';
  import { ProcessingStatusConnection } from '$lib/processing-status.svelte';
  import { isHosted } from '$lib/platform';
  import { onMount } from 'svelte';
  import { perf } from '$lib/perf';
  import { themeCtx, extLinkModeCtx, type Theme, type ExternalLinkMode } from '$lib/context';
  import { Loader2Icon } from '@lucide/svelte';

  let navSpan: ReturnType<typeof perf.begin> | null = null;

  onNavigate((navigation) => {
    const from = navigation.from?.url?.pathname ?? '';
    const to = navigation.to?.url?.pathname ?? '';
    navSpan = perf.begin('nav', `${from} → ${to}`);

    // View transitions disabled — they block on `navigation.complete` which includes
    // async data fetching (getNodeDetail). Cross-crate navs were taking 16+ seconds
    // because the browser held the old-page snapshot while waiting for the RPC.
    // The graph component has its own CSS transitions for smooth visual updates.
  });

  afterNavigate(() => {
    if (navSpan) {
      navSpan.end();
      navSpan = null;
    }
  });

  let { children } = $props();

  const processingConn = new ProcessingStatusConnection();
  const processingCount = $derived(processingConn.count);
  let showProcessing = $state(false);
  const processingListQuery = $derived(
    showProcessing ? getProcessingCrates({ refresh: processingCount }) : null
  );

  $effect(() => {
    if (!browser || !isHosted) return;
    processingConn.connect('rust');
    return () => processingConn.destroy();
  });

  const THEME_KEY = 'codeview-theme';
  const EXT_LINK_KEY = 'codeview-ext-link-mode';

  function getInitialExtLinkMode(): ExternalLinkMode {
    if (!browser) return 'codeview';
    const stored = localStorage.getItem(EXT_LINK_KEY);
    if (stored === 'codeview' || stored === 'docs') return stored;
    return 'codeview';
  }

  let extLinkMode = $state<ExternalLinkMode>('codeview');

  extLinkModeCtx.set(() => extLinkMode);

  function toggleExtLinkMode() {
    extLinkMode = extLinkMode === 'codeview' ? 'docs' : 'codeview';
    if (browser) localStorage.setItem(EXT_LINK_KEY, extLinkMode);
  }

  function getInitialTheme(): Theme {
    if (!browser) return 'light';
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  let theme = $state<Theme>('light');

  themeCtx.set(() => theme);

  function applyTheme(next: Theme) {
    theme = next;
    if (!browser) return;
    document.documentElement.dataset.theme = next;
    localStorage.setItem(THEME_KEY, next);
  }

  function toggleTheme() {
    applyTheme(theme === 'dark' ? 'light' : 'dark');
  }

  onMount(() => {
    applyTheme(getInitialTheme());
    extLinkMode = getInitialExtLinkMode();
  });
</script>

<svelte:head>
  <title>Codeview</title>
</svelte:head>

<div class="flex h-screen flex-col bg-[var(--bg)]">
  <!-- Header -->
  <header
    class="flex items-center justify-between border-b border-[var(--panel-border)] bg-[var(--panel-solid)] px-6 py-3 text-sm text-[var(--muted)] shadow-[0_8px_24px_rgba(38,28,20,0.06)]"
  >
    <a href="/" class="text-base font-semibold tracking-tight text-[var(--ink)]">Codeview</a>
    <div class="flex items-center gap-2">
      {#if processingCount > 0}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="relative"
          onmouseenter={() => showProcessing = true}
          onmouseleave={() => showProcessing = false}
        >
          <span class="badge badge-sm" title="Background parses running">
            Parsing {processingCount}
          </span>
          {#if showProcessing}
            <div
              class="absolute right-0 mt-2 w-64 rounded-[var(--radius-card)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel-solid)] p-2 shadow-[var(--shadow-soft)] z-20"
            >
              <div class="px-2 pb-1 text-[10px] uppercase tracking-wider text-[var(--muted)]">
                Background parses
              </div>
              {#if processingListQuery}
                <svelte:boundary>
                  {#snippet pending()}
                    <div class="flex items-center gap-2 px-2 py-2 text-xs text-[var(--muted)]">
                      <Loader2Icon class="animate-spin" size={12} />
                      Loading...
                    </div>
                  {/snippet}
                  {@const crates = await processingListQuery}
                  {#if crates && crates.length > 0}
                    <div class="space-y-1">
                      {#each crates as crate (crate.name)}
                        <div class="flex items-center justify-between gap-2 rounded-[var(--radius-chip)] corner-squircle bg-[var(--panel)] px-2 py-1">
                          <span class="text-xs font-medium text-[var(--ink)] truncate">{crate.name}</span>
                          <span class="badge badge-sm">{crate.version}</span>
                        </div>
                      {/each}
                    </div>
                  {:else}
                    <div class="px-2 py-2 text-xs text-[var(--muted)]">No active parses</div>
                  {/if}
                </svelte:boundary>
              {:else}
                <div class="px-2 py-2 text-xs text-[var(--muted)]">No active parses</div>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
      <button
        type="button"
        class="inline-flex items-center gap-2 rounded-[var(--radius-chip)] corner-squircle px-2 py-1 text-xs font-medium text-[var(--muted)] transition hover:bg-[var(--panel-strong)] hover:text-[var(--ink)]"
        aria-pressed={extLinkMode === 'docs'}
        title={extLinkMode === 'docs' ? 'External links open docs.rs — click to use codeview' : 'External links stay in codeview — click to use docs.rs'}
        onclick={toggleExtLinkMode}
      >
        <span
          class="h-2 w-2 rounded-full"
          style="background-color: {extLinkMode === 'docs' ? 'var(--accent)' : 'var(--muted)'}"
        ></span>
        <span>{extLinkMode === 'docs' ? 'docs.rs' : 'Codeview'}</span>
      </button>
      <button
        type="button"
        class="inline-flex items-center gap-2 rounded-[var(--radius-chip)] corner-squircle px-2 py-1 text-xs font-medium text-[var(--muted)] transition hover:bg-[var(--panel-strong)] hover:text-[var(--ink)]"
        aria-pressed={theme === 'dark'}
        title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        onclick={toggleTheme}
      >
        <span
          class="h-2 w-2 rounded-full"
          style="background-color: {theme === 'dark' ? 'var(--accent)' : 'var(--muted)'}"
        ></span>
        <span>{theme === 'dark' ? 'Dark' : 'Light'}</span>
      </button>
    </div>
  </header>

  {@render children()}
</div>
