<script lang="ts">
	import { cn, refAttachment, type WithElementRef } from '$lib/shadcn/utils.js';
	import type { HTMLFieldsetAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLFieldsetAttributes, HTMLFieldSetElement> = $props();
	const attachRef = refAttachment<HTMLFieldSetElement>((node) => (ref = node));
</script>

<fieldset
	{@attach attachRef}
	data-slot="field-set"
	class={cn(
		'flex flex-col gap-4 has-[>[data-slot=checkbox-group]]:gap-3 has-[>[data-slot=radio-group]]:gap-3',
		className,
	)}
	{...restProps}
>
	{@render children?.()}
</fieldset>
