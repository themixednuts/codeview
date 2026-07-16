<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as RadioGroup from '$lib/shadcn/ui/radio-group';
	import { cn } from '$lib/shadcn/utils';

	let {
		id,
		value,
		label,
		class: className,
		children,
	}: {
		id: string;
		value: string;
		label: string;
		class?: string;
		children: Snippet;
	} = $props();
</script>

<div class={cn('relative h-8 min-w-0', className)}>
	<RadioGroup.Item
		{id}
		{value}
		aria-label={label}
		class="peer absolute inset-0 z-10 size-full cursor-pointer rounded-lg opacity-0"
	/>
	<div
		aria-hidden="true"
		data-slot="settings-radio-option"
		class="border-input peer-data-[state=checked]:border-primary peer-data-[state=checked]:bg-primary peer-data-[state=checked]:text-primary-foreground peer-focus-visible:border-ring peer-focus-visible:ring-ring/50 pointer-events-none flex size-full min-w-0 items-center justify-center gap-1 rounded-lg border bg-transparent px-2.5 text-sm font-medium whitespace-nowrap transition-all peer-focus-visible:ring-3"
	>
		{@render children()}
	</div>
</div>
