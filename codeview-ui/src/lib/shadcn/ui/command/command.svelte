<script lang="ts">
	import { cn } from '$lib/shadcn/utils.js';
	import { Command as CommandPrimitive } from 'bits-ui';

	let {
		ref = $bindable(null),
		value = $bindable(''),
		class: className,
		...restProps
	}: CommandPrimitive.RootProps = $props();
</script>

<CommandPrimitive.Root
	bind:value
	bind:ref
	data-slot="command"
	class={cn(
		'bg-popover text-popover-foreground flex size-full flex-col overflow-hidden rounded-xl! p-1',
		className,
	)}
	{...restProps}
/>
