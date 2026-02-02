<script lang="ts">
  import type { Node, NodeKind } from '$lib/graph';
  import { kindColors, kindIcons } from '$lib/tree-constants';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';

  let {
    node,
    depth,
    hasChildren,
    isExpanded,
    isSelected,
    dimmed,
    selectable,
    href,
    onToggle,
    onSelect,
    itemHeight
  } = $props<{
    node: Node;
    depth: number;
    hasChildren: boolean;
    isExpanded: boolean;
    isSelected: boolean;
    dimmed: boolean;
    selectable: boolean;
    href: string;
    /** Toggle expand/collapse (chevron click) */
    onToggle: () => void;
    /** Navigate + maybe expand (row click) */
    onSelect: () => void;
    /** Fixed row height in px (used by virtual tree) */
    itemHeight?: number;
  }>();

  const kind = $derived(node.kind as NodeKind);
  const KindIcon = $derived(kindIcons[kind]);
  const heightStyle = $derived(itemHeight ? `height: ${itemHeight}px; ` : '');
  const paddingStyle = $derived(`padding-left: ${depth * 16 + 8}px`);
  const style = $derived(`${heightStyle}${paddingStyle}`);

  function handleChevronClick(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    onToggle();
  }

  function handleChevronKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      onToggle();
    }
  }

  function handleRowClick() {
    onSelect();
  }

  function handleRowKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect();
    }
  }
</script>

{#if selectable}
  <a
    {href}
    data-sveltekit-noscroll
    class="flex w-full items-center gap-2 rounded-[var(--radius-chip)] corner-squircle box-border px-2 py-1 text-sm leading-none hover:bg-[var(--panel-strong)] {isSelected
      ? 'bg-[var(--accent)]/10 ring-1 ring-inset ring-[var(--accent)]'
      : ''} {dimmed ? 'opacity-50' : ''}"
    {style}
    onclick={handleRowClick}
  >
    {#if hasChildren}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <span
        class="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--muted)] cursor-pointer hover:text-[var(--ink)]"
        onclick={handleChevronClick}
        onkeydown={handleChevronKeydown}
        role="button"
        tabindex="-1"
      >
        {#if isExpanded}
          <ChevronDown size={14} strokeWidth={2.5} />
        {:else}
          <ChevronRight size={14} strokeWidth={2.5} />
        {/if}
      </span>
    {:else}
      <span class="flex h-4 w-4 shrink-0"></span>
    {/if}
    <span
      class="flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-chip)] corner-squircle text-white"
      style="background-color: {kindColors[kind]}"
    >
      <KindIcon size={12} strokeWidth={2.5} />
    </span>
    <span class="min-w-0 flex-1 truncate font-medium text-[var(--ink)]">
      {node.name}
    </span>
    {#if node.visibility === 'Public'}
      <span class="ml-auto text-[10px] leading-none text-[var(--accent)] font-medium">pub</span>
    {/if}
  </a>
{:else}
  <div
    class="flex w-full items-center gap-2 rounded-[var(--radius-chip)] corner-squircle box-border px-2 py-1 text-sm leading-none hover:bg-[var(--panel-strong)] {dimmed ? 'opacity-50' : ''} {hasChildren ? 'cursor-pointer' : ''}"
    {style}
    onclick={handleRowClick}
    onkeydown={handleRowKeydown}
    role="button"
    tabindex="0"
  >
    {#if hasChildren}
      <span
        class="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--muted)] cursor-pointer hover:text-[var(--ink)]"
        onclick={handleChevronClick}
        onkeydown={handleChevronKeydown}
        role="button"
        tabindex="-1"
      >
        {#if isExpanded}
          <ChevronDown size={14} strokeWidth={2.5} />
        {:else}
          <ChevronRight size={14} strokeWidth={2.5} />
        {/if}
      </span>
    {:else}
      <span class="flex h-4 w-4 shrink-0"></span>
    {/if}
    <span
      class="flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-chip)] corner-squircle text-white"
      style="background-color: {kindColors[kind]}"
    >
      <KindIcon size={12} strokeWidth={2.5} />
    </span>
    <span class="min-w-0 flex-1 truncate font-medium text-[var(--ink)]">
      {node.name}
    </span>
    {#if node.visibility === 'Public'}
      <span class="ml-auto text-[10px] leading-none text-[var(--accent)] font-medium">pub</span>
    {/if}
  </div>
{/if}
