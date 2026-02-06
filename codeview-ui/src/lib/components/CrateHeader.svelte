<script lang="ts">
  import { Loader2Icon } from "@lucide/svelte";

  let {
    crateName,
    version,
    relatedCrateCount,
    crateVersionOptions,
    otherCrates,
    loadingRelatedCrates,
    onVersionChange,
    debugInfo,
  }: {
    crateName: string | undefined;
    version: string | undefined;
    relatedCrateCount: number | null;
    crateVersionOptions: string[];
    otherCrates: Array<{ id: string; name?: string; version: string }>;
    loadingRelatedCrates: boolean;
    onVersionChange: (e: Event) => void;
    debugInfo?: {
      statusDebugKey: string;
      progressDebugKey: string;
      contentId?: string | null;
      sequence?: number | null;
      stale: boolean;
      treeSource: string;
    } | null;
  } = $props();
</script>

<div class="border-b border-[var(--panel-border)] px-3 py-2">
  <div class="flex items-center justify-between gap-2">
    <div class="text-sm font-semibold text-[var(--ink)]">{crateName}</div>
    {#if relatedCrateCount !== null}
      <div class="text-[10px] text-[var(--muted)] font-mono">
        {relatedCrateCount} crates
      </div>
    {/if}
  </div>
  <div class="text-xs text-[var(--muted)]">{version}</div>

  {#if debugInfo}
    <div
      class="mt-2 rounded border border-[var(--panel-border)] bg-[var(--panel-solid)] px-2 py-1.5 text-[10px] font-mono text-[var(--muted)]"
    >
      <div>statusKey: {debugInfo.statusDebugKey}</div>
      <div>progressKey: {debugInfo.progressDebugKey}</div>
      <div>contentId: {debugInfo.contentId ?? "-"}</div>
      <div>sequence: {debugInfo.sequence ?? "-"}</div>
      <div>stale: {debugInfo.stale ? "yes" : "no"}</div>
      <div>treeSource: {debugInfo.treeSource}</div>
    </div>
  {/if}
  {#if crateVersionOptions.length > 1}
    <div class="mt-2">
      <select
        class="w-full rounded-[var(--radius-control)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel-solid)] px-2 py-1 text-xs outline-none focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
        value={version}
        onchange={onVersionChange}
      >
        {#each crateVersionOptions as ver (ver)}
          <option value={ver}>{ver}</option>
        {/each}
      </select>
    </div>
  {/if}
  <div class="mt-2 min-h-8">
    {#if otherCrates.length > 0}
      <div class="flex flex-wrap gap-1">
        {#each otherCrates as c (c.id)}
          {@const routeName = c.name ?? c.id}
          <a
            href="/{routeName}/{c.version}"
            class="badge badge-sm hover:bg-[var(--panel-strong)] hover:text-[var(--ink)] transition-colors"
          >
            {c.name}
          </a>
        {/each}
      </div>
    {:else if loadingRelatedCrates}
      <div
        class="flex items-center gap-2 px-1 py-1 text-xs text-[var(--muted)]"
      >
        <Loader2Icon class="h-3 w-3 animate-spin" />
        <span>Loading crate list...</span>
      </div>
    {/if}
  </div>
</div>
