<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn, refAttachment, type WithElementRef } from '$lib/shadcn/utils.js';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();

	const attachRef = refAttachment<HTMLDivElement>((node) => (ref = node));
</script>

<div
	{@attach attachRef}
	data-slot="sheet-header"
	class={cn('flex flex-col gap-1.5 p-4', className)}
	{...restProps}
>
	{@render children?.()}
</div>
