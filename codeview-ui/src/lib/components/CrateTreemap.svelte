<script lang="ts">
	import { resolve } from '$app/paths';
	import type { CrateMapData, CrateMapModuleNode } from '$lib/graph/crate-map';
	import {
		computeSquarifiedLayout,
		findContainingModule,
		moduleDepthColor,
		type TreemapRect,
		type LayoutRect,
	} from '$lib/graph/crate-map';

	let { data, selectedNodeId = null, getNodeUrl, drillId = null, onDrillChange } = $props<{
		data: CrateMapData;
		selectedNodeId?: string | null;
		getNodeUrl: (id: string) => string;
		drillId?: string | null;
		onDrillChange?: (id: string | null) => void;
	}>();

	const VIEW_WIDTH = 960;
	const VIEW_HEIGHT = 540;
	const MIN_LABEL_WIDTH = 48;
	const MIN_LABEL_HEIGHT = 18;

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

	// Reconstruct breadcrumb chain by walking parentId from drillId upward
	const drillPath = $derived.by<CrateMapModuleNode[]>(() => {
		if (!drillId) return [];
		const mod = moduleById.get(drillId);
		if (!mod) return [];
		const chain: CrateMapModuleNode[] = [];
		let cursor: CrateMapModuleNode | undefined = mod;
		const seen = new Set<string>();
		while (cursor && cursor.parentId !== null) {
			if (seen.has(cursor.id)) break;
			seen.add(cursor.id);
			chain.unshift(cursor);
			cursor = moduleById.get(cursor.parentId);
		}
		return chain;
	});

	const drillRoot = $derived<CrateMapModuleNode | null>(
		drillId ? moduleById.get(drillId) ?? null : null,
	);

	const visibleModules = $derived.by(() => {
		if (!drillRoot) return data.moduleNodes;
		// Collect all descendants of the drill root
		const result: CrateMapModuleNode[] = [drillRoot];
		const collect = (parentId: string) => {
			const children = childrenByParent.get(parentId);
			if (!children) return;
			for (const child of children) {
				result.push(child);
				collect(child.id);
			}
		};
		collect(drillRoot.id);
		// Reparent root to null for layout
		return result.map((m) =>
			m.id === drillRoot.id ? { ...m, parentId: null } : m,
		);
	});

	const rects = $derived.by<TreemapRect[]>(() => {
		const bounds: LayoutRect = { x: 0, y: 0, w: VIEW_WIDTH, h: VIEW_HEIGHT };
		return computeSquarifiedLayout(visibleModules, bounds);
	});

	function moduleLabel(m: CrateMapModuleNode): string {
		if (m.depth <= 1) return m.name;
		const parts = m.id.split('::');
		return parts.length >= 2
			? `${parts[parts.length - 2]}::${parts[parts.length - 1]}`
			: m.name;
	}

	const depthColor = moduleDepthColor;

	function rectOpacity(rect: TreemapRect): number {
		if (hoveredModuleId === rect.module.id) return 0.85;
		if (hoveredModuleId) return 0.35;
		if (highlightedModuleId === rect.module.id) return 0.8;
		return 0.55;
	}

	function isHighlighted(rect: TreemapRect): boolean {
		return highlightedModuleId === rect.module.id;
	}

	function drillInto(m: CrateMapModuleNode) {
		const children = childrenByParent.get(m.id);
		if (children && children.length > 0) {
			onDrillChange?.(m.id);
		}
	}

	function drillTo(index: number) {
		if (index === 0) {
			onDrillChange?.(null);
		} else {
			onDrillChange?.(drillPath[index - 1]?.id ?? null);
		}
	}

	function handleClick(e: MouseEvent, rect: TreemapRect) {
		const children = childrenByParent.get(rect.module.id);
		if (children && children.length > 0) {
			e.preventDefault();
			drillInto(rect.module);
		}
		// else: let the <a> navigate
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
			<p class="text-sm font-medium text-(--ink)">Module Treemap</p>
			<p class="text-xs text-(--muted)">
				{data.totalNodeCount.toLocaleString()} items across {data.moduleNodes.length} modules
				{#if data.truncatedHierarchy}
					<span class="text-(--muted)">· +{data.hiddenHierarchyModules} hidden</span>
				{/if}
			</p>
		</div>

		{#if drillPath.length > 0}
			<nav class="flex items-center gap-1 text-xs" aria-label="Treemap breadcrumb">
				<button
					type="button"
					class="text-(--accent) hover:underline"
					onclick={() => drillTo(0)}
				>
					Root
				</button>
				{#each drillPath as crumb, i (crumb.id)}
					<span class="text-(--muted)">/</span>
					{#if i < drillPath.length - 1}
						<button
							type="button"
							class="text-(--accent) hover:underline"
							onclick={() => drillTo(i + 1)}
						>
							{crumb.name}
						</button>
					{:else}
						<span class="font-medium text-(--ink)">{crumb.name}</span>
					{/if}
				{/each}
			</nav>
		{/if}
	</div>

	<div class="overflow-x-auto p-3">
		<svg
			viewBox="0 0 {VIEW_WIDTH} {VIEW_HEIGHT}"
			class="h-auto w-full min-h-[300px]"
			preserveAspectRatio="xMidYMid meet"
			aria-label="Module treemap"
		>
			{#each rects as rect (rect.module.id)}
				{@const showLabel = rect.width > MIN_LABEL_WIDTH && rect.height > MIN_LABEL_HEIGHT}
				{@const label = moduleLabel(rect.module)}
				{@const maxChars = Math.max(3, Math.floor(rect.width / 8))}
				{@const displayLabel = label.length > maxChars ? label.slice(0, maxChars - 2) + '…' : label}
				<a
					href={resolve(getNodeUrl(rect.module.id) as `/${string}`)}
					data-sveltekit-noscroll
					onclick={(e) => handleClick(e, rect)}
					onmouseenter={() => { hoveredModuleId = rect.module.id; }}
					onmouseleave={() => { hoveredModuleId = null; }}
				>
					<rect
						x={rect.x + 0.5}
						y={rect.y + 0.5}
						width={Math.max(0, rect.width - 1)}
						height={Math.max(0, rect.height - 1)}
						rx="3"
						fill={depthColor(rect.depth)}
						fill-opacity={rectOpacity(rect)}
						stroke={isHighlighted(rect) ? 'var(--accent)' : 'var(--panel-border)'}
						stroke-width={isHighlighted(rect) ? 2.5 : 0.5}
					/>
					{#if showLabel}
						<text
							x={rect.x + 6}
							y={rect.y + 14}
							text-anchor="start"
							dominant-baseline="auto"
							class="pointer-events-none fill-(--ink) text-[10px] font-medium"
							style="text-shadow: 0 1px 2px rgba(0,0,0,0.3)"
						>
							{displayLabel}
						</text>
						{#if rect.height > 30 && rect.width > 40}
							<text
								x={rect.x + 6}
								y={rect.y + 26}
								text-anchor="start"
								dominant-baseline="auto"
								class="pointer-events-none fill-(--muted) text-[9px]"
							>
								{rect.module.totalNodeCount.toLocaleString()}
							</text>
						{/if}
					{/if}
				</a>
			{/each}
		</svg>
	</div>

	<!-- Always-rendered hover bar (no layout shift) -->
	<div class="truncate border-t border-(--panel-border) bg-(--panel) px-4 py-2 text-xs">
		{#if hoveredModule}
			<span class="font-medium text-(--ink)">{hoveredModule.id}</span>
			<span class="text-(--muted)">
				· {hoveredModule.totalNodeCount.toLocaleString()} items
				· {hoveredModule.childModuleCount} submodules
				· depth {hoveredModule.depth}
			</span>
		{:else}
			<span class="text-(--muted)">Hover a module to see details</span>
		{/if}
	</div>
</div>
