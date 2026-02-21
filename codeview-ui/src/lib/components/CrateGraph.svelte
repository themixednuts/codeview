<script lang="ts">
	import { resolve } from '$app/paths';
	import type { CrateMapData, CrateMapModuleNode, CrateMapModuleEdge } from '$lib/graph/crate-map';
	import { findContainingModule, computeForceDirectedLayout, moduleDepthColor, type CrateGraphNodePos } from '$lib/graph/crate-map';
	import { PanZoom } from '$lib/graph/pan-zoom.svelte';
	import { KeyedMemo, keyOf, keyEqual } from '$lib/reactivity.svelte';

	export type GraphRenderMode = 'normal' | 'dots';

	let { data, selectedNodeId = null, getNodeUrl, renderMode = 'normal', onRenderModeChange } = $props<{
		data: CrateMapData;
		selectedNodeId?: string | null;
		getNodeUrl: (id: string) => string;
		renderMode?: GraphRenderMode;
		onRenderModeChange?: (mode: GraphRenderMode) => void;
	}>();

	type EdgeLine = {
		edge: CrateMapModuleEdge;
		x1: number;
		y1: number;
		x2: number;
		y2: number;
		thickness: number;
	};

	const WIDTH = 800;
	const HEIGHT = 600;
	const NODE_RADIUS = 24;
	const DOT_RADIUS = 6;

	let hoveredModuleId = $state<string | null>(null);
	let svgEl = $state<SVGSVGElement | null>(null);

	const pz = new PanZoom({ minZoom: 0.3, maxZoom: 3 });

	const highlightedModuleId = $derived(
		selectedNodeId ? findContainingModule(selectedNodeId, data.moduleNodes) : null,
	);

	// O(1) lookup for hover and highlight — covers all module nodes, not just graph subset
	const moduleById = $derived.by<Map<string, CrateMapModuleNode>>(() => {
		return new Map(data.moduleNodes.map((m: CrateMapModuleNode) => [m.id, m]));
	});

	// Use matrixModuleIds for graph (capped at ~24 modules for readability)
	const graphModules = $derived.by(() => {
		const ids = new Set(data.matrixModuleIds);
		return data.moduleNodes.filter((m: CrateMapModuleNode) => ids.has(m.id));
	});

	// Force-directed layout, wrapped in KeyedMemo to skip recomputation on SWR revalidation.
	// The key captures the inputs that affect layout; when SWR delivers identical data the
	// key matches and the expensive O(n²·80) simulation is skipped entirely.
	const layoutMemo = new KeyedMemo(
		() => keyOf(data.matrixModuleIds, data.moduleEdges.length, renderMode),
		() => {
			const r = renderMode === 'normal' ? NODE_RADIUS : DOT_RADIUS;
			return computeForceDirectedLayout(graphModules, data.moduleEdges, WIDTH, HEIGHT, r);
		},
		{ equalsKey: keyEqual },
	);
	const nodePositions: Map<string, CrateGraphNodePos> = $derived(layoutMemo.current);

	// Build edge lines with thickness proportional to coupling strength
	const edgeLines = $derived.by<EdgeLine[]>(() => {
		const lines: EdgeLine[] = [];
		const posMap = nodePositions;
		const maxTotal = data.moduleEdges.reduce((max: number, e: CrateMapModuleEdge) => Math.max(max, e.total), 1);

		for (const edge of data.moduleEdges) {
			const from = posMap.get(edge.from);
			const to = posMap.get(edge.to);
			if (!from || !to) continue;
			if (edge.from === edge.to) continue; // skip self-loops

			const t = Math.log1p(edge.total) / Math.log1p(maxTotal);
			const thickness = 1 + t * 4;
			lines.push({
				edge,
				x1: from.x,
				y1: from.y,
				x2: to.x,
				y2: to.y,
				thickness,
			});
		}

		return lines;
	});

	function isNodeHighlighted(m: CrateMapModuleNode): boolean {
		return highlightedModuleId === m.id;
	}

	function nodeOpacity(m: CrateMapModuleNode): number {
		if (hoveredModuleId === m.id) return 1;
		if (hoveredModuleId) {
			// Check if this module has an edge to/from hovered
			const connected = data.moduleEdges.some(
				(e: CrateMapModuleEdge) =>
					(e.from === hoveredModuleId && e.to === m.id) ||
					(e.to === hoveredModuleId && e.from === m.id),
			);
			return connected ? 0.9 : 0.25;
		}
		return 0.8;
	}

	function edgeOpacity(edge: CrateMapModuleEdge): number {
		if (!hoveredModuleId) return 0.35;
		if (edge.from === hoveredModuleId || edge.to === hoveredModuleId) return 0.8;
		return 0.08;
	}

	const depthColor = moduleDepthColor;

	function moduleLabel(m: CrateMapModuleNode, max = 14): string {
		const name = m.name;
		return name.length > max ? name.slice(0, max - 1) + '…' : name;
	}

	function setMode(mode: GraphRenderMode) {
		if (onRenderModeChange) {
			onRenderModeChange(mode);
		}
	}

	const hoveredModule = $derived(
		hoveredModuleId ? moduleById.get(hoveredModuleId) ?? null : null,
	);
</script>

<div
	class="corner-squircle overflow-hidden rounded-(--radius-card) border border-(--panel-border) bg-(--panel-solid)"
>
	<div
		class="flex flex-wrap items-center justify-between gap-3 border-b border-(--panel-border) bg-(--panel) px-4 py-2"
	>
		<div>
			<p class="text-sm font-medium text-(--ink)">Module Graph</p>
			<p class="text-xs text-(--muted)">
				{graphModules.length} modules · {data.moduleEdges.length} coupling edges
			</p>
		</div>
		<div class="flex items-center gap-2">
			<button
				type="button"
				class="badge badge-sm {renderMode === 'normal' ? 'badge-accent' : ''}"
				onclick={() => setMode('normal')}
			>
				Cards
			</button>
			<button
				type="button"
				class="badge badge-sm {renderMode === 'dots' ? 'badge-accent' : ''}"
				onclick={() => setMode('dots')}
			>
				Dots
			</button>
			<button
				type="button"
				class="badge badge-sm"
				onclick={() => pz.reset()}
			>
				Reset
			</button>
		</div>
	</div>

	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="relative overflow-hidden"
		style="height: 500px"
		onwheel={(e) => pz.handleWheel(e)}
		onmousedown={(e) => pz.handleMouseDown(e)}
		onmousemove={(e) => pz.handleMouseMove(e)}
		onmouseup={() => pz.handleMouseUp()}
		onmouseleave={() => pz.handleMouseUp()}
	>
		<svg
			bind:this={svgEl}
			viewBox="0 0 {WIDTH} {HEIGHT}"
			class="h-full w-full"
			preserveAspectRatio="xMidYMid meet"
			aria-label="Module dependency graph"
			style="cursor: {pz.isPanning ? 'grabbing' : 'grab'}"
		>
			<g transform={pz.transform}>
				<!-- Edges -->
				{#each edgeLines as line (line.edge.from + '|' + line.edge.to)}
					<line
						x1={line.x1}
						y1={line.y1}
						x2={line.x2}
						y2={line.y2}
						stroke="var(--edge-uses)"
						stroke-width={line.thickness}
						stroke-opacity={edgeOpacity(line.edge)}
						stroke-linecap="round"
					/>
				{/each}

				<!-- Nodes -->
				{#each graphModules as m (m.id)}
					{@const pos = nodePositions.get(m.id)}
					{#if pos}
						<a
							href={resolve(getNodeUrl(m.id) as `/${string}`)}
							data-sveltekit-noscroll
							onmouseenter={() => { hoveredModuleId = m.id; }}
							onmouseleave={() => { hoveredModuleId = null; }}
						>
							{#if renderMode === 'dots'}
								<circle
									cx={pos.x}
									cy={pos.y}
									r={pos.r}
									fill={depthColor(m.depth)}
									fill-opacity={nodeOpacity(m)}
									stroke={isNodeHighlighted(m) ? 'var(--accent)' : 'var(--panel-border)'}
									stroke-width={isNodeHighlighted(m) ? 2 : 1}
								/>
								{#if hoveredModuleId === m.id}
									<text
										x={pos.x}
										y={pos.y - pos.r - 6}
										text-anchor="middle"
										class="fill-(--ink) text-[10px] font-medium"
									>
										{m.name}
									</text>
								{/if}
							{:else}
								<!-- Card mode: rounded rect with label -->
								<rect
									x={pos.x - 56}
									y={pos.y - 16}
									width={112}
									height={32}
									rx="6"
									fill="var(--panel-solid)"
									fill-opacity={nodeOpacity(m)}
									stroke={isNodeHighlighted(m) ? 'var(--accent)' : depthColor(m.depth)}
									stroke-width={isNodeHighlighted(m) ? 2.5 : 1.5}
								/>
								<!-- Color dot -->
								<circle
									cx={pos.x - 42}
									cy={pos.y}
									r="4"
									fill={depthColor(m.depth)}
								/>
								<text
									x={pos.x - 34}
									y={pos.y}
									text-anchor="start"
									dominant-baseline="central"
									class="fill-(--ink) text-[10px] font-medium"
								>
									{moduleLabel(m)}
								</text>
								<text
									x={pos.x + 52}
									y={pos.y}
									text-anchor="end"
									dominant-baseline="central"
									class="fill-(--muted) text-[8px] tabular-nums"
								>
									{m.totalNodeCount}
								</text>
							{/if}
						</a>
					{/if}
				{/each}
			</g>
		</svg>
	</div>

	<!-- Always-rendered hover bar (no layout shift) -->
	<div class="truncate border-t border-(--panel-border) bg-(--panel) px-4 py-2 text-xs">
		{#if hoveredModule}
			<span class="font-medium text-(--ink)">{hoveredModule.id}</span>
			<span class="text-(--muted)">
				· {hoveredModule.totalNodeCount.toLocaleString()} items
				· {hoveredModule.childModuleCount} submodules
			</span>
		{:else}
			<span class="text-(--muted)">Hover a module to see details</span>
		{/if}
	</div>
</div>
