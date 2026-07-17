<script lang="ts">
	import { SvelteFlow } from '@xyflow/svelte';
	import { onMount } from 'svelte';
	import type { Edge, Node, NodeDetail, NodeSummary } from '$lib/schema';
	import { resolveAppPath } from '$lib/app-paths';
	import {
		edgeKindToRelation,
		REL,
		REL_ORDER,
		toDesignNode,
		type DesignRelation,
	} from '$lib/design/live-node';
	import KindBadge from '$lib/components/design/KindBadge.svelte';
	import Icon from '$lib/components/design/Icon.svelte';
	import GraphNodePillFlow from './GraphNodePillFlow.svelte';
	import RelationshipLabelFlow from './RelationshipLabelFlow.svelte';
	import RelationshipEdge from './RelationshipEdge.svelte';
	import { DISABLED_FLOW_SHORTCUTS } from './flow-shortcuts';
	import type {
		FocusGraphFlowNode,
		GraphNodePillFlowData,
		GraphNodePillFlowNode,
		RelationshipFlowEdge,
	} from './flow-types';
	import {
		layoutFocusGraph,
		type FocusDirection,
		type FocusGraphGroup,
		type FocusGraphItem,
		type FocusGraphLayout,
		type FocusGraphModel,
	} from './focus-layout';

	type FocusGraphLimits = {
		maxItemsPerSide: number;
		maxEdgesPerItem: number;
	};

	type FocusGraphStats = {
		relatedNodes: number;
		edges: number;
	};

	const MAX_FOCUS_SIDE_ITEMS = 32;
	const MAX_FOCUS_SIDE_ITEMS_COMPACT = 18;
	const MAX_FOCUS_EDGES_PER_ITEM = 3;
	const MAX_FOCUS_EDGES_PER_ITEM_COMPACT = 2;

	let {
		detail,
		ancestors = [],
		crateName,
		crateVersion,
		getNodeUrl,
		height = 620,
		compact = false,
	}: {
		detail: NodeDetail;
		ancestors?: NodeSummary[];
		crateName: string;
		crateVersion: string;
		getNodeUrl: (nodeId: string) => string;
		height?: number;
		compact?: boolean;
	} = $props();

	const nodeTypes = { graphNodePill: GraphNodePillFlow, relationshipLabel: RelationshipLabelFlow };
	const edgeTypes = { relationship: RelationshipEdge };

	let containerWidth = $state(900);
	let hoveredNodeId = $state<string | null>(null);
	let hoveredRel = $state<DesignRelation | null>(null);
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

	const graphLimits: FocusGraphLimits = $derived({
		maxItemsPerSide: compact ? MAX_FOCUS_SIDE_ITEMS_COMPACT : MAX_FOCUS_SIDE_ITEMS,
		maxEdgesPerItem: compact ? MAX_FOCUS_EDGES_PER_ITEM_COMPACT : MAX_FOCUS_EDGES_PER_ITEM,
	});
	const model = $derived.by(() => buildFocusModel(detail, ancestors, getNodeUrl, graphLimits));
	const fullGraphStats = $derived.by(() => summarizeDetailGraph(detail));
	const shownGraphStats = $derived.by(() => summarizeModelGraph(model));
	const graphIsCapped = $derived(
		shownGraphStats.relatedNodes < fullGraphStats.relatedNodes ||
			shownGraphStats.edges < fullGraphStats.edges,
	);
	const graphSize = $derived({
		width: Math.max(compact ? 560 : 720, containerWidth || 0),
		height,
		compact,
	});
	const layout = $derived(layoutFocusGraph(model, graphSize));
	const hoveredNode = $derived(
		hoveredNodeId ? layout.nodes.find((node) => node.id === hoveredNodeId) : null,
	);
	let flowNodes = $state.raw<FocusGraphFlowNode[]>([]);
	let flowEdges = $state.raw<RelationshipFlowEdge[]>([]);

	$effect(() => {
		const graphNodes: GraphNodePillFlowNode[] = layout.nodes.map((node) => {
			const dim =
				(hoveredNodeId != null && node.id !== hoveredNodeId) ||
				(hoveredRel != null && node.rel !== hoveredRel && !node.isFocus);
			const active = node.id === hoveredNodeId;
			return {
				id: node.id,
				type: 'graphNodePill',
				position: { x: node.x, y: node.y },
				draggable: true,
				selectable: false,
				connectable: false,
				focusable: false,
				ariaRole: 'presentation',
				data: {
					node: node.node,
					color: node.color,
					isFocus: node.isFocus,
					dim,
					active,
					href: resolveAppPath(getNodeUrl(node.realId)),
					width: node.width,
					height: node.height,
					inCount: node.inCount,
					outCount: node.outCount,
					direction: node.direction,
				} satisfies GraphNodePillFlowData,
			};
		});
		const labelNodes: FocusGraphFlowNode[] = layout.labels.map((label) => ({
			id: `label:${label.id}`,
			type: 'relationshipLabel',
			position: { x: label.x - label.width / 2, y: label.y - 10 },
			draggable: false,
			selectable: false,
			connectable: false,
			focusable: false,
			ariaRole: 'presentation',
			data: {
				text: label.text,
				count: label.count,
				color: label.color,
				width: label.width,
				dim: hoveredRel != null && hoveredRel !== label.rel,
				active: hoveredRel === label.rel,
			},
		}));
		flowNodes = [...graphNodes, ...labelNodes];
		flowEdges = layout.edges.map((edge) => {
			const dim =
				(hoveredNodeId != null && !edge.activeNodeIds.includes(hoveredNodeId)) ||
				(hoveredRel != null && edge.rel !== hoveredRel);
			const active =
				(hoveredNodeId != null && edge.activeNodeIds.includes(hoveredNodeId)) ||
				hoveredRel === edge.rel;
			return {
				id: edge.id,
				type: 'relationship',
				source: edge.source,
				target: edge.target,
				selectable: false,
				focusable: false,
				data: {
					kind: edge.kind,
					relation: edge.rel,
					direction: edge.direction,
					color: edge.color,
					path: edge.path,
					arrowPath: edge.arrowPath,
					dim,
					active,
				},
			};
		});
	});

	function handleNodeEnter({
		node,
	}: {
		node: FocusGraphFlowNode;
		event: PointerEvent;
	}) {
		if (node.type !== 'graphNodePill') return;
		hoveredNodeId = node.id;
	}

	function handleNodeLeave() {
		hoveredNodeId = null;
	}

	function clearPeek() {
		hoveredNodeId = null;
		hoveredRel = null;
	}

	function buildFocusModel(
		currentDetail: NodeDetail,
		currentAncestors: NodeSummary[],
		urlForNode: (nodeId: string) => string,
		limits: FocusGraphLimits,
	): FocusGraphModel {
		const nodesById = new Map<string, Node>([
			[currentDetail.node.id, currentDetail.node],
			...currentDetail.relatedNodes.map((node) => [node.id, node] as const),
		]);
		const counts = countEdges(currentDetail.edges);
		const designUrl = (nodeId: string) => resolveAppPath(urlForNode(nodeId));
		return {
			focus: toDesignNode(currentDetail.node, {
				ancestors: currentAncestors,
				getNodeUrl: designUrl,
			}),
			incoming: buildGroups(
				currentDetail.edges.filter((edge) => edge.to === currentDetail.node.id),
				'incoming',
				currentDetail.node.id,
				nodesById,
				counts,
				designUrl,
				limits,
			),
			outgoing: buildGroups(
				currentDetail.edges.filter((edge) => edge.from === currentDetail.node.id),
				'outgoing',
				currentDetail.node.id,
				nodesById,
				counts,
				designUrl,
				limits,
			),
		};
	}

	function buildGroups(
		edges: Edge[],
		direction: FocusDirection,
		focusId: string,
		nodesById: Map<string, Node>,
		counts: Map<string, { incoming: number; outgoing: number }>,
		urlForNode: (nodeId: string) => string,
		limits: FocusGraphLimits,
	): FocusGraphGroup[] {
		const buckets = new Map<
			DesignRelation,
			{
				verb: string;
				label: string;
				color: string;
				items: Map<string, FocusGraphItem>;
			}
		>();

		for (const edge of edges) {
			const otherId = direction === 'incoming' ? edge.from : edge.to;
			if (otherId === focusId) continue;
			const other = nodesById.get(otherId);
			if (!other) continue;
			const relation = edgeKindToRelation(edge.kind);
			const bucket =
				buckets.get(relation.token) ??
				({
					verb: direction === 'incoming' ? relation.in : relation.out,
					label: relation.label,
					color: relation.color,
					items: new Map<string, FocusGraphItem>(),
				} satisfies {
					verb: string;
					label: string;
					color: string;
					items: Map<string, FocusGraphItem>;
				});
			const existing = bucket.items.get(otherId);
			if (existing) {
				existing.edges.push(edge);
			} else {
				const nodeCounts = counts.get(otherId) ?? { incoming: 0, outgoing: 0 };
				bucket.items.set(otherId, {
					node: toDesignNode(other, { getNodeUrl: urlForNode }),
					edges: [edge],
					rel: relation.token,
					color: relation.color,
					direction,
					inCount: nodeCounts.incoming,
					outCount: nodeCounts.outgoing,
				});
			}
			buckets.set(relation.token, bucket);
		}

		const candidates = Array.from(buckets.entries()).flatMap(([rel, bucket]) =>
			Array.from(bucket.items.entries()).map(([nodeId, item]) => ({
				key: `${rel}:${nodeId}`,
				item,
			})),
		);
		const allowed = new Set(
			candidates
				.sort((a, b) => compareFocusItem(a.item, b.item))
				.slice(0, limits.maxItemsPerSide)
				.map((candidate) => candidate.key),
		);

		return REL_ORDER.filter((rel) => buckets.has(rel)).map((rel) => {
			const bucket = buckets.get(rel)!;
			const items = Array.from(bucket.items.entries())
				.map(([nodeId, item]) => ({ key: `${rel}:${nodeId}`, item }))
				.filter(({ key }) => allowed.has(key))
				.map(({ item }) => ({ ...item, edges: item.edges.slice(0, limits.maxEdgesPerItem) }))
				.sort(compareFocusItem);
			return {
				rel,
				verb: bucket.verb,
				label: bucket.label,
				color: bucket.color,
				direction,
				items,
			};
		}).filter((group) => group.items.length > 0);
	}

	function countEdges(edges: Edge[]): Map<string, { incoming: number; outgoing: number }> {
		const counts = new Map<string, { incoming: number; outgoing: number }>();
		function ensure(id: string) {
			const existing = counts.get(id);
			if (existing) return existing;
			const next = { incoming: 0, outgoing: 0 };
			counts.set(id, next);
			return next;
		}
		for (const edge of edges) {
			ensure(edge.from).outgoing += 1;
			ensure(edge.to).incoming += 1;
		}
		return counts;
	}

	function compareFocusItem(a: FocusGraphItem, b: FocusGraphItem): number {
		return (
			b.edges.length - a.edges.length ||
			b.inCount + b.outCount - (a.inCount + a.outCount) ||
			a.node.label.localeCompare(b.node.label)
		);
	}

	function summarizeDetailGraph(currentDetail: NodeDetail): FocusGraphStats {
		const relatedIds = new Set(currentDetail.relatedNodes.map((node) => node.id));
		const shownRelatedIds = new Set<string>();
		let edgeCount = 0;
		for (const edge of currentDetail.edges) {
			if (edge.from === currentDetail.node.id && relatedIds.has(edge.to)) {
				shownRelatedIds.add(edge.to);
				edgeCount += 1;
			} else if (edge.to === currentDetail.node.id && relatedIds.has(edge.from)) {
				shownRelatedIds.add(edge.from);
				edgeCount += 1;
			}
		}
		return { relatedNodes: shownRelatedIds.size, edges: edgeCount };
	}

	function summarizeModelGraph(currentModel: FocusGraphModel): FocusGraphStats {
		const relatedIds = new Set<string>();
		let edgeCount = 0;
		for (const group of [...currentModel.incoming, ...currentModel.outgoing]) {
			for (const item of group.items) {
				relatedIds.add(item.node.id);
				edgeCount += item.edges.length;
			}
		}
		return { relatedNodes: relatedIds.size, edges: edgeCount };
	}

	function relationLabel(rel: DesignRelation): string {
		return REL[rel].label;
	}

	function peekPosition(currentLayout: FocusGraphLayout) {
		if (!hoveredNode) return null;
		const cardWidth = 236;
		const cardHeight = 96;
		const left =
			hoveredNode.direction === 'incoming'
				? hoveredNode.x + hoveredNode.width + 12
				: hoveredNode.x - cardWidth - 12;
		return {
			left: Math.max(8, Math.min(currentLayout.width - cardWidth - 8, left)),
			top: Math.max(46, hoveredNode.y - cardHeight - 14),
			width: cardWidth,
		};
	}
</script>

<div
	class="focus-graph-flow relative overflow-hidden"
	style={`height: ${height}px`}
	bind:clientWidth={containerWidth}
	role="group"
	aria-label={`Relationship graph for ${detail.node.name} in ${crateName}@${crateVersion}`}
>
	<div class="absolute inset-0 focus-graph-flow__dots" aria-hidden="true"></div>
	<div
		class="pointer-events-none absolute left-0 right-0 flex items-center justify-between px-6"
		style="top: 12px"
	>
		<div class="mono flex items-center gap-2 text-2xs tracking-[0.2em] text-(--muted-soft) uppercase">
			<span class="inline-block h-px w-6 bg-(--panel-border)"></span>
			<span>points into {detail.node.name}</span>
		</div>
		<div class="mono flex items-center gap-2 text-2xs tracking-[0.2em] text-(--muted-soft) uppercase">
			<span>{detail.node.name} points to</span>
			<span class="inline-block h-px w-6 bg-(--panel-border)"></span>
		</div>
	</div>

	{#if graphIsCapped}
		<div
			class="pointer-events-none absolute left-1/2 z-20 -translate-x-1/2 rounded-md border border-(--panel-border-soft) bg-(--panel-solid) px-2.5 py-1 text-xs text-(--muted)"
			style="top: 42px"
		>
			showing {shownGraphStats.relatedNodes.toLocaleString()} of {fullGraphStats.relatedNodes.toLocaleString()}
			related nodes · {shownGraphStats.edges.toLocaleString()} of {fullGraphStats.edges.toLocaleString()}
			edges
		</div>
	{/if}

	{#if flowReady}
		<SvelteFlow
			nodes={flowNodes}
			edges={flowEdges}
			{nodeTypes}
			{edgeTypes}
			width={graphSize.width}
			height={height}
			nodesDraggable={true}
			nodesConnectable={false}
			elementsSelectable={false}
			nodesFocusable={false}
			edgesFocusable={false}
			autoPanOnNodeFocus={true}
			fitView={true}
			fitViewOptions={{ padding: 0.14, minZoom: 0.35, maxZoom: 1 }}
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
			minZoom={0.35}
			maxZoom={2}
			onnodepointerenter={handleNodeEnter}
			onnodepointerleave={handleNodeLeave}
			onpaneclick={clearPeek}
		/>
	{:else}
		<div class="absolute inset-0 flex items-center justify-center text-sm text-(--muted)">
			Preparing relationship graph...
		</div>
	{/if}

	{#if flowReady && hoveredNode}
		{@const pos = peekPosition(layout)}
		{#if pos}
			<div
				class="pointer-events-none absolute z-40 animate-[fadeIn_.12s_ease] rounded-xl border border-(--panel-border) bg-(--panel-solid) p-3 shadow-(--shadow-glow)"
				style={`left: ${pos.left}px; top: ${pos.top}px; width: ${pos.width}px`}
			>
				<div class="mb-1.5 flex items-center gap-2">
					<KindBadge kind={hoveredNode.node.kind} size={16} />
					<span class="mono truncate text-sm font-semibold text-(--ink)">
						{hoveredNode.node.label}
					</span>
					<span
						class="mono ml-auto rounded bg-(--panel-muted) px-1.5 py-0.5 text-2xs tracking-wider text-(--muted) uppercase"
					>
						{hoveredNode.node.kindLabel}
					</span>
				</div>
				<div class="mono mb-2 truncate text-2xs text-(--muted-soft)">
					{hoveredNode.node.path}
				</div>
				<div class="flex items-center gap-3 text-xs text-(--muted)">
					<span class="inline-flex items-center gap-1">
						<b class="text-(--ink-soft)">{hoveredNode.inCount}</b>
						incoming
					</span>
					<span class="opacity-40">/</span>
					<span class="inline-flex items-center gap-1">
						<b class="text-(--ink-soft)">{hoveredNode.outCount}</b>
						outgoing
					</span>
					<span class="mono ml-auto inline-flex items-center gap-1 text-(--accent-strong)">
						focus
						<Icon name="arrow-right" size={10} />
					</span>
				</div>
			</div>
		{/if}
	{/if}

	{#if flowReady && layout.edges.length === 0}
		<div
			class="mono absolute left-1/2 -translate-x-1/2 text-sm text-(--muted-soft)"
			style={`top: ${layout.centerY + 44}px`}
		>
			no relationships recorded for this item
		</div>
	{/if}

	{#if flowReady && layout.activeRelations.length > 0}
		<div
			class="absolute bottom-3 left-3 flex items-center gap-0.5 rounded-lg border border-(--panel-border-soft) bg-(--panel-solid) px-1.5 py-1 shadow-(--shadow-soft)"
			aria-label="Relationship legend"
		>
			{#each layout.activeRelations as rel (rel)}
				{@const active = hoveredRel === rel}
				<button
					type="button"
					class="mono flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs transition-colors {active
						? 'bg-(--panel-muted) text-(--ink)'
						: 'text-(--muted)'}"
					onmouseenter={() => (hoveredRel = rel)}
					onmouseleave={() => (hoveredRel = null)}
					aria-label={relationLabel(rel)}
				>
					<span class="inline-block h-[3px] w-3 rounded" style={`background: ${REL[rel].color}`}></span>
					{relationLabel(rel)}
				</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.focus-graph-flow {
		background: var(--bg);
	}

	.focus-graph-flow__dots {
		top: 30px;
		background-image: radial-gradient(var(--panel-border-soft) 1px, transparent 1px);
		background-size: 26px 26px;
	}

	.focus-graph-flow :global(.svelte-flow) {
		--xy-background-color: transparent;
		--xy-edge-stroke: var(--panel-border);
		--xy-selection-background-color: transparent;
		--xy-selection-border: 0;
	}

	.focus-graph-flow :global(.svelte-flow__node) {
		background: transparent;
		border: 0;
		box-shadow: none;
	}

	.focus-graph-flow :global(.svelte-flow__node:focus),
	.focus-graph-flow :global(.svelte-flow__node:focus-visible) {
		outline: none;
	}

	.focus-graph-flow :global(.svelte-flow__attribution) {
		display: none;
	}
</style>
