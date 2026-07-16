<script lang="ts">
	import type { HTMLLiAttributes } from 'svelte/elements';
	import { refAttachment, type WithElementRef } from '$lib/shadcn/utils.js';

	let {
		ref = $bindable(null),
		children,
		...restProps
	}: WithElementRef<HTMLLiAttributes, HTMLLIElement> = $props();
	const attachRef = refAttachment<HTMLLIElement>((node) => (ref = node));
</script>

<li {@attach attachRef} data-slot="pagination-item" {...restProps}>
	{@render children?.()}
</li>
