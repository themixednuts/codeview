<script lang="ts">
  import { getCrates, getHostedMode, getTopCrates, searchRegistry } from '$lib/graph.remote';

  const hostedQuery = getHostedMode();
  const isHosted = $derived(hostedQuery.current ?? false);

  const localCratesQuery = getCrates();
  const topCratesQuery = $derived(isHosted ? getTopCrates() : null);

  const displayedCrates = $derived.by(() => {
    if (isHosted) {
      const results = topCratesQuery?.current ?? [];
      return results.map((crate) => ({
        id: crate.name,
        name: crate.name,
        version: crate.version,
        description: crate.description
      }));
    }
    const results = localCratesQuery.current ?? [];
    return results.map((crate) => ({
      id: crate.id,
      name: crate.name,
      version: crate.version
    }));
  });
  const cratesLoading = $derived(isHosted ? (topCratesQuery?.loading ?? false) : localCratesQuery.loading);
  const hasCrates = $derived(displayedCrates.length > 0);

  let searchInput = $state('');
  const searchTerm = $derived(searchInput.trim());

  const searchQuery = $derived(
    isHosted && searchTerm.length >= 2 ? searchRegistry(searchTerm) : null
  );
  const searchResults = $derived(searchQuery?.current ?? []);
  const searchLoading = $derived(searchQuery?.loading ?? false);
  const limitedSearchResults = $derived(searchResults.slice(0, 6));
  const showSearchResults = $derived(isHosted && searchTerm.length >= 2);
</script>

<div class="flex flex-1 overflow-auto">
  <div class="mx-auto flex w-full max-w-6xl flex-col gap-10 px-6 py-10">
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
        {#if isHosted}
          <div class="mt-6 max-w-lg">
            <label
              for="global-search"
              class="text-xs uppercase tracking-[0.2em] text-[var(--muted)]"
            >
              Search
            </label>
            <input
              id="global-search"
              type="search"
              placeholder="Search crates, types, functions..."
              bind:value={searchInput}
              class="mt-2 w-full rounded-[var(--radius-control)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel-solid)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
            />
            {#if showSearchResults}
              <div
                class="mt-3 rounded-[var(--radius-card)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel-solid)] p-3"
              >
                {#if searchLoading}
                  <p class="text-xs text-[var(--muted)]">Searching...</p>
                {:else if limitedSearchResults.length > 0}
                  <p class="text-xs text-[var(--muted)]">Preview results</p>
                  <div class="mt-2 space-y-2">
                    {#each limitedSearchResults as result (result.name)}
                      <a
                        href={`/${result.name}/${result.version}`}
                        class="block rounded-[var(--radius-chip)] corner-squircle bg-[var(--panel)] px-3 py-2 hover:bg-[var(--panel-strong)] transition-colors"
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
                  <p class="text-xs text-[var(--muted)]">No matches yet.</p>
                {/if}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </section>

    <section id="crates" class="space-y-4">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 class="text-2xl font-semibold text-[var(--ink)]">Crates</h2>
          <p class="text-sm text-[var(--muted)]">Pick a crate to open its graph.</p>
        </div>
        {#if hasCrates && isHosted}
          <span class="badge badge-strong">Top 10</span>
        {/if}
      </div>
      {#if cratesLoading}
        <div
          class="rounded-[var(--radius-card)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel-solid)] p-6 text-sm text-[var(--muted)]"
        >
          Loading crates...
        </div>
      {:else if hasCrates}
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {#each displayedCrates as crate (crate.id)}
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
      {:else}
        <div
          class="rounded-[var(--radius-card)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel-solid)] p-6"
        >
          <p class="text-sm font-semibold text-[var(--ink)]">No graph data yet.</p>
          <p class="mt-2 text-sm text-[var(--muted)]">
            Add a graph JSON to see crates listed here.
          </p>
        </div>
      {/if}
    </section>
  </div>
</div>
