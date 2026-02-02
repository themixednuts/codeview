<script lang="ts">
  import { Debounced } from 'runed';
  import { Loader2Icon } from '@lucide/svelte';
  import { getCrates, getTopCrates, searchRegistry } from '$lib/graph.remote';
  import { cached, cacheKey } from '$lib/cache.svelte';

  const workspaceCrates = $derived(
    (await cached(cacheKey('workspaceCrates'), getCrates())).map((crate) => ({
      id: crate.id,
      name: crate.name,
      version: crate.version
    }))
  );
  const topCrates = $derived(
    (await cached(cacheKey('topCrates'), getTopCrates())).map((crate) => ({
      id: crate.name,
      name: crate.name,
      version: crate.version,
      description: crate.description
    }))
  );

  let searchInput = $state('');
  const searchTerm = $derived(searchInput.trim());
  const debouncedSearch = new Debounced(() => searchTerm, 250);
  const debouncedTerm = $derived(debouncedSearch.current);

  // True while the user is typing but debounce hasn't fired yet
  const isDebouncing = $derived(searchTerm.length >= 2 && searchTerm !== debouncedTerm);

  // TODO: abort in-flight searches when the term changes once SvelteKit
  // remote functions support abort signals: https://github.com/sveltejs/kit/issues/14502
  const searchQuery = $derived(
    debouncedTerm.length >= 2 ? searchRegistry(debouncedTerm) : null
  );
  const showSearchResults = $derived(searchTerm.length >= 2);
</script>

<div class="flex flex-1 overflow-auto">
  <div class="mx-auto flex w-full max-w-6xl flex-col gap-10 px-6 py-10">
    <div class="relative">
      <input
        id="global-search"
        type="search"
        placeholder="Search crates, types, functions..."
        bind:value={searchInput}
        class="w-full rounded-[var(--radius-control)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel-solid)] px-4 py-2.5 text-sm outline-none focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
      />
      {#if showSearchResults}
        <div
          class="absolute left-0 right-0 z-30 mt-2 rounded-[var(--radius-card)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel-solid)] p-3 shadow-[var(--shadow-soft)]"
        >
          {#if isDebouncing}
            <p class="flex items-center gap-2 text-xs text-[var(--muted)]">
              <Loader2Icon class="animate-spin" size={12} />
              Searching...
            </p>
          {:else if searchQuery}
            <svelte:boundary>
              {#snippet pending()}
                <p class="flex items-center gap-2 text-xs text-[var(--muted)]">
                  <Loader2Icon class="animate-spin" size={12} />
                  Searching...
                </p>
              {/snippet}
              {@const results = (await searchQuery).slice(0, 6)}
              {#if results.length > 0}
                <div class="space-y-1">
                  {#each results as result (result.name)}
                    <a
                      href={`/${result.name}/${result.version}`}
                      class="block rounded-[var(--radius-chip)] corner-squircle px-3 py-2 hover:bg-[var(--panel-strong)] transition-colors"
                    >
                      <div class="flex items-center justify-between gap-2">
                        <p class="text-sm font-medium text-[var(--ink)]">{result.name}</p>
                        <span class="badge badge-sm">{result.version}</span>
                      </div>
                      {#if result.description}
                        <p class="text-xs text-[var(--muted)] mt-1">{result.description}</p>
                      {/if}
                    </a>
                  {/each}
                </div>
              {:else}
                <p class="text-xs text-[var(--muted)]">No matches found.</p>
              {/if}
            </svelte:boundary>
          {/if}
        </div>
      {/if}
    </div>

    <section
      class="relative overflow-hidden rounded-[var(--radius-panel)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel)] p-8 shadow-[var(--shadow-glow)] animate-[float-in_0.8s_ease-out]"
    >
      <div class="absolute inset-0 pointer-events-none">
        <svg
          class="absolute inset-0 h-full w-full text-[var(--grid-line)] opacity-55"
          viewBox="0 0 600 240"
          preserveAspectRatio="xMidYMid slice"
          aria-hidden="true"
        >
          <defs>
            <radialGradient id="node-glow" cx="0.35" cy="0.35" r="0.85">
              <stop offset="0" stop-color="currentColor" stop-opacity="0.25" />
              <stop offset="1" stop-color="currentColor" stop-opacity="0.04" />
            </radialGradient>
          </defs>
          <g fill="none" stroke="currentColor" stroke-linecap="round">
            <g stroke-width="1.2" stroke-opacity="0.45">
              <path d="M90 150 L170 120 L260 140 L330 100 L420 125 L500 90" />
              <path d="M170 120 L120 70 L210 80 L260 140" />
              <path d="M330 100 L300 60 L380 80 L420 125" />
              <path d="M90 150 L150 190 L240 190 L330 180 L420 190" />
            </g>
            <g stroke-width="1" stroke-opacity="0.25">
              <path d="M240 190 L260 140" />
              <path d="M330 180 L330 100" />
              <path d="M420 125 L460 60" />
            </g>
          </g>
          <g fill="url(#node-glow)" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.1">
            <circle cx="90" cy="150" r="6.5" />
            <circle cx="170" cy="120" r="7.5" />
            <circle cx="260" cy="140" r="6.5" />
            <circle cx="330" cy="100" r="8" />
            <circle cx="420" cy="125" r="6.5" />
            <circle cx="500" cy="90" r="6" />
            <circle cx="120" cy="70" r="5.5" />
            <circle cx="210" cy="80" r="5.5" />
            <circle cx="300" cy="60" r="5.5" />
            <circle cx="380" cy="80" r="5.5" />
            <circle cx="460" cy="60" r="5.5" />
            <circle cx="150" cy="190" r="5.5" />
            <circle cx="240" cy="190" r="5.5" />
            <circle cx="330" cy="180" r="5.5" />
            <circle cx="420" cy="190" r="5.5" />
          </g>
        </svg>
      </div>
      <div class="absolute right-0 top-0 h-32 w-32 -translate-y-10 translate-x-10 rounded-full bg-[var(--bg-glow)]/60 blur-3xl"></div>
      <div class="relative z-10">
        <p class="text-xs uppercase tracking-[0.3em] text-[var(--muted)]">Codeview</p>
        <h1 class="mt-4 text-4xl font-semibold text-[var(--ink)]">Code, visualized.</h1>
        <p class="mt-4 max-w-2xl text-base leading-relaxed text-[var(--muted)]">
          Browse crates and relationships with a clean, focused graph view.
        </p>
      </div>
    </section>

    <svelte:boundary>
      {#if workspaceCrates.length > 0}
        <section id="workspace-crates" class="space-y-4">
          <div>
            <h2 class="text-2xl font-semibold text-[var(--ink)]">Workspace</h2>
            <p class="text-sm text-[var(--muted)]">Crates from your local workspace.</p>
          </div>
          <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {#each workspaceCrates as crate (crate.id)}
              <a
                href={`/${crate.id}/${crate.version}`}
                class="rounded-[var(--radius-card)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel-solid)] p-4 shadow-[var(--shadow-soft)] transition hover:-translate-y-0.5"
              >
                <div class="flex items-center justify-between gap-3">
                  <span class="text-sm font-semibold text-[var(--ink)]">{crate.name}</span>
                  <span class="badge">{crate.version}</span>
                </div>
                <p class="mt-2 text-xs text-[var(--muted)]">
                  Open the crate overview and navigate relationships.
                </p>
              </a>
            {/each}
          </div>
        </section>
      {/if}

      <section id="crates" class="space-y-4">
        <div>
          <h2 class="text-2xl font-semibold text-[var(--ink)]">Popular Crates</h2>
          <p class="text-sm text-[var(--muted)]">Pick a crate to open its graph.</p>
        </div>
        {#if topCrates.length > 0}
          <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {#each topCrates as crate (crate.id)}
              <a
                href={`/${crate.id}/${crate.version}`}
                class="rounded-[var(--radius-card)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel-solid)] p-4 shadow-[var(--shadow-soft)] transition hover:-translate-y-0.5"
              >
                <div class="flex items-center justify-between gap-3">
                  <span class="text-sm font-semibold text-[var(--ink)]">{crate.name}</span>
                  <span class="badge">{crate.version}</span>
                </div>
                {#if crate.description}
                  <p class="mt-2 text-xs text-[var(--muted)]">{crate.description}</p>
                {:else}
                  <p class="mt-2 text-xs text-[var(--muted)]">
                    Open the crate overview and navigate relationships.
                  </p>
                {/if}
              </a>
            {/each}
          </div>
        {:else}
          <div
            class="rounded-[var(--radius-card)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel-solid)] p-6"
          >
            <p class="text-sm font-semibold text-[var(--ink)]">No crates available.</p>
            <p class="mt-2 text-sm text-[var(--muted)]">
              Try searching for a crate above.
            </p>
          </div>
        {/if}
      </section>

      {#snippet pending()}
        <div
          class="rounded-[var(--radius-card)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel-solid)] p-6 text-sm text-[var(--muted)]"
        >
          Loading crates...
        </div>
      {/snippet}
    </svelte:boundary>
  </div>
</div>
