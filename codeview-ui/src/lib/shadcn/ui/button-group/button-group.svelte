<script lang="ts">
	import type { HTMLAttributes } from "svelte/elements";
	import { cn, type WithElementRef } from "$lib/shadcn/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<div
	bind:this={ref}
	data-slot="button-group"
	role="group"
	class={cn(
		"corner-squircle inline-flex items-center rounded-(--radius-control) border border-(--panel-border) bg-(--panel-solid) p-0.5",
		className,
	)}
	{...restProps}
>
	{@render children?.()}
</div>
