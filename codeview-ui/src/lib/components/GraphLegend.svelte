<script lang="ts">
  import type { Confidence, EdgeKind, NodeKind } from '$lib/graph';
  import type { GraphStats } from '$lib/ui';

  let { stats, nodeColor, edgeColor, kindLabels, edgeLabels, confidenceLabels } = $props<{
    stats: GraphStats;
    nodeColor: (kind: NodeKind) => string;
    edgeColor: (kind: EdgeKind) => string;
    kindLabels: Record<NodeKind, string>;
    edgeLabels: Record<EdgeKind, string>;
    confidenceLabels: Record<Confidence, string>;
  }>();
</script>

<div class="rounded-[var(--radius-panel)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel)] p-6 shadow-[var(--shadow-strong)]">
  <h3 class="text-xl font-semibold text-[var(--ink)]">Legend</h3>
  <div class="mt-4">
    <p class="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">Node kinds</p>
    <div class="mt-3 flex flex-wrap gap-2">
      {#if stats.kindCounts.length === 0}
        <p class="text-sm text-[var(--muted)]">No node kinds loaded.</p>
      {:else}
        {#each stats.kindCounts as entry (entry.kind)}
          <span
            class="badge badge-solid badge-lg gap-2"
          >
            <span class="h-2.5 w-2.5 rounded-full" style={`background:${nodeColor(entry.kind)}`}></span>
            {kindLabels[entry.kind]}
            <span class="text-[var(--muted)]">{entry.count}</span>
          </span>
        {/each}
      {/if}
    </div>
  </div>
  <div class="mt-6">
    <p class="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">Edge kinds</p>
    <div class="mt-3 flex flex-col gap-2 text-sm">
      {#if stats.edgeCounts.length === 0}
        <p class="text-sm text-[var(--muted)]">No edges loaded.</p>
      {:else}
        {#each stats.edgeCounts as entry (entry.kind)}
          <div class="flex items-center justify-between rounded-[var(--radius-card)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel)] px-3 py-2">
            <span class="font-semibold text-[var(--ink)]">{edgeLabels[entry.kind]}</span>
            <div class="flex items-center gap-2">
              <span class="h-2.5 w-2.5 rounded-full" style={`background:${edgeColor(entry.kind)}`}></span>
              <span class="text-xs text-[var(--muted)]">{entry.count}</span>
            </div>
          </div>
        {/each}
      {/if}
    </div>
  </div>
  <div class="mt-6 rounded-[var(--radius-card)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel)] px-4 py-3 text-xs text-[var(--muted)]">
    <p class="font-semibold text-[var(--ink)]">Confidence markers</p>
    <div class="mt-2 flex flex-wrap gap-3">
      {#each Object.entries(confidenceLabels) as [key, value] (key)}
        <span class="badge badge-solid badge-lg">{value}</span>
      {/each}
    </div>
  </div>
</div>
