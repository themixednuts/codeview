<script lang="ts">
	import { slide } from 'svelte/transition';
	import { untrack } from 'svelte';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';

	let {
		title,
		count = null,
		defaultOpen = true,
		children,
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

<section
	class="corner-squircle mb-6 overflow-hidden rounded-(--radius-card) border border-(--panel-border) bg-(--panel-solid)"
>
	<button
		type="button"
		class="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-(--panel-strong)"
		onclick={() => (isOpen = !isOpen)}
	>
		<div class="flex items-center gap-2">
			<span class="text-(--muted) transition-transform duration-200" class:rotate-90={isOpen}>
				<ChevronRight size={16} />
			</span>
			<h3 class="text-sm font-semibold tracking-wider text-(--muted) uppercase">{title}</h3>
			{#if count !== null}
				<span class="badge badge-strong badge-sm text-(--muted)">
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
