<script lang="ts">
	import type { HTMLOptionAttributes } from 'svelte/elements';
	import { cn, refAttachment, type WithElementRef } from '$lib/shadcn/utils.js';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLOptionAttributes, HTMLOptionElement> = $props();
	const attachRef = refAttachment<HTMLOptionElement>((node) => (ref = node));
</script>

<option
	{@attach attachRef}
	data-slot="native-select-option"
	class={cn('bg-[Canvas] text-[CanvasText]', className)}
	{...restProps}
>
	{@render children?.()}
</option>
