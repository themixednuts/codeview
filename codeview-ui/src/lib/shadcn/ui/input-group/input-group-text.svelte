<script lang="ts">
	import { cn, refAttachment, type WithElementRef } from '$lib/shadcn/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';

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
	class={cn(
		"text-muted-foreground flex items-center gap-2 text-sm [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4",
		className,
	)}
	{...restProps}
>
	{@render children?.()}
</span>
