<script lang="ts">
	import type { Node } from '$lib/graph';
	import type { NodeSummary } from '$lib/schema';
	import { resolve } from '$app/paths';

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
	<nav
		class="flex flex-wrap items-baseline gap-x-1 gap-y-0.5 font-mono text-sm"
		aria-label="Breadcrumb"
	>
		{#each displayPath.items as node, index (node.id)}
			{#if index > 0}
				{#if displayPath.truncated && index === 1}
					<span class="text-(--muted-soft)">…</span>
					<span class="text-(--muted-soft)">::</span>
				{:else}
					<span class="text-(--muted-soft)">::</span>
				{/if}
			{/if}

			{#if node.id === selected?.id}
				<span
					class="font-semibold text-(--ink) {node.is_deprecated ? 'line-through opacity-75' : ''}"
				>
					{node.name}
				</span>
			{:else}
				<a
					href={resolve(getNodeUrl(node.id))}
					data-sveltekit-noscroll
					class="text-(--muted) underline decoration-(--muted-soft)/40 underline-offset-2 transition-colors hover:text-(--accent) hover:decoration-(--accent)/60 {node.is_deprecated
						? 'line-through opacity-75'
						: ''}"
				>
					{node.name}
				</a>
			{/if}
		{/each}
	</nav>
{:else if selected}
	<nav class="flex flex-wrap items-baseline gap-x-1 font-mono text-sm" aria-label="Breadcrumb">
		<span
			class="font-semibold text-(--ink) {selected.is_deprecated ? 'line-through opacity-75' : ''}"
		>
			{selected.name}
		</span>
	</nav>
{/if}
