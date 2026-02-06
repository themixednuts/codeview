<script lang="ts">
  import Skeleton from './Skeleton.svelte';
  import type { PathStructureMetadata } from '$lib/path-structure';
  import type { CrateTree } from '$lib/schema';
  import { normalizeCrateName } from '$lib/crate-names';

  /**
   * Skeleton tree for progressive loading states.
   * Shows animated placeholders that match the actual tree structure.
   * 
   * With progressive JSON, we show:
   * 1. Real nodes that have already streamed in (from streamedTree)
   * 2. Skeleton placeholders for children we know exist but haven't arrived yet
   * 3. The path from root to currentPath is shown expanded
   */
  let {
    count = 10,
    showKindBadges = true,
    pathStructure = null,
    currentPath = '',
    crateName = '',
    streamedTree = null
  } = $props<{
    /** Total number of items (used for count display, visual items capped) */
    count?: number;
    /** Whether to show skeleton kind filter badges */
    showKindBadges?: boolean;
    /** Path structure metadata for accurate skeleton rendering */
    pathStructure?: PathStructureMetadata | null;
    /** Current URL path (e.g., "de/Deserialize") to show correct tree shape */
    currentPath?: string;
    /** Crate name for building node IDs */
    crateName?: string;
    /** Already-streamed tree nodes to render as real items */
    streamedTree?: CrateTree | null;
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
    /** If true, this is a real node from the streamed tree */
    isReal?: boolean;
    name?: string;
  }

  /**
   * Build the expected path segments from the URL.
   * e.g., crateName="serde", currentPath="de/Deserialize" 
   * => ["serde", "serde::de", "serde::de::Deserialize"]
   */
  const expectedPathSegments = $derived((): string[] => {
    if (!crateName) return [];
    const normalizedCrate = normalizeCrateName(crateName);
    const segments = [normalizedCrate];
    if (currentPath) {
      const parts = currentPath.split('/').filter(Boolean);
      let current = normalizedCrate;
      for (const part of parts) {
        current = `${current}::${part}`;
        segments.push(current);
      }
    }
    return segments;
  });

  type TreeNode = CrateTree['nodes'][number];
  type TreeEdge = CrateTree['edges'][number];

  /**
   * Get IDs of nodes that have streamed in.
   */
  const streamedNodeIds = $derived((): Set<string> => {
    if (!streamedTree?.nodes) return new Set();
    return new Set(streamedTree.nodes.map((n: TreeNode) => n.id));
  });

  /**
   * Build a hierarchical skeleton structure based on:
   * 1. URL path - determines which nodes should be shown expanded
   * 2. Streamed tree - real nodes we've received
   * 3. Path structure metadata - child counts for accurate placeholders
   */
  const skeletonItems = $derived((): SkeletonItem[] => {
    const items: SkeletonItem[] = [];
    const pathSegments = expectedPathSegments();
    const streamedIds = streamedNodeIds();
    
    // If we have streamed nodes, show them as real items
    if (streamedTree?.nodes && streamedTree.nodes.length > 0) {
      // Build parent->children map from edges
      const childMap = new Map<string, string[]>();
      const nodeById = new Map<string, TreeNode>(streamedTree.nodes.map((n: TreeNode) => [n.id, n]));
      
      for (const edge of streamedTree.edges ?? []) {
        if (!childMap.has(edge.from)) childMap.set(edge.from, []);
        childMap.get(edge.from)!.push(edge.to);
      }
      
      // Find root nodes (nodes with no incoming edges)
      const hasParent = new Set((streamedTree.edges ?? []).map((e: TreeEdge) => e.to));
      const roots = streamedTree.nodes.filter((n: TreeNode) => !hasParent.has(n.id));
      
      // Render tree starting from roots, expanding along the expected path
      const rendered = new Set<string>();
      const queue: Array<{ id: string; indent: number }> = roots.map((r: TreeNode) => ({ id: r.id, indent: 0 }));
      
      while (queue.length > 0 && items.length < MAX_VISIBLE) {
        const { id, indent } = queue.shift()!;
        if (rendered.has(id)) continue;
        rendered.add(id);
        
        const node = nodeById.get(id);
        if (!node) continue;
        
        const children = childMap.get(id) ?? [];
        const isOnPath = pathSegments.includes(id);
        const expectedChildCount = pathStructure?.childCounts[id] ?? children.length;
        
        items.push({
          id,
          indent: Math.min(indent, 3),
          width: `${Math.min(50 + node.name.length * 4, 90)}%`,
          isParent: children.length > 0 || expectedChildCount > 0,
          expectedChildren: expectedChildCount > children.length ? expectedChildCount - children.length : undefined,
          isReal: true,
          name: node.name
        });
        
        // Expand children if this node is on the path to the target
        if (isOnPath && children.length > 0) {
          for (const childId of children) {
            queue.unshift({ id: childId, indent: indent + 1 });
          }
        }
        
        // Show skeleton placeholders for expected children not yet streamed
        if (isOnPath && expectedChildCount > children.length) {
          const missing = expectedChildCount - children.length;
          const showCount = Math.min(missing, 3);
          for (let i = 0; i < showCount && items.length < MAX_VISIBLE; i++) {
            items.push({
              id: `${id}::skeleton-${i}`,
              indent: Math.min(indent + 1, 4),
              width: `${45 + ((i * 11) % 35)}%`,
              isParent: false
            });
          }
        }
      }
      
      return items;
    }
    
    // If we have path structure but no streamed nodes yet, show structure based on URL path
    if (pathSegments.length > 0 && crateName) {
      const normalizedCrate = normalizeCrateName(crateName);
      
      // Always show the crate root
      items.push({
        id: normalizedCrate,
        indent: 0,
        width: `${Math.min(50 + normalizedCrate.length * 4, 80)}%`,
        isParent: true,
        expectedChildren: pathStructure?.childCounts[normalizedCrate]
      });
      
      // Show path segments as expanded skeleton items
      for (let i = 1; i < pathSegments.length && items.length < MAX_VISIBLE; i++) {
        const segment = pathSegments[i];
        const name = segment.split('::').pop() ?? segment;
        items.push({
          id: segment,
          indent: Math.min(i, 3),
          width: `${Math.min(50 + name.length * 4, 85)}%`,
          isParent: i < pathSegments.length - 1 || (pathStructure?.childCounts[segment] ?? 0) > 0,
          expectedChildren: pathStructure?.childCounts[segment]
        });
      }
      
      // Add sibling placeholders at the target's level
      const targetParent = pathSegments[pathSegments.length - 2];
      if (targetParent) {
        const siblingCount = pathStructure?.childCounts[targetParent] ?? 3;
        const showSiblings = Math.min(siblingCount - 1, 4); // -1 because target is already shown
        for (let i = 0; i < showSiblings && items.length < MAX_VISIBLE; i++) {
          items.push({
            id: `${targetParent}::sibling-${i}`,
            indent: Math.min(pathSegments.length - 1, 3),
            width: `${45 + ((i * 13) % 35)}%`,
            isParent: false
          });
        }
      }
      
      return items;
    }
    
    // If we have path structure data without URL path, use it for accurate skeletons
    if (pathStructure?.childCounts && Object.keys(pathStructure.childCounts).length > 0) {
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
        if (items.length >= MAX_VISIBLE) break;

        const depth = (parentId.match(/::/g) || []).length;
        const indent = Math.min(depth, 3);

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

        const visibleChildren = Math.min(childCount, 5);
        for (let i = 0; i < visibleChildren && items.length < MAX_VISIBLE; i++) {
          items.push({
            id: `${parentId}::child-${i}`,
            indent: indent + 1,
            width: `${45 + ((i * 11) % 35)}%`,
            isParent: false
          });
        }
      }

      return items;
    }

    // Fallback: show path-based structure even without metadata
    if (crateName) {
      const normalizedCrate = normalizeCrateName(crateName);
      items.push({
        id: normalizedCrate,
        indent: 0,
        width: `${Math.min(50 + normalizedCrate.length * 4, 80)}%`,
        isParent: true
      });
      
      // Add some placeholder children
      for (let i = 0; i < 4; i++) {
        items.push({
          id: `${normalizedCrate}::placeholder-${i}`,
          indent: 1,
          width: `${45 + ((i * 11) % 35)}%`,
          isParent: false
        });
      }
      
      return items;
    }

    // Final fallback: generic skeleton
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
        {#if item.isReal && item.name}
          <!-- Real node from streamed data - show actual icon and name -->
          <div class="flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-chip)] bg-[var(--panel-strong)]">
            <Skeleton width="0.75rem" height="0.75rem" rounded="sm" />
          </div>
          <span class="text-sm text-[var(--ink)] truncate">{item.name}</span>
        {:else}
          <!-- Skeleton placeholder -->
          <Skeleton width="1.25rem" height="1.25rem" rounded="md" />
          <Skeleton width={item.width} height="0.875rem" rounded="sm" />
        {/if}
        <!-- Child count indicator for parents with pending children -->
        {#if item.isParent && item.expectedChildren !== undefined && item.expectedChildren > 0}
          <span class="ml-auto text-xs text-[var(--muted)]">
            +{formatCount(item.expectedChildren)}
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
