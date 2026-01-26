<script lang="ts">
  let { loadError, onFileChange, onReset } = $props<{
    loadError: string | null;
    onFileChange: (event: Event) => void;
    onReset: () => void;
  }>();
</script>

<div
  class="relative overflow-hidden rounded-3xl border border-[var(--panel-border)] bg-[var(--panel)]/90 p-8 shadow-[0_24px_50px_rgba(38,28,20,0.12)] animate-[float-in_0.8s_ease-out]"
>
  <div class="absolute right-0 top-0 h-32 w-32 -translate-y-10 translate-x-10 rounded-full bg-[var(--bg-glow)]/60 blur-3xl"></div>
  <p class="text-xs uppercase tracking-[0.3em] text-[var(--muted)]">Codeview</p>
  <h1 class="mt-4 text-4xl font-semibold text-[var(--ink)]">
    Inspect Rust crates as a living, navigable graph.
  </h1>
  <p class="mt-4 max-w-xl text-base leading-relaxed text-[var(--muted)]">
    Drop a Codeview graph JSON file and explore structure, calls, and type relationships with a
    force-directed view that keeps the architecture readable.
  </p>
  <div class="mt-6 flex flex-wrap items-center gap-3">
    <label
      class="inline-flex cursor-pointer items-center gap-2 rounded-full bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-white shadow-[0_12px_24px_rgba(215,106,47,0.35)] transition hover:translate-y-[-1px]"
    >
      Load graph JSON
      <input type="file" accept="application/json" class="hidden" onchange={onFileChange} />
    </label>
    <button
      type="button"
      class="inline-flex items-center gap-2 rounded-full border border-[var(--panel-border)] bg-white/70 px-5 py-2 text-sm font-semibold text-[var(--ink)] shadow-[0_12px_20px_rgba(38,28,20,0.08)] transition hover:-translate-y-0.5"
      onclick={onReset}
    >
      Reset sample
    </button>
  </div>
  <div class="mt-5 rounded-2xl border border-white/60 bg-white/70 px-4 py-3 text-xs text-[var(--muted)]">
    <span class="font-semibold text-[var(--ink)]">CLI hint:</span>
    <code class="ml-2">codeview analyze --manifest-path Cargo.toml --out graph.json</code>
  </div>
  {#if loadError}
    <p class="mt-4 text-sm text-red-600">{loadError}</p>
  {/if}
</div>
