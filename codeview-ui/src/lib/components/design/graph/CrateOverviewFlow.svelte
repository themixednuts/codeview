<script lang="ts">
	import { SvelteFlow } from '@xyflow/svelte';
	import type { Edge as FlowEdge, Node as FlowNode } from '@xyflow/svelte';
	import { onMount } from 'svelte';
	import type {
		CrateMapData,
		CrateMapModuleEdge,
		CrateMapModuleNode,
		CrateMapSemanticKind,
	} from '$lib/graph/crate-map';
	import { findContainingModule, moduleDepthColor } from '$lib/graph/crate-map';
	import { resolveAppPath } from '$lib/app-paths';
	import { edgeKindToRelation, REL, REL_ORDER, type DesignRelation } from '$lib/design/live-node';
	import CrateModuleNode from './CrateModuleNode.svelte';
	import { DISABLED_FLOW_SHORTCUTS } from './flow-shortcuts';

	type ModuleStats = {
		incoming: number;
		outgoing: number;
		topKinds: Array<[CrateMapSemanticKind, number]>;
	};

	type PositionedModule = {
		module: CrateMapModuleNode;
		x: number;
		y: number;
	};

	type CrateOverviewLayout = {
		width: number;
		height: number;
		modules: PositionedModule[];
	};

	type CrateModuleFlowData = {
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

	type CrateModuleFlowNode = FlowNode<CrateModuleFlowData, 'crateModule'>;
	type CrateFlowEdgeData = {
		label: string;
		count: number;
		relation?: DesignRelation;
	};
	type CrateFlowEdge = FlowEdge<CrateFlowEdgeData, 'smoothstep'>;

	const MAX_FLOW_MODULES = 96;
	const MAX_FLOW_SEMANTIC_EDGES = 180;

	let {
		data,
		selectedNodeId = null,
		getNodeUrl,
		height = 560,
	} = $props<{
		data: CrateMapData;
		selectedNodeId?: string | null;
		getNodeUrl: (id: string) => string;
		height?: number;
	}>();

	const nodeTypes = { crateModule: CrateModuleNode };
	let hoveredModuleId = $state<string | null>(null);
	let containerWidth = $state(960);
	let flowReady = $state(false);

	onMount(() => {
		let firstFrame = 0;
		let secondFrame = 0;
		firstFrame = requestAnimationFrame(() => {
			secondFrame = requestAnimationFrame(() => {
				flowReady = true;
			});
		});
		return () => {
			cancelAnimationFrame(firstFrame);
			cancelAnimationFrame(secondFrame);
		};
	});

	const highlightedModuleId = $derived(
		selectedNodeId ? findContainingModule(selectedNodeId, data.moduleNodes) : data.crateId,
	);
	const cappedModuleNodes = $derived.by<CrateMapModuleNode[]>(() =>
		selectModuleNodes(data.moduleNodes, highlightedModuleId, data.crateId, MAX_FLOW_MODULES),
	);
	const cappedModuleIds = $derived.by(() => new Set(cappedModuleNodes.map((module) => module.id)));
	const cappedSemanticEdges = $derived.by<CrateMapModuleEdge[]>(() =>
		data.moduleEdges
			.filter(
				(edge: CrateMapModuleEdge) =>
					edge.from !== edge.to && cappedModuleIds.has(edge.from) && cappedModuleIds.has(edge.to),
			)
			.sort((a: CrateMapModuleEdge, b: CrateMapModuleEdge) => b.total - a.total)
			.slice(0, MAX_FLOW_SEMANTIC_EDGES),
	);
	const isCapped = $derived(
		cappedModuleNodes.length < data.moduleNodes.length ||
			cappedSemanticEdges.length < data.visibleSemanticEdgeCount,
	);
	const moduleById = $derived.by<Map<string, CrateMapModuleNode>>(() =>
		new Map(cappedModuleNodes.map((module: CrateMapModuleNode) => [module.id, module])),
	);
	const maxNodeCount = $derived.by(() =>
		cappedModuleNodes.reduce(
			(max: number, module: CrateMapModuleNode) => Math.max(max, module.totalNodeCount),
			1,
		),
	);
	const statsByModule = $derived.by(() => buildModuleStats(cappedSemanticEdges));
	const connectedIds = $derived.by(() => {
		const ids = new Set<string>();
		if (!hoveredModuleId) return ids;
		ids.add(hoveredModuleId);
		for (const edge of cappedSemanticEdges) {
			if (edge.from === hoveredModuleId) ids.add(edge.to);
			if (edge.to === hoveredModuleId) ids.add(edge.from);
		}
		for (const module of cappedModuleNodes) {
			if (module.parentId === hoveredModuleId) ids.add(module.id);
			if (module.id === hoveredModuleId && module.parentId) ids.add(module.parentId);
		}
		return ids;
	});
	const layout = $derived(layoutModules(cappedModuleNodes, containerWidth, height));
	let flowNodes = $state.raw<CrateModuleFlowNode[]>([]);
	let flowEdges = $state.raw<CrateFlowEdge[]>([]);

	$effect(() => {
		flowNodes = layout.modules.map(({ module, x, y }) => {
			const stats: ModuleStats = statsByModule.get(module.id) ?? {
				incoming: 0,
				outgoing: 0,
				topKinds: [] as Array<[CrateMapSemanticKind, number]>,
			};
			const active = hoveredModuleId === module.id;
			const dim = hoveredModuleId != null && !connectedIds.has(module.id);
			return {
				id: module.id,
				type: 'crateModule',
				position: { x, y },
				draggable: true,
				selectable: false,
				connectable: false,
				focusable: false,
				ariaRole: 'presentation',
				data: {
					module: {
						...module,
						totalNodeCount: module.totalNodeCount,
					},
					href: resolveAppPath(getNodeUrl(module.id)),
					color: moduleDepthColor(module.depth),
					selected: highlightedModuleId === module.id,
					dim,
					active,
					incoming: stats.incoming,
					outgoing: stats.outgoing,
					topKinds: stats.topKinds,
					sizePercent: Math.max(8, Math.round((module.totalNodeCount / maxNodeCount) * 100)),
				},
			};
		});
		flowEdges = [
			...buildHierarchyEdges(cappedModuleNodes, moduleById, hoveredModuleId, connectedIds),
			...buildSemanticEdges(cappedSemanticEdges, hoveredModuleId, connectedIds),
		];
	});
	const activeRelations = $derived.by(() => {
		const relations = new Set<DesignRelation>();
		for (const edge of cappedSemanticEdges) {
			const kind = dominantKind(edge);
			if (kind) relations.add(edgeKindToRelation(kind).token);
		}
		return REL_ORDER.filter((relation) => relations.has(relation));
	});
	const hoveredModule = $derived.by<CrateMapModuleNode | null>(() =>
		hoveredModuleId ? (moduleById.get(hoveredModuleId) ?? null) : null,
	);

	function selectModuleNodes(
		modules: CrateMapModuleNode[],
		highlightedId: string | null,
		crateId: string,
		limit: number,
	): CrateMapModuleNode[] {
		if (modules.length <= limit) return modules;
		const byId = new Map(modules.map((module) => [module.id, module]));
		const selected = new Set<string>();

		function includeWithParents(id: string | null | undefined) {
			let cursor = id ? byId.get(id) : null;
			while (cursor && !selected.has(cursor.id)) {
				selected.add(cursor.id);
				cursor = cursor.parentId ? (byId.get(cursor.parentId) ?? null) : null;
			}
		}

		includeWithParents(crateId);
		includeWithParents(highlightedId);

		for (const module of modules
			.filter((module) => !selected.has(module.id))
			.sort(
				(a, b) =>
					b.totalNodeCount - a.totalNodeCount ||
					a.depth - b.depth ||
					a.name.localeCompare(b.name),
			)) {
			if (selected.size >= limit) break;
			selected.add(module.id);
		}

		return hierarchyOrder(modules.filter((module) => selected.has(module.id)));
	}

	function buildModuleStats(edges: CrateMapModuleEdge[]): Map<string, ModuleStats> {
		const stats = new Map<string, ModuleStats>();
		const kindTotals = new Map<string, Map<CrateMapSemanticKind, number>>();
		function ensure(id: string): ModuleStats {
			const existing = stats.get(id);
			if (existing) return existing;
			const next = { incoming: 0, outgoing: 0, topKinds: [] };
			stats.set(id, next);
			return next;
		}
		function addKind(id: string, kind: CrateMapSemanticKind, count: number) {
			const totals = kindTotals.get(id) ?? new Map<CrateMapSemanticKind, number>();
			totals.set(kind, (totals.get(kind) ?? 0) + count);
			kindTotals.set(id, totals);
		}

		for (const edge of edges) {
			ensure(edge.from).outgoing += edge.total;
			ensure(edge.to).incoming += edge.total;
			for (const [kind, count] of Object.entries(edge.kindCounts) as [
				CrateMapSemanticKind,
				number,
			][]) {
				if (count <= 0) continue;
				addKind(edge.from, kind, count);
				addKind(edge.to, kind, count);
			}
		}

		for (const [id, totals] of kindTotals) {
			const entry = ensure(id);
			entry.topKinds = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]);
		}
		return stats;
	}

	function layoutModules(
		modules: CrateMapModuleNode[],
		minWidth: number,
		minHeight: number,
	): CrateOverviewLayout {
		if (modules.length === 0) return { width: Math.max(720, minWidth), height: minHeight, modules: [] };

		const ordered = hierarchyOrder(modules);
		const byDepth = new Map<number, CrateMapModuleNode[]>();
		for (const module of ordered) {
			const list = byDepth.get(module.depth) ?? [];
			list.push(module);
			byDepth.set(module.depth, list);
		}

		const depthCount = Math.max(...Array.from(byDepth.keys())) + 1;
		const rowCount = Math.max(...Array.from(byDepth.values()).map((list) => list.length));
		const nodeWidth = 220;
		const nodeHeight = 112;
		const colGap = 82;
		const rowGap = 34;
		const padX = 36;
		const padY = 36;
		const colStep = nodeWidth + colGap;
		const rowStep = nodeHeight + rowGap;
		const width = Math.max(minWidth, padX * 2 + depthCount * nodeWidth + (depthCount - 1) * colGap);
		const contentHeight = padY * 2 + rowCount * nodeHeight + Math.max(0, rowCount - 1) * rowGap;
		const graphHeight = Math.max(minHeight, contentHeight);
		const positioned: PositionedModule[] = [];

		for (const [depth, depthModules] of byDepth) {
			const columnHeight =
				depthModules.length * nodeHeight + Math.max(0, depthModules.length - 1) * rowGap;
			const offsetY = Math.max(padY, (graphHeight - columnHeight) / 2);
			for (let index = 0; index < depthModules.length; index += 1) {
				positioned.push({
					module: depthModules[index],
					x: padX + depth * colStep,
					y: offsetY + index * rowStep,
				});
			}
		}

		return { width, height: graphHeight, modules: positioned };
	}

	function hierarchyOrder(modules: CrateMapModuleNode[]): CrateMapModuleNode[] {
		const childrenByParent = new Map<string | null, CrateMapModuleNode[]>();
		for (const module of modules) {
			const list = childrenByParent.get(module.parentId) ?? [];
			list.push(module);
			childrenByParent.set(module.parentId, list);
		}
		for (const list of childrenByParent.values()) {
			list.sort((a, b) => b.totalNodeCount - a.totalNodeCount || a.name.localeCompare(b.name));
		}

		const result: CrateMapModuleNode[] = [];
		const seen = new Set<string>();
		function visit(module: CrateMapModuleNode) {
			if (seen.has(module.id)) return;
			seen.add(module.id);
			result.push(module);
			for (const child of childrenByParent.get(module.id) ?? []) visit(child);
		}

		for (const root of childrenByParent.get(null) ?? []) visit(root);
		for (const module of modules) visit(module);
		return result;
	}

	function buildHierarchyEdges(
		modules: CrateMapModuleNode[],
		lookup: Map<string, CrateMapModuleNode>,
		hoveredId: string | null,
		currentConnectedIds: Set<string>,
	): CrateFlowEdge[] {
		return modules
			.filter((module) => module.parentId && lookup.has(module.parentId))
			.map((module) => {
				const active = hoveredId != null && (hoveredId === module.id || hoveredId === module.parentId);
				const dim = hoveredId != null && !currentConnectedIds.has(module.id);
				return {
					id: `hierarchy:${module.parentId}->${module.id}`,
					source: module.parentId!,
					target: module.id,
					type: 'smoothstep',
					selectable: false,
					focusable: false,
					data: { label: 'contains', count: 1, relation: 'contains' },
					style: `stroke: var(--edge-contains); stroke-width: ${active ? 2.25 : 1.35}; opacity: ${dim ? 0.08 : active ? 0.72 : 0.28}`,
					zIndex: active ? 2 : 0,
				};
			});
	}

	function buildSemanticEdges(
		edges: CrateMapModuleEdge[],
		hoveredId: string | null,
		currentConnectedIds: Set<string>,
	): CrateFlowEdge[] {
		const maxTotal = edges.reduce((max, edge) => Math.max(max, edge.total), 1);
		return edges
			.filter((edge) => edge.from !== edge.to)
			.map((edge) => {
				const kind = dominantKind(edge);
				const relation = kind ? edgeKindToRelation(kind) : null;
				const active = hoveredId != null && (hoveredId === edge.from || hoveredId === edge.to);
				const dim =
					hoveredId != null && (!currentConnectedIds.has(edge.from) || !currentConnectedIds.has(edge.to));
				const weight = Math.log1p(edge.total) / Math.log1p(maxTotal);
				return {
					id: `semantic:${edge.from}->${edge.to}`,
					source: edge.from,
					target: edge.to,
					type: 'smoothstep',
					selectable: false,
					focusable: false,
					data: {
						label: relation?.label ?? 'Semantic edge',
						count: edge.total,
						relation: relation?.token,
					},
					style: `stroke: ${relation?.color ?? 'var(--edge-uses)'}; stroke-width: ${active ? 2.5 + weight * 2.5 : 1.4 + weight * 2.6}; opacity: ${dim ? 0.08 : active ? 0.82 : 0.32}`,
					zIndex: active ? 3 : 1,
				};
			});
	}

	function dominantKind(edge: CrateMapModuleEdge): CrateMapSemanticKind | null {
		let best: CrateMapSemanticKind | null = null;
		let bestCount = 0;
		for (const [kind, count] of Object.entries(edge.kindCounts) as [
			CrateMapSemanticKind,
			number,
		][]) {
			if (count > bestCount) {
				best = kind;
				bestCount = count;
			}
		}
		return best;
	}

	function handleNodeEnter({ node }: { node: CrateModuleFlowNode; event: PointerEvent }) {
		hoveredModuleId = node.id;
	}

	function clearHover() {
		hoveredModuleId = null;
	}
</script>

<section
	class="crate-overview-flow overflow-hidden rounded-lg border border-(--panel-border) bg-(--panel-solid)"
	aria-label="Crate module overview"
>
	<header
		class="flex flex-wrap items-center justify-between gap-3 border-b border-(--panel-border) bg-(--panel) px-4 py-3"
	>
		<div>
			<h2 class="font-display text-md font-semibold text-(--ink)">Module graph</h2>
			<p class="mt-0.5 text-xs text-(--muted)">
				showing {cappedModuleNodes.length.toLocaleString()} of {data.moduleNodes.length.toLocaleString()}
				modules · {cappedSemanticEdges.length.toLocaleString()} of {data.visibleSemanticEdgeCount.toLocaleString()}
				semantic edges
			</p>
		</div>
		{#if isCapped || data.truncatedHierarchy || data.truncatedMatrix}
			<div class="badge badge-sm border-(--accent-ring) bg-(--accent-soft) text-(--accent-strong)">
				{#if isCapped}
					render capped
				{:else if data.truncatedHierarchy}
					{data.hiddenHierarchyModules.toLocaleString()} hidden modules
				{:else}
					semantic edges capped
				{/if}
			</div>
		{/if}
	</header>

	{#if data.moduleNodes.length === 0}
		<div class="flex min-h-[280px] items-center justify-center p-8 text-sm text-(--muted)">
			No module graph is available for this crate.
		</div>
	{:else}
		<div
			class="crate-overview-flow__viewport overflow-hidden"
			style={`height: ${height}px`}
			bind:clientWidth={containerWidth}
		>
			<div class="relative" style={`width: ${layout.width}px; height: ${layout.height}px`}>
				<div class="absolute inset-0 crate-overview-flow__dots" aria-hidden="true"></div>
				{#if flowReady}
					<SvelteFlow
						nodes={flowNodes}
						edges={flowEdges}
						{nodeTypes}
						width={containerWidth}
						height={height}
						nodesDraggable={true}
						nodesConnectable={false}
						elementsSelectable={false}
						nodesFocusable={false}
						edgesFocusable={false}
						autoPanOnNodeFocus={true}
						fitView={true}
						fitViewOptions={{ padding: 0.12, minZoom: 0.28, maxZoom: 1 }}
						panOnDrag={true}
						panOnScroll={false}
						zoomOnScroll={true}
						zoomOnDoubleClick={true}
						zoomOnPinch={true}
						preventScrolling={true}
						deleteKey={DISABLED_FLOW_SHORTCUTS}
						selectionKey={DISABLED_FLOW_SHORTCUTS}
						multiSelectionKey={DISABLED_FLOW_SHORTCUTS}
						panActivationKey={DISABLED_FLOW_SHORTCUTS}
						zoomActivationKey={DISABLED_FLOW_SHORTCUTS}
						onlyRenderVisibleElements={true}
						minZoom={0.28}
						maxZoom={2}
						onnodepointerenter={handleNodeEnter}
						onnodepointerleave={clearHover}
						onpaneclick={clearHover}
					/>
				{:else}
					<div class="absolute inset-0 flex items-center justify-center text-sm text-(--muted)">
						Preparing module graph...
					</div>
				{/if}
			</div>
		</div>
	{/if}

	<footer
		class="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-(--panel-border) bg-(--panel) px-4 py-2 text-xs"
	>
		{#if hoveredModule}
			<span class="mono min-w-0 truncate font-semibold text-(--ink)" title={hoveredModule.id}>
				{hoveredModule.id}
			</span>
			<span class="text-(--muted)">
				{hoveredModule.totalNodeCount.toLocaleString()} items · {hoveredModule.childModuleCount}
				child modules
			</span>
		{:else}
			<span class="text-(--muted)">Module hierarchy and semantic coupling</span>
		{/if}
		{#if activeRelations.length > 0}
			<div class="ml-auto flex flex-wrap items-center gap-2">
				{#each activeRelations as relation (relation)}
					<span class="mono inline-flex items-center gap-1 text-xs text-(--muted)">
						<span class="inline-block h-[3px] w-3 rounded" style={`background: ${REL[relation].color}`}></span>
						{REL[relation].label}
					</span>
				{/each}
			</div>
		{/if}
	</footer>
</section>

<style>
	.crate-overview-flow__viewport {
		background: var(--bg);
	}

	.crate-overview-flow__dots {
		background-image: radial-gradient(var(--panel-border-soft) 1px, transparent 1px);
		background-size: 26px 26px;
	}

	.crate-overview-flow :global(.svelte-flow) {
		--xy-background-color: transparent;
		--xy-edge-stroke: var(--panel-border);
		--xy-selection-background-color: transparent;
		--xy-selection-border: 0;
	}

	.crate-overview-flow :global(.svelte-flow__node) {
		background: transparent;
		border: 0;
		box-shadow: none;
	}

	.crate-overview-flow :global(.svelte-flow__node:focus),
	.crate-overview-flow :global(.svelte-flow__node:focus-visible) {
		outline: none;
	}

	.crate-overview-flow :global(.svelte-flow__edge-path) {
		transition:
			stroke-width 0.12s ease,
			opacity 0.12s ease;
	}

	.crate-overview-flow :global(.svelte-flow__attribution) {
		display: none;
	}
</style>
