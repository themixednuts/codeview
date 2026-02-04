<script lang="ts">
  import Skeleton from './Skeleton.svelte';
  import type { PathStructureMetadata } from '$lib/path-structure';

  /**
   * Skeleton tree for progressive loading states.
   * Shows animated placeholders that match the actual tree structure.
   * When pathStructure is provided, renders accurate child-count skeletons per parent.
   */
  let {
    count = 10,
    showKindBadges = true,
    pathStructure = null
  } = $props<{
    /** Total number of items (used for count display, visual items capped) */
    count?: number;
    /** Whether to show skeleton kind filter badges */
    showKindBadges?: boolean;
    /** Path structure metadata for accurate skeleton rendering */
    pathStructure?: PathStructureMetadata | null;
  }>();

  // Cap visual items to what reasonably fits in a sidebar
  const MAX_VISIBLE = 25;

  /**
   * Represents a skeleton item in the tree with its indentation level
   */
  interface SkeletonItem {
    id: string;
    indent: number;
    width: string;
    isParent: boolean;
    expectedChildren?: number;
  }

  /**
   * Build a hierarchical skeleton structure based on path structure metadata.
   * When we have pathStructure, we show accurate child counts per parent.
   * Otherwise, we fall back to random indentation patterns.
   */
  const skeletonItems = $derived((): SkeletonItem[] => {
    // If we have path structure data, use it for accurate skeletons
    if (pathStructure?.childCounts && Object.keys(pathStructure.childCounts).length > 0) {
      const items: SkeletonItem[] = [];
      const processedParents = new Set<string>();
      const parentChildMap = new Map<string, number>(Object.entries(pathStructure.childCounts));

      // Sort parents by their path depth (root first)
      const sortedParents = Array.from(parentChildMap.entries())
        .sort((a, b) => {
          const depthA = (a[0].match(/::/g) || []).length;
          const depthB = (b[0].match(/::/g) || []).length;
          return depthA - depthB;
        });

      for (const [parentId, childCount] of sortedParents) {
        // Skip if we've already processed too many items
        if (items.length >= MAX_VISIBLE) break;

        // Calculate indentation based on path depth
        const depth = (parentId.match(/::/g) || []).length;
        const indent = Math.min(depth, 3); // Cap at 3 levels deep

        // Add parent placeholder if not already added
        if (!processedParents.has(parentId) && items.length < MAX_VISIBLE) {
          items.push({
            id: parentId,
            indent,
            width: `${50 + ((parentId.length * 7) % 30)}%`,
            isParent: true,
            expectedChildren: childCount
          });
          processedParents.add(parentId);
        }

        // Add child placeholders - show up to 5 per parent in skeleton
        const visibleChildren = Math.min(childCount, 5);
        for (let i = 0; i < visibleChildren && items.length < MAX_VISIBLE; i++) {
          items.push({
            id: `${parentId}::child-${i}`,
            indent: indent + 1,
            width: `${45 + ((i * 11) % 35)}%`,
            isParent: false
          });
        }

        // If there are more children than we're showing, add a count indicator
        if (childCount > visibleChildren && items.length < MAX_VISIBLE) {
          items.push({
            id: `${parentId}::more`,
            indent: indent + 1,
            width: '60%',
            isParent: false
          });
        }
      }

      return items;
    }

    // Fallback: generate random indentation patterns
    const items: SkeletonItem[] = [];
    const visibleCount = Math.min(count, MAX_VISIBLE);

    for (let i = 0; i < visibleCount; i++) {
      const indent = i === 0 ? 0 : ((i * 13 + 5) % 10) < 3 ? 0 : ((i * 13 + 5) % 10) < 7 ? 1 : 2;
      const widthSeed = (i * 7 + 3) % 10;
      items.push({
        id: `fallback-${i}`,
        indent,
        width: `${50 + widthSeed * 4}%`,
        isParent: false
      });
    }

    return items;
  });

  const hasMore = $derived(count > MAX_VISIBLE);
  const totalExpectedChildren = $derived((): number => {
    if (!pathStructure?.childCounts) return 0;
    const counts = Object.values(pathStructure.childCounts) as number[];
    return counts.reduce((sum, count) => sum + count, 0);
  });

  // Format large numbers with commas
  function formatCount(n: number): string {
    return n.toLocaleString();
  }
</script>

{#if showKindBadges}
  <!-- Skeleton kind badges -->
  <div class="flex flex-wrap items-center gap-1 border-b border-[var(--panel-border)] p-2">
    {#each { length: 4 } as _}
      <Skeleton width="4rem" height="1.5rem" rounded="full" />
    {/each}
  </div>
{/if}

<!-- Skeleton tree items -->
<div class="flex-1 overflow-auto p-2">
  <div class="flex flex-col gap-0.5">
    {#each skeletonItems() as item (item.id)}
      <div
        class="flex items-center gap-2 rounded-[var(--radius-chip)] px-2 py-1.5"
        style:padding-left="{0.5 + item.indent * 1}rem"
      >
        <!-- Icon placeholder -->
        <Skeleton width="1.25rem" height="1.25rem" rounded="md" />
        <!-- Text placeholder -->
        <Skeleton width={item.width} height="0.875rem" rounded="sm" />
        <!-- Child count indicator for parents -->
        {#if item.isParent && item.expectedChildren !== undefined && item.expectedChildren > 0}
          <span class="ml-auto text-xs text-[var(--muted)]">
            {formatCount(item.expectedChildren)}
          </span>
        {/if}
      </div>
    {/each}
    {#if hasMore}
      <!-- Count indicator for large trees -->
      <div class="px-2 py-3 text-center text-xs text-[var(--muted)]">
        Loading {formatCount(count)} items
        {#if totalExpectedChildren() > 0}
          ({formatCount(totalExpectedChildren())} children across {formatCount(Object.keys(pathStructure?.childCounts || {}).length)} parents)
        {/if}
      </div>
    {/if}
  </div>
</div>
