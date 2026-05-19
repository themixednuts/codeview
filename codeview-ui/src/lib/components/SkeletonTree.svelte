<script lang="ts">
	import Skeleton from './Skeleton.svelte';

	/**
	 * Skeleton tree for loading states.
	 * Shows animated placeholders with varying indentation.
	 */
	let { count = 10, showKindBadges = true } = $props<{
		/** Total number of items (used for count display, visual items capped) */
		count?: number;
		/** Whether to show skeleton kind filter badges */
		showKindBadges?: boolean;
	}>();

	// Cap visual items to what reasonably fits in a sidebar
	const MAX_VISIBLE = 25;

	interface SkeletonItem {
		id: string;
		indent: number;
		width: string;
	}

	const skeletonItems = $derived.by((): SkeletonItem[] => {
		const items: SkeletonItem[] = [];
		const visibleCount = Math.min(count, MAX_VISIBLE);
		for (let i = 0; i < visibleCount; i++) {
			const indent = i === 0 ? 0 : (i * 13 + 5) % 10 < 3 ? 0 : (i * 13 + 5) % 10 < 7 ? 1 : 2;
			const widthSeed = (i * 7 + 3) % 10;
			items.push({
				id: `skeleton-${i}`,
				indent,
				width: `${50 + widthSeed * 4}%`,
			});
		}
		return items;
	});

	const hasMore = $derived(count > MAX_VISIBLE);

	function formatCount(n: number): string {
		return n.toLocaleString();
	}
</script>

{#if showKindBadges}
	<!-- Skeleton kind badges -->
	<div class="flex flex-wrap items-center gap-1 border-b border-(--panel-border) p-2">
		{#each { length: 4 } as _, i (i)}
			<Skeleton width="4rem" height="1.5rem" rounded="full" />
		{/each}
	</div>
{/if}

<!-- Skeleton tree items -->
<div class="flex-1 overflow-auto p-2">
	<div class="flex flex-col gap-0.5">
		{#each skeletonItems as item (item.id)}
			<div
				class="flex items-center gap-2 rounded-(--radius-chip) px-2 py-1.5"
				style:padding-left="{0.5 + item.indent * 1}rem"
			>
				<Skeleton width="1.25rem" height="1.25rem" rounded="md" />
				<Skeleton width={item.width} height="0.875rem" rounded="sm" />
			</div>
		{/each}
		{#if hasMore}
			<div class="px-2 py-3 text-center text-xs text-(--muted)">
				Loading {formatCount(count)} items
			</div>
		{/if}
	</div>
</div>
