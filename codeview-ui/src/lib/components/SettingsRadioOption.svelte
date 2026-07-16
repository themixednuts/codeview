<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as RadioGroup from '$lib/shadcn/ui/radio-group';
	import { cn } from '$lib/shadcn/utils';

	let {
		id,
		value,
		label,
		variant = 'outline',
		class: className,
		contentClass,
		style,
		children,
	}: {
		id: string;
		value: string;
		label: string;
		variant?: 'outline' | 'segmented' | 'swatch';
		class?: string;
		contentClass?: string;
		style?: string;
		children: Snippet;
	} = $props();
</script>

<div class={cn('relative h-8 min-w-0', className)}>
	<RadioGroup.Item
		{id}
		{value}
		aria-label={label}
		class="peer absolute inset-0 z-10 size-full cursor-pointer rounded-(--radius-chip) opacity-0"
	/>
	<div
		aria-hidden="true"
		data-slot="settings-radio-option"
		{style}
		class={cn(
			'pointer-events-none flex size-full min-w-0 items-center justify-center gap-1.5 rounded-(--radius-chip) px-2 text-xs font-medium whitespace-nowrap transition-all duration-200 peer-focus-visible:ring-2 peer-focus-visible:ring-(--accent-ring) peer-focus-visible:ring-offset-1',
			variant === 'outline' &&
				'border border-(--panel-border) bg-transparent text-(--ink) peer-data-[state=checked]:border-(--accent) peer-data-[state=checked]:bg-(--accent) peer-data-[state=checked]:text-(--on-accent)',
			variant === 'segmented' &&
				'text-(--muted) peer-hover:text-(--ink) peer-data-[state=checked]:text-(--on-accent) peer-data-[state=checked]:peer-hover:text-(--on-accent)',
			variant === 'swatch' &&
				'border-2 border-transparent peer-hover:scale-105 peer-data-[state=checked]:border-(--ink) peer-data-[state=checked]:shadow-(--shadow-toggle)',
			contentClass,
		)}
	>
		{@render children()}
	</div>
</div>
