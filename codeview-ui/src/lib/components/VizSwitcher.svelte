<script lang="ts">
	import { tooltip } from '$lib/tooltip';

	export type VizMode = 'treemap' | 'sunburst' | 'grid';

	interface Props {
		mode: VizMode;
		onModeChange: (mode: VizMode) => void;
	}

	let { mode, onModeChange }: Props = $props();

	const vizModes: { id: VizMode; label: string; description: string }[] = [
		{
			id: 'treemap',
			label: 'Treemap',
			description: 'Nested rectangles sized by item count — see module hierarchy at a glance',
		},
		{
			id: 'sunburst',
			label: 'Sunburst',
			description: 'Radial rings showing nesting depth — drill into module layers',
		},
		{
			id: 'grid',
			label: 'Grid',
			description: 'Module cards sorted by size — scan modules and their item counts',
		},
	];

	let buttonRefs: Record<VizMode, HTMLButtonElement | null> = $state({
		treemap: null,
		sunburst: null,
		grid: null,
	});

	const indicatorStyle = $derived.by(() => {
		const btn = buttonRefs[mode];
		if (!btn) return { left: 0, width: 0, ready: false };
		return { left: btn.offsetLeft, width: btn.offsetWidth, ready: true };
	});

	function handleModeChange(newMode: VizMode) {
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
	<div
		class="corner-squircle absolute top-1 bottom-1 rounded-(--radius-chip) bg-(--accent) transition-all duration-150 ease-out"
		style="left: {indicatorStyle.left}px; width: {indicatorStyle.width}px; opacity: {indicatorStyle.ready ? 1 : 0}; view-transition-name: viz-indicator"
	></div>

	{#each vizModes as viz (viz.id)}
		<button
			type="button"
			class="badge badge-lg relative z-10 border-transparent bg-transparent text-xs transition-colors {mode ===
			viz.id
				? 'text-(--on-accent)'
				: 'text-(--muted) hover:text-(--ink)'}"
			onclick={() => handleModeChange(viz.id)}
			{@attach tooltip(viz.description)}
			{@attach (el) => {
				buttonRefs[viz.id] = el as HTMLButtonElement;
				return () => {
					buttonRefs[viz.id] = null;
				};
			}}
		>
			{viz.label}
		</button>
	{/each}
</div>
