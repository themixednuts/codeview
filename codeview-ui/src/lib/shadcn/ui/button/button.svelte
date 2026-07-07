<script lang="ts">
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import { cn, refAttachment, type WithElementRef } from '$lib/shadcn/utils.js';

	type Variant = 'default' | 'outline' | 'secondary' | 'ghost';
	type Size = 'default' | 'sm' | 'icon';

	type Props = WithElementRef<HTMLButtonAttributes> & {
		variant?: Variant;
		size?: Size;
	};

	const variantClasses: Record<Variant, string> = {
		default: 'bg-primary text-primary-foreground hover:bg-primary/90',
		outline:
			'border border-(--panel-border) bg-(--panel-solid) text-(--muted) hover:bg-(--panel-strong) hover:text-(--ink)',
		secondary: 'bg-(--panel) text-(--ink) hover:bg-(--panel-strong)',
		ghost: 'bg-transparent text-(--muted) hover:bg-(--panel-strong) hover:text-(--ink)',
	};

	const sizeClasses: Record<Size, string> = {
		default: 'h-9 px-4 py-2 text-sm',
		sm: 'h-7 px-2.5 text-xs',
		icon: 'size-7',
	};

	let {
		ref = $bindable(null),
		class: className,
		variant = 'outline',
		size = 'default',
		children,
		...restProps
	}: Props = $props();

	const attachRef = refAttachment<HTMLButtonElement>((node) => (ref = node));
</script>

<button
	{@attach attachRef}
	data-slot="button"
	class={cn(
		'corner-squircle inline-flex items-center justify-center gap-1.5 rounded-(--radius-control) font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-(--accent) focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50',
		variantClasses[variant],
		sizeClasses[size],
		className,
	)}
	{...restProps}
>
	{@render children?.()}
</button>
