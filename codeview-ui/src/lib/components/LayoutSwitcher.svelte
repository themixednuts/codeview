<script lang="ts">
  export type LayoutMode = 'ego' | 'force' | 'hierarchical' | 'radial';

  interface Props {
    mode: LayoutMode;
    onModeChange: (mode: LayoutMode) => void;
  }

  let { mode, onModeChange }: Props = $props();

  const layouts: { id: LayoutMode; label: string; description: string }[] = [
    { id: 'ego', label: 'Ego', description: 'Focused view centered on selected node' },
    { id: 'force', label: 'Force', description: 'Physics-based organic layout' },
    { id: 'hierarchical', label: 'Hierarchy', description: 'Layered top-down tree' },
    { id: 'radial', label: 'Radial', description: 'Concentric circles from center' },
  ];
</script>

<div class="flex items-center gap-1 rounded-lg border border-[var(--panel-border)] bg-white p-1">
  {#each layouts as layout (layout.id)}
    <button
      type="button"
      class="rounded-md px-3 py-1 text-xs font-medium transition-colors {mode === layout.id
        ? 'bg-[var(--accent)] text-white'
        : 'text-[var(--muted)] hover:bg-[var(--panel)]'}"
      onclick={() => onModeChange(layout.id)}
      title={layout.description}
    >
      {layout.label}
    </button>
  {/each}
</div>
