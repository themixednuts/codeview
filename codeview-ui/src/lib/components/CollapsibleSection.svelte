<script lang="ts">
  import { slide } from 'svelte/transition';
  import { untrack } from 'svelte';

  let {
    title,
    count = null,
    defaultOpen = true,
    children
  } = $props<{
    title: string;
    count?: number | null;
    defaultOpen?: boolean;
    children: import('svelte').Snippet;
  }>();

  // Initialize state from prop using untrack to capture initial value only
  let isOpen = $state(untrack(() => defaultOpen));

  export function setOpen(open: boolean) {
    isOpen = open;
  }

  export function toggle() {
    isOpen = !isOpen;
  }
</script>

<section class="mb-6 rounded-xl border border-[var(--panel-border)] bg-white overflow-hidden">
  <button
    type="button"
    class="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-[var(--panel)] transition-colors"
    onclick={() => isOpen = !isOpen}
  >
    <div class="flex items-center gap-2">
      <svg
        class="w-4 h-4 text-[var(--muted)] transition-transform duration-200"
        class:rotate-90={isOpen}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
      </svg>
      <h3 class="text-sm font-semibold uppercase tracking-wider text-[var(--muted)]">{title}</h3>
      {#if count !== null}
        <span class="rounded-full bg-[var(--panel)] px-2 py-0.5 text-xs font-medium text-[var(--muted)]">
          {count}
        </span>
      {/if}
    </div>
  </button>

  {#if isOpen}
    <div class="px-4 pb-4" transition:slide={{ duration: 150 }}>
      {@render children()}
    </div>
  {/if}
</section>
