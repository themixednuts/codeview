<script lang="ts">
	import { cn, refAttachment, type WithElementRef } from '$lib/shadcn/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLParagraphElement>, HTMLParagraphElement> = $props();
	const attachRef = refAttachment<HTMLParagraphElement>((node) => (ref = node));
</script>

<p
	{@attach attachRef}
	data-slot="field-description"
	class={cn(
		'text-muted-foreground text-left text-sm leading-normal font-normal group-has-[[data-orientation=horizontal]]/field:text-balance [[data-variant=legend]+&]:-mt-1.5',
		'last:mt-0 nth-last-2:-mt-1',
		'[&>a:hover]:text-primary [&>a]:underline [&>a]:underline-offset-4',
		className,
	)}
	{...restProps}
>
	{@render children?.()}
</p>
