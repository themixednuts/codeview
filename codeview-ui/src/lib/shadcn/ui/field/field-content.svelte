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
	data-slot="field-content"
	class={cn('group/field-content flex flex-1 flex-col gap-0.5 leading-snug', className)}
	{...restProps}
>
	{@render children?.()}
</div>
