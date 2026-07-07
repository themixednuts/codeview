<script lang="ts">
	import type { RelationshipLabelFlowData } from './flow-types';

	let { data } = $props<{ data: RelationshipLabelFlowData }>();

	const style = $derived(
		[
			`--relationship-label-width: ${data.width}px`,
			`--relationship-label-color: ${data.color}`,
			`--relationship-label-opacity: ${data.dim ? 0.28 : data.active ? 1 : 0.86}`,
		].join('; '),
	);
</script>

<div
	class="relationship-label-flow flex h-5 items-center justify-center rounded-full border bg-(--panel-solid) px-2"
	{style}
>
	<span class="mono truncate text-[10.5px] font-semibold">{data.text}</span>
	<span class="mono ml-2 text-[9.5px] font-bold opacity-75">{data.count}</span>
</div>

<style>
	.relationship-label-flow {
		width: var(--relationship-label-width);
		border-color: var(--relationship-label-color);
		color: var(--relationship-label-color);
		opacity: var(--relationship-label-opacity);
		pointer-events: none;
		transition: opacity 0.15s ease;
	}
</style>
