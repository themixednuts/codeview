<script lang="ts">
	import type { NodeSummary } from '$lib/schema';
	import type { NodeKind } from '$lib/graph';
	import { resolve } from '$app/paths';
	import { kindColors, kindIcons } from '$lib/tree';
	import Skeleton from '$lib/components/Skeleton.svelte';

	let {
		searchQuery,
		filter,
		selectedNodeId,
		getNodeUrl,
	}: {
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
			<div class="px-2 pb-1 text-xs text-(--muted)">
				{results.length} result{results.length === 1 ? '' : 's'}
			</div>
			{#each results as node (node.id)}
				{@const isSelected = selectedNodeId === node.id}
				{@const KindIcon = kindIcons[node.kind] ?? kindIcons.Crate}
				<a
					href={resolve(getNodeUrl(node.id) as `/${string}`)}
					data-sveltekit-noscroll
					class="corner-squircle flex items-center gap-2 rounded-(--radius-chip) px-2 py-1.5 text-sm hover:bg-(--panel-strong) {isSelected
						? 'bg-(--accent)/10 ring-1 ring-(--accent) ring-inset'
						: ''}"
				>
					<span
						class="corner-squircle flex size-5 shrink-0 items-center justify-center rounded-(--radius-chip) text-(--on-accent)"
						style="background-color: {kindColors[node.kind] ?? kindColors.Crate}"
					>
						<KindIcon size={12} strokeWidth={2.5} />
					</span>
					<span class="min-w-0 flex-1">
						<span class="block truncate font-medium text-(--ink)">{node.name}</span>
						<span class="block truncate text-xs text-(--muted)">{node.id}</span>
					</span>
				</a>
			{/each}
		</div>
	{:else}
		<div class="p-4 text-sm text-(--muted)">
			No results for "{filter}"
		</div>
	{/if}
	{#snippet pending()}
		<!-- Skeleton search results -->
		<div class="p-2">
			<Skeleton width="5rem" height="0.75rem" rounded="sm" class="mb-2 ml-2" />
			{#each [1, 2, 3, 4, 5] as _, i (i)}
				<div class="flex items-center gap-2 px-2 py-1.5">
					<Skeleton width="1.25rem" height="1.25rem" rounded="md" />
					<div class="flex-1">
						<Skeleton width="60%" height="0.875rem" rounded="sm" class="mb-1" />
						<Skeleton width="80%" height="0.625rem" rounded="sm" />
					</div>
				</div>
			{/each}
		</div>
	{/snippet}
	{#snippet failed(error, reset)}
		<div class="p-4 text-sm text-(--danger)">
			<p>Search failed.</p>
			<button type="button" class="mt-2 text-(--accent) hover:underline" onclick={reset}>
				Try again
			</button>
		</div>
	{/snippet}
</svelte:boundary>
