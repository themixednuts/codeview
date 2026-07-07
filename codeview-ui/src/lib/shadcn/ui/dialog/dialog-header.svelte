<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn, refAttachment, type WithElementRef } from '$lib/shadcn/utils.js';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();

	const attachRef = refAttachment<HTMLDivElement>((node) => {
		ref = node;
	});
</script>

<div
	{@attach attachRef}
	data-slot="dialog-header"
	class={cn('flex flex-col gap-2 text-center sm:text-start', className)}
	{...restProps}
>
	{@render children?.()}
</div>
