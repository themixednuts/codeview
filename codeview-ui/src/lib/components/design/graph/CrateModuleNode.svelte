<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';
	import type { CrateMapModuleNode, CrateMapSemanticKind } from '$lib/graph/crate-map';
	import { edgeLabels } from '$lib/display-names';
	import KindBadge from '$lib/components/design/KindBadge.svelte';

	type CrateModuleNodeData = {
		module: CrateMapModuleNode;
		href: string;
		color: string;
		selected: boolean;
		dim: boolean;
		active: boolean;
		incoming: number;
		outgoing: number;
		topKinds: Array<[CrateMapSemanticKind, number]>;
		sizePercent: number;
	};

	let { data } = $props<{ data: CrateModuleNodeData }>();

	const topKindBadges = $derived(
		(data.topKinds.slice(0, 2) as Array<[CrateMapSemanticKind, number]>).map((entry) => {
			const [kind, count] = entry;
			return {
				kind,
				count,
				label: edgeLabels[kind],
			};
		}),
	);

	const style = $derived(
		[
			`--module-color: ${data.color}`,
			`--module-opacity: ${data.dim ? 0.28 : 1}`,
			`--module-border: ${
				data.selected
					? 'var(--accent)'
					: data.active
						? data.color
						: 'var(--panel-border)'
			}`,
			`--module-bg: ${data.selected ? 'var(--accent-soft)' : 'var(--panel-solid)'}`,
		].join('; '),
	);
</script>

<a
	href={data.href}
	data-sveltekit-noscroll
	data-sveltekit-keepfocus
	draggable="false"
	class="crate-module-node block rounded-lg border p-3 text-left shadow-(--shadow-soft) transition-all"
	aria-current={data.selected ? 'page' : undefined}
	title={`${data.module.id} (${data.module.totalNodeCount.toLocaleString()} items)`}
	{style}
>
	<Handle type="target" position={Position.Left} class="crate-module-node__handle" />
	<Handle type="source" position={Position.Right} class="crate-module-node__handle" />

	<div class="mb-2 flex min-w-0 items-center gap-2">
		<KindBadge kind={data.module.kind} size={17} />
		<span class="mono min-w-0 flex-1 truncate text-sm font-semibold text-(--ink)">
			{data.module.name}
		</span>
		<span class="mono shrink-0 rounded bg-(--panel-muted) px-1.5 py-0.5 text-2xs text-(--muted)">
			d{data.module.depth}
		</span>
	</div>

	<div class="mb-2 h-1.5 overflow-hidden rounded-full bg-(--panel-muted)" aria-hidden="true">
		<div
			class="h-full rounded-full"
			style={`width: ${data.sizePercent}%; background: var(--module-color); opacity: 0.72`}
		></div>
	</div>

	<div class="mono flex items-center gap-3 text-xs text-(--muted-soft)">
		<span><b class="text-(--ink-soft)">{data.module.totalNodeCount.toLocaleString()}</b> items</span>
		{#if data.module.childModuleCount > 0}
			<span><b class="text-(--ink-soft)">{data.module.childModuleCount}</b> children</span>
		{/if}
	</div>

	{#if data.incoming > 0 || data.outgoing > 0 || data.topKinds.length > 0}
		<div class="mt-2 flex flex-wrap items-center gap-1">
			{#if data.outgoing > 0}
				<span class="badge badge-sm">out {data.outgoing.toLocaleString()}</span>
			{/if}
			{#if data.incoming > 0}
				<span class="badge badge-sm">in {data.incoming.toLocaleString()}</span>
			{/if}
			{#each topKindBadges as entry (entry.kind)}
				<span class="badge badge-sm">
					{entry.label}
					{entry.count}
				</span>
			{/each}
		</div>
	{/if}
</a>

<style>
	.crate-module-node {
		width: 220px;
		min-height: 78px;
		background: var(--module-bg);
		border-color: var(--module-border);
		opacity: var(--module-opacity);
		cursor: grab;
		text-decoration: none;
	}

	.crate-module-node:active {
		cursor: grabbing;
	}

	.crate-module-node:hover,
	.crate-module-node:focus-visible {
		border-color: var(--module-color);
		background: var(--panel-strong);
		transform: translateY(-1px);
	}

	.crate-module-node:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 3px;
	}

	.crate-module-node :global(.crate-module-node__handle) {
		width: 1px;
		height: 1px;
		min-width: 1px;
		min-height: 1px;
		border: 0;
		background: transparent;
		opacity: 0;
		pointer-events: none;
	}
</style>
