<script lang="ts">
	import { cn, refAttachment, type WithElementRef } from '$lib/shadcn/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		variant = 'legend',
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLLegendElement>, HTMLLegendElement> & {
		variant?: 'legend' | 'label';
	} = $props();
	const attachRef = refAttachment<HTMLLegendElement>((node) => (ref = node));
</script>

<legend
	{@attach attachRef}
	data-slot="field-legend"
	data-variant={variant}
	class={cn(
		'mb-1.5 font-medium data-[variant=label]:text-sm data-[variant=legend]:text-base',
		className,
	)}
	{...restProps}
>
	{@render children?.()}
</legend>
