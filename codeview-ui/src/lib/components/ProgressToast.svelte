<script lang="ts">
  import { Loader2Icon } from "@lucide/svelte";

  let { stepLabel, nodeCount, edgeCount }: {
    stepLabel: string;
    nodeCount: number;
    edgeCount: number;
  } = $props();
</script>

<div
  class="pointer-events-none fixed bottom-4 right-4 z-50 animate-in fade-in slide-in-from-bottom-2 duration-300"
>
  <div
    class="pointer-events-auto flex items-center gap-3 rounded-[var(--radius-card)] border border-[var(--panel-border)] bg-[var(--panel-solid)] px-3 py-2 shadow-lg"
  >
    <Loader2Icon class="h-4 w-4 animate-spin text-[var(--accent)]" />
    <div>
      <div class="text-sm font-medium text-[var(--ink)]">
        {stepLabel}
      </div>
      <div class="text-xs text-[var(--muted)] font-mono">
        {nodeCount.toLocaleString()} nodes · {edgeCount.toLocaleString()} edges
      </div>
    </div>
  </div>
</div>
