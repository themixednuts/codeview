<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';
	import type { GraphNodePillFlowData } from './flow-types';
	import KindBadge from '$lib/components/design/KindBadge.svelte';

	let { data } = $props<{ data: GraphNodePillFlowData }>();

	const targetPosition = $derived(
		data.direction === 'outgoing' || data.direction === 'focus' ? Position.Left : Position.Right,
	);
	const sourcePosition = $derived(
		data.direction === 'incoming' || data.direction === 'focus' ? Position.Right : Position.Left,
	);

	const style = $derived(
		[
			`--pill-width: ${data.width}px`,
			`--pill-height: ${data.height}px`,
			`--pill-bg: ${data.isFocus ? 'var(--accent)' : 'var(--panel-solid)'}`,
			`--pill-border: ${
				data.isFocus
					? '1px solid var(--accent)'
					: `1px solid ${data.active ? data.color : 'var(--panel-border)'}`
			}`,
			`--pill-shadow: ${
				data.isFocus
					? '0 8px 22px var(--accent-ring)'
					: data.active
						? `0 4px 14px color-mix(in srgb, ${data.color} 30%, transparent)`
						: 'var(--shadow-soft)'
			}`,
			`--pill-opacity: ${data.dim ? 0.28 : 1}`,
			`--pill-transform: ${data.active && !data.isFocus ? 'translateY(-1px)' : 'none'}`,
			`--pill-ink: ${data.isFocus ? 'var(--on-accent)' : 'var(--ink)'}`,
			`--pill-padding: ${data.isFocus ? '0 18px' : '0 11px'}`,
		].join('; '),
	);

</script>

<a
	href={data.href}
	data-sveltekit-noscroll
	data-sveltekit-keepfocus
	draggable="false"
	class="graph-node-pill-flow flex min-w-0 items-center gap-2 rounded-lg transition-all"
	data-focus={data.isFocus}
	data-active={data.active}
	aria-current={data.isFocus ? 'page' : undefined}
	title={`${data.node.path} (${data.inCount} incoming, ${data.outCount} outgoing)`}
	{style}
>
	<KindBadge kind={data.node.kind} size={data.isFocus ? 20 : 16} />
	<Handle type="target" position={targetPosition} class="graph-node-pill-flow__handle" />
	<Handle type="source" position={sourcePosition} class="graph-node-pill-flow__handle" />
	<span class="graph-node-pill-flow__label truncate text-left leading-none">
		{data.node.label || data.node.id}
	</span>
	{#if data.isFocus}
		<span class="mono ml-auto shrink-0 text-2xs tracking-wider uppercase opacity-70">
			{data.node.kindLabel ?? data.node.kind}
		</span>
	{/if}
</a>

<style>
	.graph-node-pill-flow {
		width: var(--pill-width);
		height: var(--pill-height);
		padding: var(--pill-padding);
		background: var(--pill-bg);
		border: var(--pill-border);
		box-shadow: var(--pill-shadow);
		opacity: var(--pill-opacity);
		transform: var(--pill-transform);
		color: var(--pill-ink);
		cursor: grab;
		text-decoration: none;
	}

	.graph-node-pill-flow:active {
		cursor: grabbing;
	}

	.graph-node-pill-flow:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 3px;
	}

	.graph-node-pill-flow__label {
		font-family: var(--font-code);
		font-size: var(--text-sm);
		font-weight: 600;
		color: var(--pill-ink);
	}

	.graph-node-pill-flow :global(.graph-node-pill-flow__handle) {
		width: 1px;
		height: 1px;
		min-width: 1px;
		min-height: 1px;
		border: 0;
		background: transparent;
		opacity: 0;
		pointer-events: none;
	}

	.graph-node-pill-flow[data-focus='true'] .graph-node-pill-flow__label {
		font-family: var(--font-display);
		font-size: var(--text-md);
		font-weight: 700;
	}
</style>
