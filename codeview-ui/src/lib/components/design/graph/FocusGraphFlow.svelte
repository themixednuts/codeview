<script lang="ts">
	import { SvelteFlow } from '@xyflow/svelte';
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
	import RelationshipEdge from './RelationshipEdge.svelte';
	import type {
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

	const nodeTypes = { graphNodePill: GraphNodePillFlow };
	const edgeTypes = { relationship: RelationshipEdge };

	let containerWidth = $state(900);
	let hoveredNodeId = $state<string | null>(null);
	let hoveredRel = $state<DesignRelation | null>(null);

	const model = $derived.by(() => buildFocusModel(detail, ancestors, getNodeUrl));
	const graphSize = $derived({
		width: Math.max(compact ? 560 : 720, containerWidth || 0),
		height,
		compact,
	});
	const layout = $derived(layoutFocusGraph(model, graphSize));
	const hoveredNode = $derived(
		hoveredNodeId ? layout.nodes.find((node) => node.id === hoveredNodeId) : null,
	);
	const flowNodes = $derived.by<GraphNodePillFlowNode[]>(() =>
		layout.nodes.map((node) => {
			const dim =
				(hoveredNodeId != null && node.id !== hoveredNodeId) ||
				(hoveredRel != null && node.rel !== hoveredRel && !node.isFocus);
			const active = node.id === hoveredNodeId;
			return {
				id: node.id,
				type: 'graphNodePill',
				position: { x: node.x, y: node.y },
				draggable: false,
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
					onEscape: clearPeek,
				} satisfies GraphNodePillFlowData,
			};
		}),
	);
	const flowEdges = $derived.by<RelationshipFlowEdge[]>(() =>
		layout.edges.map((edge) => {
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
		}),
	);

	function handleNodeEnter({
		node,
	}: {
		node: GraphNodePillFlowNode;
		event: PointerEvent;
	}) {
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
			),
			outgoing: buildGroups(
				currentDetail.edges.filter((edge) => edge.from === currentDetail.node.id),
				'outgoing',
				currentDetail.node.id,
				nodesById,
				counts,
				designUrl,
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

		return REL_ORDER.filter((rel) => buckets.has(rel)).map((rel) => {
			const bucket = buckets.get(rel)!;
			return {
				rel,
				verb: bucket.verb,
				label: bucket.label,
				color: bucket.color,
				direction,
				items: Array.from(bucket.items.values()).sort((a, b) =>
					a.node.label.localeCompare(b.node.label),
				),
			};
		});
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
		<div class="mono flex items-center gap-2 text-[10px] tracking-[0.2em] text-(--muted-soft) uppercase">
			<span class="inline-block h-px w-6 bg-(--panel-border)"></span>
			<span>points into {detail.node.name}</span>
		</div>
		<div class="mono flex items-center gap-2 text-[10px] tracking-[0.2em] text-(--muted-soft) uppercase">
			<span>{detail.node.name} points to</span>
			<span class="inline-block h-px w-6 bg-(--panel-border)"></span>
		</div>
	</div>

	<SvelteFlow
		nodes={flowNodes}
		edges={flowEdges}
		{nodeTypes}
		{edgeTypes}
		width={layout.width}
		height={layout.height}
		nodesDraggable={false}
		nodesConnectable={false}
		elementsSelectable={false}
		nodesFocusable={false}
		edgesFocusable={false}
		autoPanOnNodeFocus={false}
		panOnDrag={false}
		panOnScroll={false}
		zoomOnScroll={false}
		zoomOnDoubleClick={false}
		zoomOnPinch={false}
		preventScrolling={false}
		deleteKey={null}
		selectionKey={null}
		multiSelectionKey={null}
		panActivationKey={null}
		zoomActivationKey={null}
		onlyRenderVisibleElements={false}
		minZoom={1}
		maxZoom={1}
		viewport={{ x: 0, y: 0, zoom: 1 }}
		onnodepointerenter={handleNodeEnter}
		onnodepointerleave={handleNodeLeave}
		onpaneclick={clearPeek}
	/>

	{#each layout.labels as label (label.id)}
		<div
			class="pointer-events-none absolute flex h-5 items-center justify-center rounded-full border bg-(--panel-solid) px-2"
			style={`left: ${label.x - label.width / 2}px; top: ${label.y - 10}px; width: ${label.width}px; border-color: ${label.color}; color: ${label.color}`}
		>
			<span class="mono truncate text-[10.5px] font-semibold">{label.text}</span>
			<span class="mono ml-2 text-[9.5px] font-bold opacity-75">{label.count}</span>
		</div>
	{/each}

	{#if hoveredNode}
		{@const pos = peekPosition(layout)}
		{#if pos}
			<div
				class="pointer-events-none absolute z-40 animate-[fadeIn_.12s_ease] rounded-xl border border-(--panel-border) bg-(--panel-solid) p-3 shadow-(--shadow-glow)"
				style={`left: ${pos.left}px; top: ${pos.top}px; width: ${pos.width}px`}
			>
				<div class="mb-1.5 flex items-center gap-2">
					<KindBadge kind={hoveredNode.node.kind} size={16} />
					<span class="mono truncate text-[13px] font-semibold text-(--ink)">
						{hoveredNode.node.label}
					</span>
					<span
						class="mono ml-auto rounded bg-(--panel-muted) px-1.5 py-0.5 text-[9.5px] tracking-wider text-(--muted) uppercase"
					>
						{hoveredNode.node.kindLabel}
					</span>
				</div>
				<div class="mono mb-2 truncate text-[10px] text-(--muted-soft)">
					{hoveredNode.node.path}
				</div>
				<div class="flex items-center gap-3 text-[10.5px] text-(--muted)">
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

	{#if layout.edges.length === 0}
		<div
			class="mono absolute left-1/2 -translate-x-1/2 text-[12px] text-(--muted-soft)"
			style={`top: ${layout.centerY + 44}px`}
		>
			no relationships recorded for this item
		</div>
	{/if}

	{#if layout.activeRelations.length > 0}
		<div
			class="absolute bottom-3 left-3 flex items-center gap-0.5 rounded-lg border border-(--panel-border-soft) bg-(--panel-solid) px-1.5 py-1 shadow-(--shadow-soft)"
			aria-label="Relationship legend"
		>
			{#each layout.activeRelations as rel (rel)}
				{@const active = hoveredRel === rel}
				<button
					type="button"
					class="mono flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[10.5px] transition-colors {active
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
