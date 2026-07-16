<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn, refAttachment, type WithElementRef } from '$lib/shadcn/utils.js';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLUListElement>, HTMLUListElement> = $props();
	const attachRef = refAttachment<HTMLUListElement>((node) => (ref = node));
</script>

<ul
	{@attach attachRef}
	data-slot="pagination-content"
	class={cn('flex items-center gap-0.5', className)}
	{...restProps}
>
	{@render children?.()}
</ul>
