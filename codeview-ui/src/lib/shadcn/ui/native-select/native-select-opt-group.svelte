<script lang="ts">
	import type { HTMLOptgroupAttributes } from 'svelte/elements';
	import { refAttachment, type WithElementRef } from '$lib/shadcn/utils.js';

	let {
		ref = $bindable(null),
		children,
		...restProps
	}: WithElementRef<HTMLOptgroupAttributes, HTMLOptGroupElement> = $props();
	const attachRef = refAttachment<HTMLOptGroupElement>((node) => (ref = node));
</script>

<optgroup {@attach attachRef} data-slot="native-select-opt-group" {...restProps}>
	{@render children?.()}
</optgroup>
