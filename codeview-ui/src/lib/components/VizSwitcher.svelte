<script lang="ts">
	import { tooltip } from '$lib/tooltip';

	export type VizMode = 'graph' | 'treemap' | 'sunburst' | 'grid';

	interface Props {
		mode: VizMode;
		onModeChange: (mode: VizMode) => void;
	}

	let { mode, onModeChange }: Props = $props();

	const vizModes: { id: VizMode; label: string; description: string }[] = [
		{
			id: 'graph',
			label: 'Graph',
			description: 'Read-only module graph — see hierarchy and semantic coupling',
		},
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

	const modeIndex = $derived(Math.max(0, vizModes.findIndex((viz) => viz.id === mode)));
	const indicatorStyle = $derived(
		`left: calc(0.25rem + ${modeIndex} * ((100% - 0.5rem) / ${vizModes.length})); width: calc((100% - 0.5rem) / ${vizModes.length}); view-transition-name: viz-indicator;`,
	);

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
	class="corner-squircle relative grid grid-cols-4 rounded-(--radius-control) border border-(--panel-border) bg-(--panel-solid) p-1"
>
	<div
		class="corner-squircle absolute top-1 bottom-1 rounded-(--radius-chip) bg-(--accent) transition-all duration-150 ease-out"
		style={indicatorStyle}
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
		>
			{viz.label}
		</button>
	{/each}
</div>
