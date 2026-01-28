<script lang="ts">
  import '../app.css';
  import { browser } from '$app/environment';
  import { onMount, setContext } from 'svelte';

  let { children } = $props();

  type Theme = 'light' | 'dark';
  const THEME_KEY = 'codeview-theme';

  function getInitialTheme(): Theme {
    if (!browser) return 'light';
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  let theme = $state<Theme>('light');

  setContext('theme', () => theme);

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
  });
</script>

<svelte:head>
  <title>Codeview</title>
</svelte:head>

<div class="flex h-screen flex-col bg-[var(--bg)]">
  <!-- Header -->
  <header class="flex items-center justify-between border-b border-[var(--panel-border)] bg-[var(--panel-solid)] px-4 py-2">
    <div class="flex items-center gap-4">
      <a href="/" class="text-lg font-semibold text-[var(--ink)] hover:text-[var(--accent)]">Codeview</a>
    </div>
    <div class="flex items-center gap-2">
      <button
        type="button"
        class="inline-flex items-center gap-2 rounded-[var(--radius-control)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel-solid)] px-3 py-1.5 text-xs font-medium text-[var(--muted)] transition hover:bg-[var(--panel-strong)] hover:text-[var(--ink)]"
        aria-pressed={theme === 'dark'}
        title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        onclick={toggleTheme}
      >
        <span
          class="h-2 w-2 rounded-full"
          style="background-color: {theme === 'dark' ? 'var(--accent)' : 'var(--muted)'}"
        ></span>
        <span>{theme === 'dark' ? 'Dark mode' : 'Light mode'}</span>
      </button>
    </div>
  </header>

  {@render children()}
</div>
