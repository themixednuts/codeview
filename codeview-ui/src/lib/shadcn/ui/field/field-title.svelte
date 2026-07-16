<script lang="ts">
	import { cn, refAttachment, type WithElementRef } from '$lib/shadcn/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>, HTMLDivElement> = $props();
	const attachRef = refAttachment<HTMLDivElement>((node) => (ref = node));
</script>

<div
	{@attach attachRef}
	data-slot="field-label"
	class={cn(
		'flex w-fit items-center gap-2 text-sm leading-snug leading-snug font-medium group-data-[disabled=true]/field:opacity-50',
		className,
	)}
	{...restProps}
>
	{@render children?.()}
</div>
