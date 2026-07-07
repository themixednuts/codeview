<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn, refAttachment, type WithElementRef } from '$lib/shadcn/utils.js';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLSpanElement>, HTMLSpanElement> = $props();

	const attachRef = refAttachment<HTMLSpanElement>((node) => (ref = node));
</script>

<span
	{@attach attachRef}
	data-slot="command-shortcut"
	class={cn('text-muted-foreground ms-auto text-xs tracking-widest', className)}
	{...restProps}
>
	{@render children?.()}
</span>
