<script lang="ts">
	import type { RelationshipEdgeData } from './flow-types';

	let { data } = $props<{ data?: RelationshipEdgeData }>();

	const edgeData = $derived(
		data ?? {
			kind: 'Contains',
			relation: 'contains',
			direction: 'outgoing',
			color: 'var(--edge-default)',
			path: '',
			arrowPath: '',
			dim: true,
			active: false,
		},
	);
	const opacity = $derived(edgeData.dim ? 0.12 : edgeData.active ? 0.95 : 0.72);
	const strokeWidth = $derived(edgeData.active ? 2.1 : 1.45);
</script>

<g class="relationship-edge" aria-hidden="true" style={`opacity: ${opacity}`}>
	<path
		class="relationship-edge__path"
		d={edgeData.path}
		fill="none"
		stroke={edgeData.color}
		stroke-width={strokeWidth}
		stroke-linecap="round"
	/>
	<path class="relationship-edge__arrow" d={edgeData.arrowPath} fill={edgeData.color} stroke="none" />
</g>

<style>
	.relationship-edge {
		transition: opacity 0.15s ease;
		pointer-events: none;
	}
</style>
