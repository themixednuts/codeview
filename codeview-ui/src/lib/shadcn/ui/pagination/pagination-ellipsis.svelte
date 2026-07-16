<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import {
		cn,
		refAttachment,
		type WithElementRef,
		type WithoutChildren,
	} from '$lib/shadcn/utils.js';
	import MoreHorizontalIcon from '@lucide/svelte/icons/more-horizontal';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: WithoutChildren<WithElementRef<HTMLAttributes<HTMLSpanElement>, HTMLSpanElement>> = $props();
	const attachRef = refAttachment<HTMLSpanElement>((node) => (ref = node));
</script>

<span
	{@attach attachRef}
	aria-hidden="true"
	data-slot="pagination-ellipsis"
	class={cn(
		"flex size-8 items-center items-center justify-center justify-center [&_svg:not([class*='size-'])]:size-4",
		className,
	)}
	{...restProps}
>
	<MoreHorizontalIcon />
	<span class="sr-only">More pages</span>
</span>
