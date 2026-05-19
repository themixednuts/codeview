<script lang="ts">
	import type { CrateMapData, CrateMapModuleNode } from '$lib/graph/crate-map';
	import { resolveAppPath } from '$lib/app-paths';
	import {
		computeSunburstArcs,
		arcPath,
		findContainingModule,
		moduleDepthColor,
		type SunburstArc,
	} from '$lib/graph/crate-map';

	let {
		data,
		selectedNodeId = null,
		getNodeUrl,
		drillId = null,
		onDrillChange,
	} = $props<{
		data: CrateMapData;
		selectedNodeId?: string | null;
		getNodeUrl: (id: string) => string;
		drillId?: string | null;
		onDrillChange?: (id: string | null) => void;
	}>();

	const RING_WIDTH = 44;
	const MIN_ARC_ANGLE = 0.015; // ~0.9 degrees — skip tiny arcs

	let hoveredModuleId = $state<string | null>(null);

	const highlightedModuleId = $derived(
		selectedNodeId ? findContainingModule(selectedNodeId, data.moduleNodes) : null,
	);

	const childrenByParent = $derived.by(() => {
		const byParent = new Map<string, CrateMapModuleNode[]>();
		for (const m of data.moduleNodes) {
			if (!m.parentId) continue;
			let list = byParent.get(m.parentId);
			if (!list) {
				list = [];
				byParent.set(m.parentId, list);
			}
			list.push(m);
		}
		return byParent;
	});

	const moduleById = $derived.by<Map<string, CrateMapModuleNode>>(() => {
		return new Map(data.moduleNodes.map((m: CrateMapModuleNode) => [m.id, m]));
	});

	const drillModule = $derived(drillId ? (moduleById.get(drillId) ?? null) : null);

	const visibleModules = $derived.by(() => {
		if (!drillModule) return data.moduleNodes;
		const result: CrateMapModuleNode[] = [drillModule];
		const collect = (parentId: string) => {
			const children = childrenByParent.get(parentId);
			if (!children) return;
			for (const child of children) {
				result.push(child);
				collect(child.id);
			}
		};
		collect(drillModule.id);
		return result.map((m) =>
			m.id === drillModule.id
				? { ...m, parentId: null, depth: 0 }
				: { ...m, depth: m.depth - drillModule.depth },
		);
	});

	const arcs = $derived.by<SunburstArc[]>(() => {
		return computeSunburstArcs(visibleModules, RING_WIDTH);
	});

	const maxDepth = $derived(arcs.reduce((max, a) => Math.max(max, a.depth), 0));

	const outerRadius = $derived((maxDepth + 1) * RING_WIDTH + 10);
	const viewSize = $derived(outerRadius * 2 + 40);
	const cx = $derived(viewSize / 2);
	const cy = $derived(viewSize / 2);

	const rootModule = $derived.by(() => {
		for (const m of data.moduleNodes) {
			if (m.parentId === null) return m;
		}
		return data.moduleNodes[0] ?? null;
	});

	const centerLabel = $derived(drillModule?.name ?? rootModule?.name ?? data.crateId);

	const centerCount = $derived((drillModule ?? rootModule)?.totalNodeCount ?? data.totalNodeCount);

	const depthColor = moduleDepthColor;

	function arcOpacity(arc: SunburstArc): number {
		if (hoveredModuleId === arc.module.id) return 0.9;
		if (hoveredModuleId) return 0.3;
		if (highlightedModuleId === arc.module.id) return 0.85;
		return 0.6;
	}

	function handleClick(e: MouseEvent, arc: SunburstArc) {
		const children = childrenByParent.get(arc.module.id);
		if (children && children.length > 0) {
			e.preventDefault();
			onDrillChange?.(arc.module.id);
		}
		// else: let the <a> navigate
	}

	function drillBack() {
		if (!drillModule) return;
		// Go up one level — use moduleById for O(1) lookup
		const parent = drillModule.parentId ? moduleById.get(drillModule.parentId) : undefined;
		onDrillChange?.(parent?.id ?? null);
	}

	const hoveredArcModule = $derived(
		hoveredModuleId ? (moduleById.get(hoveredModuleId) ?? null) : null,
	);
</script>

<div
	class="corner-squircle overflow-hidden rounded-(--radius-card) border border-(--panel-border) bg-(--panel-solid)"
>
	<div
		class="flex flex-wrap items-center justify-between gap-3 border-b border-(--panel-border) bg-(--panel) px-4 py-2"
	>
		<div>
			<p class="text-sm font-medium text-(--ink)">Module Sunburst</p>
			<p class="text-xs text-(--muted)">
				{data.totalNodeCount.toLocaleString()} items · {maxDepth + 1} depth levels
			</p>
		</div>
		{#if drillId}
			<button type="button" class="text-xs text-(--accent) hover:underline" onclick={drillBack}>
				← Back
			</button>
		{/if}
	</div>

	<div class="flex items-center justify-center overflow-x-auto p-4">
		<svg
			viewBox="0 0 {viewSize} {viewSize}"
			class="h-auto max-h-[500px] w-auto max-w-full"
			preserveAspectRatio="xMidYMid meet"
			aria-label="Module sunburst"
		>
			{#each arcs as arc (arc.module.id)}
				{@const span = arc.endAngle - arc.startAngle}
				{#if span > MIN_ARC_ANGLE}
					<a
						href={resolveAppPath(getNodeUrl(arc.module.id))}
						data-sveltekit-noscroll
						onclick={(e) => handleClick(e, arc)}
						onmouseenter={() => {
							hoveredModuleId = arc.module.id;
						}}
						onmouseleave={() => {
							hoveredModuleId = null;
						}}
					>
						<path
							d={arcPath(cx, cy, arc.innerRadius, arc.outerRadius, arc.startAngle, arc.endAngle)}
							fill={depthColor(arc.depth)}
							fill-opacity={arcOpacity(arc)}
							stroke="var(--panel-solid)"
							stroke-width="1"
						/>
						{#if span > 0.2 && arc.outerRadius - arc.innerRadius > 20}
							{@const midAngle = (arc.startAngle + arc.endAngle) / 2 - Math.PI / 2}
							{@const midR = (arc.innerRadius + arc.outerRadius) / 2}
							{@const lx = cx + midR * Math.cos(midAngle)}
							{@const ly = cy + midR * Math.sin(midAngle)}
							<text
								x={lx}
								y={ly}
								text-anchor="middle"
								dominant-baseline="central"
								class="pointer-events-none fill-(--ink) text-[9px] font-medium"
								style="text-shadow: 0 1px 2px rgba(0,0,0,0.4)"
							>
								{arc.module.name.length > 12 ? arc.module.name.slice(0, 10) + '…' : arc.module.name}
							</text>
						{/if}
					</a>
				{/if}
			{/each}

			<!-- Center label -->
			<text
				x={cx}
				y={cy - 8}
				text-anchor="middle"
				dominant-baseline="auto"
				class="fill-(--ink) text-[13px] font-semibold"
			>
				{centerLabel}
			</text>
			<text
				x={cx}
				y={cy + 10}
				text-anchor="middle"
				dominant-baseline="auto"
				class="fill-(--muted) text-[11px]"
			>
				{centerCount.toLocaleString()} items
			</text>
		</svg>
	</div>

	<!-- Always-rendered hover bar (no layout shift) -->
	<div class="truncate border-t border-(--panel-border) bg-(--panel) px-4 py-2 text-xs">
		{#if hoveredArcModule}
			<span class="font-medium text-(--ink)">{hoveredArcModule.id}</span>
			<span class="text-(--muted)">
				· {hoveredArcModule.totalNodeCount.toLocaleString()} items · {hoveredArcModule.childModuleCount}
				submodules
			</span>
		{:else}
			<span class="text-(--muted)">Hover a segment to see details</span>
		{/if}
	</div>
</div>
