<script lang="ts">
	import { tooltip } from '$lib/tooltip';

	export type LayoutMode = 'ego' | 'force' | 'hierarchical' | 'radial';

	interface Props {
		mode: LayoutMode;
		onModeChange: (mode: LayoutMode) => void;
	}

	let { mode, onModeChange }: Props = $props();

	const layouts: { id: LayoutMode; label: string; description: string }[] = [
		{
			id: 'ego',
			label: 'Ego',
			description:
				'Centers the selected node with direct connections radiating outward in two columns',
		},
		{
			id: 'force',
			label: 'Force',
			description: 'Physics simulation arranging nodes by connectivity \u2014 drag to reposition',
		},
		{
			id: 'hierarchical',
			label: 'Hierarchy',
			description: 'Top-down tree showing parent-child relationships in ranked layers',
		},
		{
			id: 'radial',
			label: 'Radial',
			description: 'Concentric rings with the selected node at center, ordered by distance',
		},
	];

	let buttonRefs: Record<LayoutMode, HTMLButtonElement | null> = $state({
		ego: null,
		force: null,
		hierarchical: null,
		radial: null,
	});

	const indicatorStyle = $derived.by(() => {
		const btn = buttonRefs[mode];
		if (!btn) return { left: 0, width: 0 };
		return { left: btn.offsetLeft, width: btn.offsetWidth };
	});

	function handleModeChange(newMode: LayoutMode) {
		if (newMode === mode) return;

		if (document.startViewTransition) {
			document.startViewTransition(() => {
				onModeChange(newMode);
			});
		} else {
			onModeChange(newMode);
		}
	}
</script>

<div
	class="corner-squircle relative flex items-center gap-1 rounded-(--radius-control) border border-(--panel-border) bg-(--panel-solid) p-1"
>
	<!-- Sliding indicator -->
	<div
		class="corner-squircle absolute top-1 bottom-1 rounded-(--radius-chip) bg-(--accent) transition-all duration-150 ease-out"
		style="left: {indicatorStyle.left}px; width: {indicatorStyle.width}px; view-transition-name: layout-indicator"
	></div>

	{#each layouts as layout (layout.id)}
		<button
			type="button"
			class="badge badge-lg relative z-10 border-transparent bg-transparent text-xs transition-colors {mode ===
			layout.id
				? 'text-(--on-accent)'
				: 'text-(--muted) hover:text-(--ink)'}"
			onclick={() => handleModeChange(layout.id)}
			{@attach tooltip(layout.description)}
			{@attach (el) => {
				buttonRefs[layout.id] = el as HTMLButtonElement;
				return () => {
					buttonRefs[layout.id] = null;
				};
			}}
		>
			{layout.label}
		</button>
	{/each}
</div>
