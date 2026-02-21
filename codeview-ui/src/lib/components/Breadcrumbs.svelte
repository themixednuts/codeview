<script lang="ts">
	import type { Node, NodeKind } from '$lib/graph';
	import type { NodeSummary } from '$lib/schema';
	import { kindColors } from '$lib/tree';
	import { resolve } from '$app/paths';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';

	let { ancestors, selected, getNodeUrl } = $props<{
		/** Pre-computed ancestor chain: root → ... → parent (excludes selected). */
		ancestors: NodeSummary[];
		selected: Node;
		getNodeUrl: (id: string) => string;
	}>();

	// Full path = ancestors + selected node at the end
	// Guard: selected can be null during Svelte async teardown race (_Batch.revive)
	const path = $derived(selected ? [...ancestors, selected] : []);

	// Truncate path if too long, keeping first and last items visible
	const displayPath = $derived.by(() => {
		if (path.length <= 4) return { items: path, truncated: false as const };
		// Show: first, ..., second-to-last, last
		return {
			items: [path[0], path[path.length - 2], path[path.length - 1]],
			truncated: true as const,
			hiddenCount: path.length - 3,
		};
	});
</script>

{#if path.length > 0}
	<nav class="flex items-center gap-1 overflow-x-auto pb-1 text-sm" aria-label="Breadcrumb">
		{#each displayPath.items as node, index (node.id)}
			{#if index > 0}
				{#if displayPath.truncated && index === 1}
					<span class="px-1 text-(--muted)">...</span>
					<ChevronRight size={16} class="shrink-0 text-(--muted)" />
				{:else}
					<ChevronRight size={16} class="shrink-0 text-(--muted)" />
				{/if}
			{/if}

			{#if node.id === selected?.id}
				<!-- Current node (not clickable) -->
				<span class="badge badge-strong badge-lg gap-1.5">
					<span
						class="size-2 shrink-0 rounded-full"
						style="background-color: {kindColors[node.kind as NodeKind]}"
					>
					</span>
					<span class="max-w-37.5 truncate font-medium text-(--ink)">{node.name}</span>
				</span>
			{:else}
				<!-- Ancestor node (clickable) -->
				<a
					href={resolve(getNodeUrl(node.id))}
					data-sveltekit-noscroll
					class="badge badge-lg gap-1.5 text-(--muted) transition-colors hover:bg-(--panel-strong) hover:text-(--ink)"
				>
					<span
						class="size-2 shrink-0 rounded-full"
						style="background-color: {kindColors[node.kind as NodeKind]}"
					>
					</span>
					<span class="max-w-37.5 truncate">{node.name}</span>
				</a>
			{/if}
		{/each}
	</nav>
{:else if selected}
	<!-- Fallback when path is empty but selected exists -->
	<nav class="flex items-center gap-1 overflow-x-auto pb-1 text-sm" aria-label="Breadcrumb">
		<span class="badge badge-strong badge-lg gap-1.5">
			<span
				class="size-2 shrink-0 rounded-full"
				style="background-color: {kindColors[selected.kind as NodeKind]}"
			></span>
			<span class="max-w-37.5 truncate font-medium text-(--ink)">{selected.name}</span>
		</span>
	</nav>
{/if}
