<script lang="ts">
  import { Memo } from '$lib/reactivity.svelte';
  import { tooltip } from '$lib/tooltip';

  export type LayoutMode = 'ego' | 'force' | 'hierarchical' | 'radial';

  interface Props {
    mode: LayoutMode;
    onModeChange: (mode: LayoutMode) => void;
  }

  let { mode, onModeChange }: Props = $props();

  const layouts: { id: LayoutMode; label: string; description: string }[] = [
    { id: 'ego', label: 'Ego', description: 'Centers the selected node with direct connections radiating outward in two columns' },
    { id: 'force', label: 'Force', description: 'Physics simulation arranging nodes by connectivity \u2014 drag to reposition' },
    { id: 'hierarchical', label: 'Hierarchy', description: 'Top-down tree showing parent-child relationships in ranked layers' },
    { id: 'radial', label: 'Radial', description: 'Concentric rings with the selected node at center, ordered by distance' },
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
      type="button"
      class="relative z-10 badge badge-lg bg-transparent border-transparent text-xs transition-colors {mode === layout.id
        ? 'text-white'
        : 'text-[var(--muted)] hover:text-[var(--ink)]'}"
      onclick={() => handleModeChange(layout.id)}
      {@attach tooltip(layout.description)}
      {@attach (el) => { buttonRefs[layout.id] = el as HTMLButtonElement; return () => { buttonRefs[layout.id] = null; }; }}
    >
      {layout.label}
    </button>
  {/each}
</div>
