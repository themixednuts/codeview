<script lang="ts">
	import ChevronRight from '@lucide/svelte/icons/chevron-right';

	let {
		title,
		count = null,
		defaultOpen = true,
		forceOpen = null,
		forceToken = 0,
		children,
	} = $props<{
		title: string;
		count?: number | null;
		defaultOpen?: boolean;
		/** When non-null, forces open/closed (expand-all / collapse-all). */
		forceOpen?: boolean | null;
		/** Bump to re-apply forceOpen after the user toggled natively. */
		forceToken?: number;
		children: import('svelte').Snippet;
	}>();

	// Native <details> works without JS. forceOpen only upgrades when set.
	// {@key forceToken} remounts so expand-all re-applies after a manual toggle.
	const open = $derived(forceOpen ?? defaultOpen);
</script>

{#key forceToken}
	<details
		class="corner-squircle mb-6 overflow-hidden rounded-(--radius-card) border border-(--panel-border) bg-(--panel-solid)"
		open={open}
	>
	<summary
		class="flex w-full cursor-pointer list-none items-center justify-between px-4 py-3 text-left transition-colors hover:bg-(--panel-strong)"
	>
		<div class="flex items-center gap-2">
			<span class="text-(--muted) transition-transform duration-200 details-chevron">
				<ChevronRight size={16} />
			</span>
			<h3 class="text-sm font-semibold tracking-wider text-(--muted) uppercase">{title}</h3>
			{#if count !== null}
				<span class="badge badge-strong badge-sm text-(--muted)">
					{count}
				</span>
			{/if}
		</div>
	</summary>

	<div class="px-4 pb-4">
		{@render children()}
	</div>
	</details>
{/key}

<style>
	summary::-webkit-details-marker {
		display: none;
	}

	details[open] .details-chevron {
		transform: rotate(90deg);
	}
</style>
