<script lang="ts">
  import { Memo } from '$lib/reactivity.svelte';

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

  let buttonRefs: Record<LayoutMode, HTMLButtonElement | null> = $state({
    ego: null,
    force: null,
    hierarchical: null,
    radial: null
  });

  const indicatorStyleMemo = new Memo(() => {
    const btn = buttonRefs[mode];
    if (!btn) return { left: 0, width: 0 };
    return {
      left: btn.offsetLeft,
      width: btn.offsetWidth
    };
  });
  let indicatorStyle = $derived(indicatorStyleMemo.current);

  function handleModeChange(newMode: LayoutMode) {
    if (newMode === mode) return;

    if (document.startViewTransition) {
      document.startViewTransition(() => {
        onModeChange(newMode);
      });
    } else {
      onModeChange(newMode);
    }
  }
</script>

<div class="relative flex items-center gap-1 rounded-[var(--radius-control)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel-solid)] p-1">
  <!-- Sliding indicator -->
  <div
    class="absolute top-1 bottom-1 rounded-[var(--radius-chip)] corner-squircle bg-[var(--accent)] transition-all duration-150 ease-out"
    style="left: {indicatorStyle.left}px; width: {indicatorStyle.width}px; view-transition-name: layout-indicator"
  ></div>

  {#each layouts as layout (layout.id)}
    <button
      bind:this={buttonRefs[layout.id]}
      type="button"
      class="relative z-10 badge badge-lg bg-transparent border-transparent text-xs transition-colors {mode === layout.id
        ? 'text-white'
        : 'text-[var(--muted)] hover:text-[var(--ink)]'}"
      onclick={() => handleModeChange(layout.id)}
      title={layout.description}
    >
      {layout.label}
    </button>
  {/each}
</div>
