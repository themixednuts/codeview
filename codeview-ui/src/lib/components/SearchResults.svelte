<script lang="ts">
  import type { NodeSummary } from "$lib/schema";
  import type { NodeKind } from "$lib/graph";
  import { kindColors, kindIcons } from "$lib/tree";
  import Skeleton from "$lib/components/Skeleton.svelte";

  let { searchQuery, filter, selectedNodeId, getNodeUrl }: {
    searchQuery: Promise<NodeSummary[]>;
    filter: string;
    selectedNodeId: string;
    getNodeUrl: (id: string) => string;
  } = $props();
</script>

<svelte:boundary>
  {@const results = await searchQuery}
  {#if results && results.length > 0}
    <div class="p-2">
      <div class="px-2 pb-1 text-xs text-[var(--muted)]">
        {results.length} result{results.length === 1 ? "" : "s"}
      </div>
      {#each results as node (node.id)}
        {@const isSelected = selectedNodeId === node.id}
        {@const KindIcon = kindIcons[node.kind] ?? kindIcons.Crate}
        <a
          href={getNodeUrl(node.id)}
          data-sveltekit-noscroll
          class="flex items-center gap-2 rounded-[var(--radius-chip)] corner-squircle px-2 py-1.5 text-sm hover:bg-[var(--panel-strong)] {isSelected
            ? 'bg-[var(--accent)]/10 ring-1 ring-inset ring-[var(--accent)]'
            : ''}"
        >
          <span
            class="flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-chip)] corner-squircle text-white"
            style="background-color: {kindColors[node.kind] ??
              kindColors.Crate}"
            ><KindIcon size={12} strokeWidth={2.5} /></span
          >
          <span class="min-w-0 flex-1">
            <span class="block truncate font-medium text-[var(--ink)]"
              >{node.name}</span
            >
            <span class="block truncate text-xs text-[var(--muted)]"
              >{node.id}</span
            >
          </span>
        </a>
      {/each}
    </div>
  {:else}
    <div class="p-4 text-sm text-[var(--muted)]">
      No results for "{filter}"
    </div>
  {/if}
  {#snippet pending()}
    <!-- Skeleton search results -->
    <div class="p-2">
      <Skeleton
        width="5rem"
        height="0.75rem"
        rounded="sm"
        class="mb-2 ml-2"
      />
      {#each [1, 2, 3, 4, 5] as _}
        <div class="flex items-center gap-2 px-2 py-1.5">
          <Skeleton width="1.25rem" height="1.25rem" rounded="md" />
          <div class="flex-1">
            <Skeleton
              width="60%"
              height="0.875rem"
              rounded="sm"
              class="mb-1"
            />
            <Skeleton width="80%" height="0.625rem" rounded="sm" />
          </div>
        </div>
      {/each}
    </div>
  {/snippet}
</svelte:boundary>
