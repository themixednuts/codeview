<script lang="ts">
  import type { Node, NodeKind } from '$lib/graph';
  import type { GraphStats } from '$lib/ui';

  let { stats, selected, kindLabels } = $props<{
    stats: GraphStats;
    selected: Node | null;
    kindLabels: Record<NodeKind, string>;
  }>();
</script>

<div class="grid gap-4">
  <div
    class="rounded-[var(--radius-card)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel-solid)] p-6 shadow-[var(--shadow-strong)]"
  >
    <p class="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">Nodes</p>
    <div class="mt-3 text-3xl font-semibold text-[var(--ink)]">{stats.nodeCount}</div>
    <p class="mt-1 text-sm text-[var(--muted)]">Mapped symbols ready to explore.</p>
  </div>
  <div
    class="rounded-[var(--radius-card)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel-solid)] p-6 shadow-[var(--shadow-strong)]"
  >
    <p class="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">Edges</p>
    <div class="mt-3 text-3xl font-semibold text-[var(--ink)]">{stats.edgeCount}</div>
    <p class="mt-1 text-sm text-[var(--muted)]">Type usage, calls, and containment.</p>
  </div>
  <div
    class="rounded-[var(--radius-card)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel-strong)] p-6 shadow-[var(--shadow-strong)]"
  >
    <p class="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">Focus</p>
    <div class="mt-3 text-lg font-semibold text-[var(--ink)]">
      {selected ? selected.name : 'Select a node'}
    </div>
    <p class="mt-1 text-sm text-[var(--muted)]">
      {selected ? kindLabels[selected.kind] : 'Click a node to inspect details.'}
    </p>
  </div>
</div>
