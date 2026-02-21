<script lang="ts">
	import type { Graph, Node } from '$lib/graph';
	import type { LayoutMode, VisEdge, VisNode } from '$lib/graph/layout';
	import { resolve } from '$app/paths';
	import { kindColors } from '$lib/tree';
	import { KeyedMemo, keyEqual, keyOf } from '$lib/reactivity.svelte';
	import { CENTER_X, CENTER_Y, LAYOUT_HEIGHT, LAYOUT_WIDTH } from '$lib/graph/layout';
	import {
		GRAPH_PROJECTION_EDGE_CAP,
		GRAPH_PROJECTION_MAX_HOPS,
		GRAPH_PROJECTION_NODE_CAP,
		type GraphProjectionResult,
		projectGraphForRendering,
	} from '$lib/graph/projection';
	import { getNodeVisual, getVisNodeEdgeAnchor } from '$lib/graph/visual';
	import { renderExcalidraw } from '$lib/exporters/excalidraw';
	import { type BaseScene, buildBaseScene, buildNodeMap, computeSceneLabels } from '$lib/renderers/graph';
	import type { GraphScene } from '$lib/renderers/graph';
	import { Button } from '$lib/shadcn/ui/button';
	import { ButtonGroup } from '$lib/shadcn/ui/button-group';
	import { perf } from '$lib/perf';
	import { SvelteMap } from 'svelte/reactivity';

	let {
		graph,
		selected,
		getNodeUrl,
		layoutMode = 'ego',
		showStructural = false,
		showSemantic = true,
		bypassProjection = false,
		onToggleStructural,
		onToggleSemantic,
	} = $props<{
		graph: Graph;
		selected: Node;
		getNodeUrl: (id: string) => string;
		layoutMode?: LayoutMode;
		showStructural?: boolean;
		showSemantic?: boolean;
		bypassProjection?: boolean;
		onToggleStructural?: () => void;
		onToggleSemantic?: () => void;
	}>();

	type DragOffset = { x: number; y: number };

	const WIDTH = LAYOUT_WIDTH;
	const HEIGHT = LAYOUT_HEIGHT;
	const GRID_SIZE = 32;
	const EDGE_NODE_PADDING = 10;
	const HOVER_RING = 4;
	const LABEL_CHAR_RATIO = 0.6;
	const DOT_MODE_NODE_THRESHOLD = 90;
	const DOT_MODE_EDGE_LABEL_LIMIT = 180;

	type NodeRenderMode = 'auto' | 'detail' | 'dots';
	const SVG_STYLE_PROPERTIES = [
		'fill',
		'fill-opacity',
		'stroke',
		'stroke-width',
		'stroke-opacity',
		'stroke-dasharray',
		'stroke-linecap',
		'stroke-linejoin',
		'opacity',
		'font-size',
		'font-family',
		'font-weight',
		'font-style',
		'letter-spacing',
		'text-anchor',
		'dominant-baseline',
	] as const;
	const SVG_ATTRS_WITH_VARS = ['fill', 'stroke', 'style'] as const;

	// Pan and zoom state
	let zoom = $state(1);
	let panX = $state(0);
	let panY = $state(0);
	let isPanning = $state(false);
	let panStartX = 0;
	let panStartY = 0;
	let panStartPanX = 0;
	let panStartPanY = 0;

	// True during drag or pan — disables CSS transitions for performance
	let isInteracting = $state(false);

	let containerEl = $state<HTMLDivElement | null>(null);
	let svgEl = $state<SVGSVGElement | null>(null);
	let dragNodeId = $state<string | null>(null);
	// SvelteMap provides granular reactivity: only the dragged node's offset triggers updates,
	// avoiding re-evaluation of all derived computations when a single entry changes.
	let dragOffsets = new SvelteMap<string, DragOffset>();
	let dragStart = { x: 0, y: 0 };
	let dragStartScreen = { x: 0, y: 0 };
	let dragNodeStart = { x: 0, y: 0 };
	let dragBasePos = { x: 0, y: 0 };
	let didDrag = false;
	let suppressClick = false;

	// Tooltip state
	let tooltipNode = $state<VisNode | null>(null);
	let tooltipX = $state(0);
	let tooltipY = $state(0);
	let nodeRenderMode = $state<NodeRenderMode>('auto');

	const MIN_ZOOM = 0.3;
	const MAX_ZOOM = 3;

	function captureContainer(element: HTMLDivElement) {
		containerEl = element;
		return () => {
			containerEl = null;
		};
	}

	function handleWheel(e: WheelEvent) {
		e.preventDefault();
		const delta = e.deltaY > 0 ? 0.9 : 1.1;
		const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * delta));

		// Zoom toward mouse position (in SVG viewBox coords)
		const { x: svgX, y: svgY } = screenToSvg(e.clientX, e.clientY);

		// Adjust pan to zoom toward mouse
		const zoomRatio = newZoom / zoom;
		panX = svgX - (svgX - panX) * zoomRatio;
		panY = svgY - (svgY - panY) * zoomRatio;

		zoom = newZoom;
	}

	function handleMouseDown(e: MouseEvent) {
		if (e.button === 0) {
			// Left click
			isPanning = true;
			isInteracting = true;
			panStartX = e.clientX;
			panStartY = e.clientY;
			panStartPanX = panX;
			panStartPanY = panY;
		}
	}

	function handleMouseMove(e: MouseEvent) {
		if (dragNodeId) return;
		if (isPanning) {
			// Delta in viewBox space — screenToSvg already accounts for SVG scaling
			const cur = screenToSvg(e.clientX, e.clientY);
			const start = screenToSvg(panStartX, panStartY);
			panX = panStartPanX + (cur.x - start.x);
			panY = panStartPanY + (cur.y - start.y);
		}
	}

	function handleMouseUp() {
		isPanning = false;
		isInteracting = false;
		endNodeDrag();
	}

	function handleMouseLeave() {
		// Don't stop panning/dragging on leave — let global handlers track outside the viewport
		// Only stop if not actively interacting
		if (!dragNodeId && !isPanning) {
			isInteracting = false;
		}
		tooltipNode = null;
	}

	function resetView() {
		zoom = 1;
		panX = 0;
		panY = 0;
		dragOffsets.clear();
	}

	function zoomIn() {
		zoom = Math.min(MAX_ZOOM, zoom * 1.2);
	}

	function zoomOut() {
		zoom = Math.max(MIN_ZOOM, zoom / 1.2);
	}

	function sanitizeFilenameStem(name: string): string {
		const trimmed = name.trim().toLowerCase();
		if (!trimmed) return 'relationship-graph';
		return trimmed
			.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
			.replace(/\s+/g, '-')
			.replace(/-+/g, '-')
			.replace(/^[-.]+|[-.]+$/g, '');
	}

	function exportFilenameStem(): string {
		const stem = sanitizeFilenameStem(`${selected.id}-relationship-graph`);
		return stem || 'relationship-graph';
	}

	function downloadBlob(blob: Blob, filename: string): void {
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = filename;
		document.body.appendChild(link);
		link.click();
		link.remove();
		setTimeout(() => URL.revokeObjectURL(url), 0);
	}

	function resolveCssVars(value: string): string {
		return value.replace(/var\((--[\w-]+)\)/g, (_, token: string) => {
			const resolved = getComputedStyle(document.documentElement)
				.getPropertyValue(token)
				.trim();
			return resolved || `var(${token})`;
		});
	}

	function inlineSvgStyles(source: SVGSVGElement, clone: SVGSVGElement): void {
		const sourceEls = [source, ...Array.from(source.querySelectorAll<SVGElement>('*'))];
		const cloneEls = [clone, ...Array.from(clone.querySelectorAll<SVGElement>('*'))];

		for (let i = 0; i < sourceEls.length; i++) {
			const sourceEl = sourceEls[i];
			const cloneEl = cloneEls[i];
			if (!cloneEl) continue;

			for (const attr of SVG_ATTRS_WITH_VARS) {
				const value = cloneEl.getAttribute(attr);
				if (value?.includes('var(')) {
					cloneEl.setAttribute(attr, resolveCssVars(value));
				}
			}

			const computed = getComputedStyle(sourceEl);
			const declarations: string[] = [];
			for (const prop of SVG_STYLE_PROPERTIES) {
				const value = computed.getPropertyValue(prop).trim();
				if (!value) continue;
				if (value === 'normal' && (prop === 'font-style' || prop === 'letter-spacing')) continue;
				declarations.push(`${prop}:${value}`);
			}

			const existingStyle = cloneEl.getAttribute('style');
			const mergedStyle = [
				existingStyle ? resolveCssVars(existingStyle) : '',
				declarations.join(';'),
			]
				.filter(Boolean)
				.join(';');

			if (mergedStyle) cloneEl.setAttribute('style', mergedStyle);
		}
	}

	function buildExportScene(): GraphScene {
		return {
			nodes: positionedNodes,
			edges: baseScene.edges,
			labels: edgeLabelPositions,
			groups: baseScene.groups,
			mode: baseScene.mode,
		};
	}

	function exportSvg(): void {
		if (!svgEl) return;
		const clone = svgEl.cloneNode(true) as SVGSVGElement;
		clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
		clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
		clone.setAttribute('width', String(WIDTH));
		clone.setAttribute('height', String(HEIGHT));
		clone.removeAttribute('class');

		inlineSvgStyles(svgEl, clone);

		const svgText = new XMLSerializer().serializeToString(clone);
		downloadBlob(new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' }), `${exportFilenameStem()}.svg`);
	}

	function exportExcalidraw(): void {
		const scene = buildExportScene();
		const file = renderExcalidraw(scene);
		const json = JSON.stringify(file, null, 2);
		downloadBlob(
			new Blob([json], { type: 'application/json;charset=utf-8' }),
			`${exportFilenameStem()}.excalidraw`,
		);
	}

	/** Convert screen (clientX/Y) to SVG viewBox coordinates using native SVG APIs.
	 *  Caches CTM inverse during drag/pan to avoid repeated matrix inversion. */
	let cachedCtmInverse: DOMMatrix | null = null;
	function screenToSvg(clientX: number, clientY: number): DOMPoint {
		if (!svgEl) return new DOMPoint(0, 0);
		// Use cached inverse during interaction for better perf
		if (!cachedCtmInverse || !isInteracting) {
			const ctm = svgEl.getScreenCTM();
			if (!ctm) return new DOMPoint(0, 0);
			cachedCtmInverse = ctm.inverse();
		}
		return new DOMPoint(clientX, clientY).matrixTransform(cachedCtmInverse);
	}
	// Invalidate cache when interaction ends
	$effect(() => {
		if (!isInteracting) cachedCtmInverse = null;
	});

	/** Convert screen mouse coords to world (scene) coordinates, accounting for pan & zoom. */
	function getWorldPoint(e: MouseEvent): { x: number; y: number } {
		const svg = screenToSvg(e.clientX, e.clientY);
		return {
			x: (svg.x - panX) / zoom,
			y: (svg.y - panY) / zoom,
		};
	}

	function startNodeDrag(visNode: VisNode, e: MouseEvent) {
		if (e.button !== 0) return;
		e.stopPropagation();
		e.preventDefault();
		dragNodeId = visNode.node.id;
		hoveredNodeId = visNode.node.id;
		hideTooltip();
		isInteracting = true;
		didDrag = false;
		dragStart = getWorldPoint(e);
		dragStartScreen = { x: e.clientX, y: e.clientY };
		dragNodeStart = { x: visNode.x, y: visNode.y };
		const offset = dragOffsets.get(visNode.node.id) ?? { x: 0, y: 0 };
		dragBasePos = { x: visNode.x - offset.x, y: visNode.y - offset.y };
	}

	function updateNodeDrag(e: MouseEvent) {
		if (!dragNodeId) return;
		perf.frame('interact', 'dragFrame', () => {
			// Screen-space threshold (5px) — consistent across zoom levels, like Excalidraw
			if (
				!didDrag &&
				Math.hypot(e.clientX - dragStartScreen.x, e.clientY - dragStartScreen.y) > 5
			) {
				didDrag = true;
			}
			if (!didDrag) return;
			const world = getWorldPoint(e);
			const dx = world.x - dragStart.x;
			const dy = world.y - dragStart.y;
			const nextX = dragNodeStart.x + dx;
			const nextY = dragNodeStart.y + dy;
			perf.frame('interact', 'dragOffset.set', () => {
				dragOffsets.set(dragNodeId!, { x: nextX - dragBasePos.x, y: nextY - dragBasePos.y });
			});
		});
	}

	function endNodeDrag() {
		if (dragNodeId && didDrag) {
			suppressClick = true;
		}
		hoveredNodeId = null;
		dragNodeId = null;
		isInteracting = false;
	}

	// Global handlers allow drag/pan to continue when the cursor moves outside the SVG container.
	function handleGlobalMouseMove(e: MouseEvent) {
		if (dragNodeId) {
			updateNodeDrag(e);
		} else if (isPanning) {
			const cur = screenToSvg(e.clientX, e.clientY);
			const start = screenToSvg(panStartX, panStartY);
			panX = panStartPanX + (cur.x - start.x);
			panY = panStartPanY + (cur.y - start.y);
		}
	}

	function handleGlobalMouseUp() {
		if (dragNodeId) {
			endNodeDrag();
		}
		if (isPanning) {
			isPanning = false;
			isInteracting = false;
		}
	}

	function showTooltip(visNode: VisNode, e: MouseEvent) {
		tooltipNode = visNode;
		const rect = (e.currentTarget as HTMLElement)
			.closest('.graph-container')
			?.getBoundingClientRect();
		if (rect) {
			tooltipX = e.clientX - rect.left;
			tooltipY = e.clientY - rect.top;
		}
	}

	function hideTooltip() {
		tooltipNode = null;
	}

	const edgeColors: Record<string, string> = {
		Contains: 'var(--edge-contains)',
		Defines: 'var(--edge-defines)',
		UsesType: 'var(--edge-uses)',
		Implements: 'var(--edge-implements)',
		CallsStatic: 'var(--edge-calls)',
		CallsRuntime: 'var(--edge-calls-runtime)',
		Derives: 'var(--edge-derives)',
	};

	function getNodeLabelMetrics(
		nodeWidth: number,
		hasHeader: boolean,
		isCenter: boolean,
	): {
		maxChars: number;
		maxWidth: number;
		fontSize: number;
	} {
		const fontSize = isCenter ? 14 : 11;
		const padding = hasHeader ? 20 : isCenter ? 16 : 12;
		const maxWidth = Math.max(24, nodeWidth - padding);
		const maxChars = Math.max(4, Math.floor(maxWidth / (fontSize * LABEL_CHAR_RATIO)));
		return { maxChars, maxWidth, fontSize };
	}

	function getDotRadius(visNode: VisNode, isHovered: boolean, isRelatedToHover: boolean): number {
		if (visNode.isCenter) return 16;
		if (isHovered) return 7;
		if (isRelatedToHover) return 6;
		return 5;
	}

	function estimateLabelWidth(label: string, fontSize: number): number {
		return label.length * fontSize * LABEL_CHAR_RATIO;
	}

	function getEdgeLabelMetrics(
		kind: string,
		isHighlighted: boolean,
	): {
		width: number;
		height: number;
		fontSize: number;
	} {
		const fontSize = isHighlighted ? 11 : 9;
		const paddingX = isHighlighted ? 8 : 6;
		const paddingY = isHighlighted ? 4 : 3;
		const textWidth = estimateLabelWidth(kind, fontSize);
		const width = Math.max(28, textWidth + paddingX * 2);
		const height = fontSize + paddingY * 2;
		return { width, height, fontSize };
	}

	let hoveredNodeId = $state<string | null>(null);
	let hoveredEdgeIndex = $state<number | null>(null);

	const EMPTY_PROJECTION: GraphProjectionResult = {
		graph: { nodes: [], edges: [] },
		traitMetadataByNodeId: new Map(),
		syntheticNodeIds: new Set(),
	};
	const projectionMemo = new KeyedMemo(
		() => keyOf(graph, selected?.id ?? '', layoutMode, showStructural, showSemantic, bypassProjection),
		() => {
			if (!graph || !selected) return EMPTY_PROJECTION;
			if (bypassProjection) {
				return {
					graph,
					traitMetadataByNodeId: new Map(),
					syntheticNodeIds: new Set(),
				} satisfies GraphProjectionResult;
			}
			return perf.time(
				'derived',
				'projectedGraph',
				() =>
					projectGraphForRendering(graph, selected, {
						showStructural,
						showSemantic,
						layoutMode,
						maxNodes: GRAPH_PROJECTION_NODE_CAP,
						maxEdges: GRAPH_PROJECTION_EDGE_CAP,
						maxHops: GRAPH_PROJECTION_MAX_HOPS,
					}),
				{ threshold: 5 },
			);
		},
		{ equalsKey: keyEqual },
	);
	let projectedGraph = $derived(projectionMemo.current ?? EMPTY_PROJECTION);

	// Stage 1: base scene (layout + similarity groups). Cached behind KeyedMemo.
	// Guard: selected/graph can be null during Svelte async teardown race (_Batch.revive)
	const EMPTY_SCENE: BaseScene = { nodes: [], edges: [], groups: [], similarityGroups: new Map(), mode: 'ego' };
	const baseSceneMemo = new KeyedMemo(
		() => keyOf(projectedGraph.graph, selected?.id ?? '', layoutMode, showStructural, showSemantic),
		() => {
			if (!selected) return EMPTY_SCENE;
			return perf.time(
				'derived',
				'baseScene',
				() =>
					buildBaseScene(projectedGraph.graph, selected, layoutMode, {
						showStructural: true,
						showSemantic: true,
					}),
				{ threshold: 5 },
			);
		},
		{ equalsKey: keyEqual },
	);
	let baseScene = $derived(baseSceneMemo.current ?? EMPTY_SCENE);

	let effectiveNodeRenderMode = $derived.by<NodeRenderMode>(() => {
		if (nodeRenderMode !== 'auto') return nodeRenderMode;
		return baseScene.nodes.length >= DOT_MODE_NODE_THRESHOLD ? 'dots' : 'detail';
	});

	let isDotMode = $derived(effectiveNodeRenderMode === 'dots');

	let positionedNodes = $derived.by(() => {
		return perf.frame('derived', 'positionedNodes', () =>
			baseScene.nodes.map((node) => {
				const offset = dragOffsets.get(node.node.id);
				if (!offset) return node;
				return { ...node, x: node.x + offset.x, y: node.y + offset.y };
			}),
		);
	});

	let positionedNodeMap = $derived.by(() =>
		perf.frame('derived', 'positionedNodeMap', () => buildNodeMap(positionedNodes)),
	);

	// Viewport culling — only render nodes/edges visible in the current view
	const CULL_MARGIN = 100; // px margin around viewport for labels
	const CULL_MARGIN_INTERACTION = 300; // larger margin during pan to avoid popping

	function computeBounds(margin: number) {
		return {
			minX: -panX / zoom - margin,
			minY: -panY / zoom - margin,
			maxX: (-panX + WIDTH) / zoom + margin,
			maxY: (-panY + HEIGHT) / zoom + margin,
		};
	}

	// Freeze culling bounds during pan (not node drag) to avoid re-culling every frame
	let frozenBounds: ReturnType<typeof computeBounds> | null = null;
	let visibleBounds = $derived.by(() => {
		// Only freeze during pan, not node drag — node drag changes positions so culling must stay live
		if (isPanning && frozenBounds) return frozenBounds;
		return computeBounds(CULL_MARGIN);
	});
	$effect(() => {
		if (isPanning) {
			if (!frozenBounds) frozenBounds = computeBounds(CULL_MARGIN_INTERACTION);
		} else {
			frozenBounds = null;
		}
	});

	function isNodeVisible(node: VisNode): boolean {
		const visual = getNodeVisual(node.node.kind, node.isCenter);
		const hw = visual.width / 2;
		const hh = visual.height / 2;
		return (
			node.x + hw >= visibleBounds.minX &&
			node.x - hw <= visibleBounds.maxX &&
			node.y + hh >= visibleBounds.minY &&
			node.y - hh <= visibleBounds.maxY
		);
	}

	let visibleNodeIds = $derived.by(() => {
		return perf.frame('derived', 'visibleNodeIds', () => {
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- rebuilt each derived run
			const ids = new Set<string>();
			for (const node of positionedNodes) {
				if (isNodeVisible(node)) ids.add(node.node.id);
			}
			return ids;
		});
	});

	let visibleNodes = $derived(positionedNodes.filter((n) => visibleNodeIds.has(n.node.id)));

	let visibleEdges = $derived.by(() => {
		return perf.frame('derived', 'visibleEdges', () =>
			baseScene.edges
				.map((edge, i) => ({ edge, index: i }))
				.filter(({ edge }) => {
					const fromNode = positionedNodeMap.get(edge.from.node.id) ?? edge.from;
					const toNode = positionedNodeMap.get(edge.to.node.id) ?? edge.to;
					if (visibleNodeIds.has(edge.from.node.id) || visibleNodeIds.has(edge.to.node.id))
						return true;
					const minX = Math.min(fromNode.x, toNode.x);
					const maxX = Math.max(fromNode.x, toNode.x);
					const minY = Math.min(fromNode.y, toNode.y);
					const maxY = Math.max(fromNode.y, toNode.y);
					return !(
						maxX < visibleBounds.minX ||
						minX > visibleBounds.maxX ||
						maxY < visibleBounds.minY ||
						minY > visibleBounds.maxY
					);
				}),
		);
	});

	let shouldShowEdgeLabels = $derived.by(() => {
		if (!isDotMode) return true;
		if (hoveredNodeId || hoveredEdgeIndex !== null) return true;
		return visibleEdges.length <= DOT_MODE_EDGE_LABEL_LIMIT;
	});

	let hoveredNeighborIds = $derived.by(() => {
		if (!hoveredNodeId) return null;
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- rebuilt each derived run
		const neighbors = new Set<string>();
		for (const edge of baseScene.edges) {
			if (edge.from.node.id === hoveredNodeId) {
				neighbors.add(edge.to.node.id);
			} else if (edge.to.node.id === hoveredNodeId) {
				neighbors.add(edge.from.node.id);
			}
		}
		return neighbors;
	});

	function handleNodeClick(node: Node, e: MouseEvent) {
		if (suppressClick) {
			suppressClick = false;
			e.preventDefault();
			return;
		}
		if (projectedGraph.syntheticNodeIds.has(node.id)) {
			e.preventDefault();
			return;
		}
		// Let the <a> tag handle navigation naturally
	}

	function truncateName(name: string, maxLen: number): string {
		if (name.length <= maxLen) return name;
		if (maxLen <= 3) return name.slice(0, maxLen);
		return name.slice(0, maxLen - 3) + '...';
	}

	function docsUrlForNode(nodeId: string): string {
		const parts = nodeId.split('::');
		const crate = parts[0] ?? nodeId;
		const path = parts.slice(1).join('/');
		return path
			? `https://docs.rs/${crate}/latest/${crate}/${path.toLowerCase()}/`
			: `https://docs.rs/${crate}/latest/${crate}/`;
	}

	function nodeLink(node: Node): { href: string; external: boolean; disabled: boolean } {
		if (projectedGraph.syntheticNodeIds.has(node.id)) {
			return { href: '', external: false, disabled: true };
		}
		if (node.is_external) {
			return { href: docsUrlForNode(node.id), external: true, disabled: false };
		}
		return { href: getNodeUrl(node.id), external: false, disabled: false };
	}

	// Stage 2: label positions. Recomputes with drag-aware positions.
	// Freeze during pan (not node drag) — panning doesn't change relative label positions.
	let frozenLabels: ReturnType<typeof computeSceneLabels> | null = null;
	let edgeLabelPositions = $derived.by(() => {
		if (isPanning && frozenLabels) return frozenLabels;
		const labels = perf.frame('derived', 'edgeLabelPositions', () =>
			computeSceneLabels(baseScene, positionedNodeMap, (kind) => getEdgeLabelMetrics(kind, false)),
		);
		frozenLabels = labels;
		return labels;
	});
</script>

<svelte:window onmousemove={handleGlobalMouseMove} onmouseup={handleGlobalMouseUp} />

<div
	class="corner-squircle overflow-hidden rounded-(--radius-card) border border-(--panel-border) bg-(--panel-solid)"
>
	<div
		class="flex flex-wrap items-center justify-between gap-2 border-b border-(--panel-border) bg-(--panel) px-4 py-2"
	>
		<div class="flex items-center gap-3">
			<span class="text-sm font-medium text-(--ink)">Relationship Graph</span>
			{#if bypassProjection}
				<span class="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400 uppercase">Raw</span>
			{/if}
			<!-- Edge count indicator -->
			<span class="text-xs text-(--muted)">
				{baseScene.nodes.length} nodes, {baseScene.edges.length} edges
			</span>
		</div>
		<div class="flex flex-wrap items-center gap-4">
			<!-- Edge type filters -->
			<div class="flex items-center gap-1">
				<button
					type="button"
					onclick={() => onToggleStructural?.()}
					class="corner-squircle rounded-(--radius-control) border px-2 py-1 text-xs transition-colors {showStructural
						? 'border-(--accent) bg-(--accent) text-(--on-accent)'
						: 'border-(--panel-border) bg-(--panel-solid) text-(--muted) hover:bg-(--panel-strong)'}"
					title="Show structural edges (Contains, Defines)"
				>
					Structure
				</button>
				<button
					type="button"
					onclick={() => onToggleSemantic?.()}
					class="corner-squircle rounded-(--radius-control) border px-2 py-1 text-xs transition-colors {showSemantic
						? 'border-(--accent) bg-(--accent) text-(--on-accent)'
						: 'border-(--panel-border) bg-(--panel-solid) text-(--muted) hover:bg-(--panel-strong)'}"
					title="Show semantic edges (UsesType, Implements, Calls, Derives)"
				>
					Semantic
				</button>
			</div>
			<div class="flex items-center gap-1">
				<span class="mr-1 text-[10px] font-medium tracking-wide text-(--muted) uppercase">Render</span>
				<button
					type="button"
					onclick={() => {
						nodeRenderMode = 'auto';
					}}
					class="corner-squircle rounded-(--radius-control) border px-2 py-1 text-xs transition-colors {nodeRenderMode ===
					'auto'
						? 'border-(--accent) bg-(--accent) text-(--on-accent)'
						: 'border-(--panel-border) bg-(--panel-solid) text-(--muted) hover:bg-(--panel-strong)'}"
					title="Switch automatically between detail and dense dots"
				>
					Auto
				</button>
				<button
					type="button"
					onclick={() => {
						nodeRenderMode = 'detail';
					}}
					class="corner-squircle rounded-(--radius-control) border px-2 py-1 text-xs transition-colors {nodeRenderMode ===
					'detail'
						? 'border-(--accent) bg-(--accent) text-(--on-accent)'
						: 'border-(--panel-border) bg-(--panel-solid) text-(--muted) hover:bg-(--panel-strong)'}"
					title="Always use full node cards"
				>
					Detail
				</button>
				<button
					type="button"
					onclick={() => {
						nodeRenderMode = 'dots';
					}}
					class="corner-squircle rounded-(--radius-control) border px-2 py-1 text-xs transition-colors {nodeRenderMode ===
					'dots'
						? 'border-(--accent) bg-(--accent) text-(--on-accent)'
						: 'border-(--panel-border) bg-(--panel-solid) text-(--muted) hover:bg-(--panel-strong)'}"
					title="Use compact dot nodes for dense graphs"
				>
					Dots
				</button>
				{#if nodeRenderMode === 'auto'}
					<span class="ml-1 rounded bg-(--panel-strong) px-1.5 py-0.5 text-[10px] text-(--muted)">
						{isDotMode ? 'Dense' : 'Detail'}
					</span>
				{/if}
			</div>
			<!-- Zoom controls -->
			<div class="flex items-center gap-1">
				<button
					type="button"
					onclick={zoomOut}
					class="corner-squircle flex size-6 items-center justify-center rounded-(--radius-control) border border-(--panel-border) bg-(--panel-solid) text-sm text-(--muted) hover:bg-(--panel-strong)"
					title="Zoom out"
				>
					−
				</button>
				<span class="w-12 text-center text-xs text-(--muted)">{Math.round(zoom * 100)}%</span>
				<button
					type="button"
					onclick={zoomIn}
					class="corner-squircle flex size-6 items-center justify-center rounded-(--radius-control) border border-(--panel-border) bg-(--panel-solid) text-sm text-(--muted) hover:bg-(--panel-strong)"
					title="Zoom in"
				>
					+
				</button>
				<button
					type="button"
					onclick={resetView}
					class="corner-squircle ml-1 flex h-6 items-center justify-center rounded-(--radius-control) border border-(--panel-border) bg-(--panel-solid) px-2 text-xs text-(--muted) hover:bg-(--panel-strong)"
					title="Reset view"
				>
					Reset
				</button>
			</div>
			<div class="flex items-center">
				<ButtonGroup class="overflow-hidden p-0">
					<span
						class="inline-flex h-6 items-center border-r border-(--panel-border) bg-(--panel) px-2 text-[10px] font-medium tracking-wide text-(--muted) uppercase"
					>
						Export
					</span>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						class="h-6 rounded-none border-0 px-2 text-xs"
						onclick={exportSvg}
						title="Save graph as SVG"
					>
						SVG
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						class="h-6 rounded-none border-0 border-l border-(--panel-border) px-2 text-xs"
						onclick={exportExcalidraw}
						title="Export graph as .excalidraw"
					>
						Excalidraw
					</Button>
				</ButtonGroup>
			</div>
			<div class="flex items-center gap-4 text-xs text-(--muted)">
				<span class="flex items-center gap-1">
					<span class="inline-block h-0.5 w-3 bg-(--muted)"></span>
					Incoming
				</span>
				<span class="flex items-center gap-1">
					<span class="inline-block h-0.5 w-3 bg-(--accent)"></span>
					Outgoing
				</span>
			</div>
		</div>
	</div>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		{@attach captureContainer}
		class="graph-container relative h-[500px] select-none"
		style="cursor: {isPanning ? 'grabbing' : 'grab'};"
		onwheel={handleWheel}
		onmousedown={handleMouseDown}
		onmousemove={handleMouseMove}
		onmouseup={handleMouseUp}
		onmouseleave={handleMouseLeave}
	>
		<svg
			bind:this={svgEl}
			viewBox="0 0 {WIDTH} {HEIGHT}"
			class="size-full"
			preserveAspectRatio="xMidYMid slice"
		>
			<defs>
				<pattern
					id="grid"
					width={GRID_SIZE * zoom}
					height={GRID_SIZE * zoom}
					patternUnits="userSpaceOnUse"
					x={panX % (GRID_SIZE * zoom)}
					y={panY % (GRID_SIZE * zoom)}
				>
					<path
						d={`M ${GRID_SIZE * zoom} 0 L 0 0 0 ${GRID_SIZE * zoom}`}
						fill="none"
						stroke="var(--grid-line)"
						stroke-width={0.6 * zoom}
					/>
				</pattern>
				<marker
					id="arrow-out"
					viewBox="0 0 10 10"
					refX="8"
					refY="5"
					markerWidth="6"
					markerHeight="6"
					orient="auto-start-reverse"
				>
					<path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
				</marker>
				<marker
					id="arrow-in"
					viewBox="0 0 10 10"
					refX="8"
					refY="5"
					markerWidth="6"
					markerHeight="6"
					orient="auto-start-reverse"
				>
					<path d="M 0 0 L 10 5 L 0 10 z" fill="var(--edge-in)" />
				</marker>
				<marker
					id="arrow-out-highlight"
					viewBox="0 0 10 10"
					refX="8"
					refY="5"
					markerWidth="7"
					markerHeight="7"
					orient="auto-start-reverse"
				>
					<path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
				</marker>
				<marker
					id="arrow-in-highlight"
					viewBox="0 0 10 10"
					refX="8"
					refY="5"
					markerWidth="7"
					markerHeight="7"
					orient="auto-start-reverse"
				>
					<path d="M 0 0 L 10 5 L 0 10 z" fill="var(--edge-in-strong)" />
				</marker>
			</defs>

			<rect width="100%" height="100%" fill="url(#grid)" />
			<g
				class="scene-content"
				style="transform: translate({panX}px, {panY}px) scale({zoom}); will-change: {isInteracting
					? 'transform'
					: 'auto'};"
			>
				<!-- Edges (culled to viewport, with invisible hit areas for easier hovering) -->
				{#each visibleEdges as { edge, index: edgeIndex } (edge.from.node.id + '|' + edge.to.node.id + '|' + edge.kind)}
					{@const fromNode = positionedNodeMap.get(edge.from.node.id) ?? edge.from}
					{@const toNode = positionedNodeMap.get(edge.to.node.id) ?? edge.to}
					{@const startAnchor = getVisNodeEdgeAnchor(fromNode, toNode)}
					{@const endAnchor = getVisNodeEdgeAnchor(toNode, fromNode)}
					{@const dx = endAnchor.x - startAnchor.x}
					{@const dy = endAnchor.y - startAnchor.y}
					{@const len = Math.hypot(dx, dy) || 1}
					{@const startX = startAnchor.x}
					{@const startY = startAnchor.y}
					{@const endX = endAnchor.x - (dx / len) * EDGE_NODE_PADDING}
					{@const endY = endAnchor.y - (dy / len) * EDGE_NODE_PADDING}
					{@const pathD = `M ${startX} ${startY} L ${endX} ${endY}`}
					{@const isHighlighted =
						hoveredNodeId === edge.from.node.id ||
						hoveredNodeId === edge.to.node.id ||
						hoveredEdgeIndex === edgeIndex}
					<g
						class="edge {isInteracting ? '' : 'transition-opacity duration-150'}"
						style="opacity: {hoveredNodeId && !isHighlighted
							? 0.3
							: 1}; pointer-events: {isInteracting ? 'none' : 'auto'};"
						onmouseenter={() => {
							if (!dragNodeId) hoveredEdgeIndex = edgeIndex;
						}}
						onmouseleave={() => {
							if (!dragNodeId) hoveredEdgeIndex = null;
						}}
					>
						<!-- Invisible wider hit area for easier hover targeting -->
						<path
							d={pathD}
							fill="none"
							stroke="transparent"
							stroke-width="12"
							style="pointer-events: stroke"
						/>
						<path
							d={pathD}
							fill="none"
							stroke={edge.direction === 'out'
								? 'var(--accent)'
								: isHighlighted
									? 'var(--edge-in-strong)'
									: 'var(--edge-in)'}
							stroke-width={isHighlighted ? 3 : 2}
							marker-end={edge.direction === 'out'
								? isHighlighted
									? 'url(#arrow-out-highlight)'
									: 'url(#arrow-out)'
								: isHighlighted
									? 'url(#arrow-in-highlight)'
									: 'url(#arrow-in)'}
							class={isInteracting ? '' : 'transition-all duration-150'}
							style="pointer-events: none"
						/>
					</g>
				{/each}

				<!-- Edge labels (rendered after edges so they're on top, culled to viewport) -->
				{#if shouldShowEdgeLabels}
					{#each visibleEdges as { edge, index: edgeIndex } (edge.from.node.id + '|' + edge.to.node.id + '|' + edge.kind + '|label')}
						{@const isHighlighted =
							hoveredEdgeIndex === edgeIndex ||
							hoveredNodeId === edge.from.node.id ||
							hoveredNodeId === edge.to.node.id}
						{@const labelMetrics = getEdgeLabelMetrics(edge.kind, isHighlighted)}
						{@const labelPos = edgeLabelPositions[edgeIndex] ?? { x: 0, y: 0, anchor: 'middle' }}
						<g
							class={isInteracting ? '' : 'transition-opacity duration-150'}
							style="opacity: {hoveredNodeId && !isHighlighted ? 0.2 : 1}"
						>
							<rect
								x={labelPos.x - labelMetrics.width / 2}
								y={labelPos.y - labelMetrics.height / 2}
								width={labelMetrics.width}
								height={labelMetrics.height}
								fill="var(--panel-solid)"
								opacity={isHighlighted ? 0.95 : 0.82}
								rx="3"
								class={isInteracting ? '' : 'transition-all duration-150'}
							/>
							<text
								x={labelPos.x}
								y={labelPos.y}
								text-anchor={labelPos.anchor}
								dominant-baseline="middle"
								class="pointer-events-none {isInteracting
									? ''
									: 'transition-all duration-150'} {isHighlighted
									? 'fill-(--ink) text-[11px] font-medium'
									: 'fill-(--muted) text-[9px]'}"
							>
								{edge.kind}
							</text>
						</g>
					{/each}
				{/if}

				<!-- Nodes (culled to viewport) -->
				{#each visibleNodes as visNode (visNode.node.id)}
					{@const isHovered = hoveredNodeId === visNode.node.id}
					{@const isRelatedToHover = hoveredNeighborIds?.has(visNode.node.id) ?? false}
					{@const shouldDim = hoveredNodeId && !isHovered && !isRelatedToHover && !visNode.isCenter}
					{@const isDragging = dragNodeId === visNode.node.id}
					{@const visual = getNodeVisual(visNode.node.kind, visNode.isCenter)}
					{@const hoverScale = isHovered && !isDragging ? (isDotMode ? 1.18 : visNode.isCenter ? 1 : 1.06) : 1}
					{@const dotRadius = getDotRadius(visNode, isHovered, isRelatedToHover)}
					{@const hasHeader = visual.headerHeight > 0}
					{@const headerDividerY = -visual.height / 2 + visual.headerHeight}
					{@const bodyCenterY = headerDividerY + (visual.height - visual.headerHeight) / 2}
					{@const labelMetrics = getNodeLabelMetrics(visual.width, hasHeader, visNode.isCenter)}
					{@const nodeLabel = truncateName(visNode.node.name, labelMetrics.maxChars)}
					{@const compressLabel =
						estimateLabelWidth(nodeLabel, labelMetrics.fontSize) > labelMetrics.maxWidth}
					{@const link = nodeLink(visNode.node)}
					<a
						href={link.disabled
							? undefined
							: link.external
								? link.href
								: resolve(link.href as `/${string}`)}
						data-sveltekit-noscroll={link.disabled || link.external ? undefined : true}
						target={link.disabled || !link.external ? undefined : '_blank'}
						rel={link.disabled || !link.external ? undefined : 'noopener noreferrer'}
						aria-disabled={link.disabled ? true : undefined}
						tabindex={link.disabled ? -1 : undefined}
						onclick={(e) => handleNodeClick(visNode.node, e)}
					>
						<g
							class="node cursor-grab"
							class:cursor-grabbing={isDragging}
							data-node-id={visNode.node.id}
							data-node-kind={visNode.node.kind}
							style="transform: translate({visNode.x}px, {visNode.y}px) scale({hoverScale}); opacity: {shouldDim
								? 0.3
								: 1}; pointer-events: {isPanning ? 'none' : 'auto'};{isInteracting || isDragging
								? ''
								: ' transition: transform 150ms ease-out, opacity 150ms ease-out;'}"
							onmousedown={(e) => startNodeDrag(visNode, e)}
							onmouseenter={(e) => {
								if (!dragNodeId) {
									hoveredNodeId = visNode.node.id;
									showTooltip(visNode, e);
								}
							}}
							onmousemove={(e) => {
								if (!dragNodeId) showTooltip(visNode, e);
							}}
							onmouseleave={() => {
								if (!dragNodeId) {
									hoveredNodeId = null;
									hideTooltip();
								}
							}}
						>
							{#if isDotMode && !visNode.isCenter}
								{#if isHovered}
									<circle r={dotRadius + HOVER_RING} fill="var(--accent)" opacity="0.18" />
								{/if}
								<circle
									r={dotRadius}
									fill={kindColors[visNode.node.kind]}
									stroke={isHovered ? 'var(--accent)' : 'var(--panel-border)'}
									stroke-width={isHovered ? 2.25 : 1.25}
									opacity={isHovered || isRelatedToHover ? 1 : 0.88}
									class={isInteracting ? '' : 'transition-all duration-150'}
								/>
							{:else}
								<!-- Body fill -->
								<path d={visual.svgPath} fill={visual.fill} opacity="0.88" />
								<!-- Header fill (rect-like shapes only) -->
								{#if visual.headerPath}
									<path d={visual.headerPath} fill={visual.fill} opacity="0.96" />
									<line
										x1={-visual.width / 2 + 6}
										x2={visual.width / 2 - 6}
										y1={headerDividerY}
										y2={headerDividerY}
										stroke="var(--node-label-divider)"
										stroke-width="1"
									/>
								{/if}
								<!-- Stroke overlay -->
								<path
									d={visual.svgPath}
									fill="none"
									stroke-width={visual.strokeWidth}
									stroke-dasharray={visual.strokeDasharray ?? 'none'}
									class="{isInteracting ? '' : 'transition-all duration-150'} {visNode.isCenter ||
									isHovered
										? 'stroke-(--accent) stroke-[3px]'
										: ''}"
								/>
								<!-- Node name -->
								<text
									y={hasHeader
										? -visual.height / 2 + visual.headerHeight / 2
										: visNode.isCenter
											? -3
											: 0}
									text-anchor="middle"
									dominant-baseline="middle"
									textLength={compressLabel ? labelMetrics.maxWidth : null}
									lengthAdjust={compressLabel ? 'spacingAndGlyphs' : null}
									class="pointer-events-none fill-(--on-accent) font-medium {visNode.isCenter
										? 'text-sm'
										: 'text-[11px]'}"
								>
									{nodeLabel}
								</text>
								<!-- Kind label for header shapes or center node -->
								{#if hasHeader || visNode.isCenter}
									<text
										y={hasHeader ? bodyCenterY : 14}
										text-anchor="middle"
										class="pointer-events-none fill-(--on-accent) opacity-70 text-[10px]"
									>
										{visNode.node.kind}
									</text>
								{/if}
							{/if}
						</g>
					</a>
				{/each}

				<!-- Empty state hints -->
				{#if baseScene.nodes.length === 1}
					<text x={CENTER_X} y={CENTER_Y + 80} text-anchor="middle" class="fill-(--muted) text-sm">
						No direct relationships
					</text>
				{/if}
			</g>
		</svg>

		<!-- Tooltip -->
		{#if tooltipNode}
			{@const tooltipTraitMeta = projectedGraph.traitMetadataByNodeId.get(tooltipNode.node.id)}
			{@const tooltipIsSynthetic = projectedGraph.syntheticNodeIds.has(tooltipNode.node.id)}
			<div
				class="corner-squircle pointer-events-none absolute z-50 max-w-xs rounded-(--radius-popover) border border-(--panel-border) bg-(--panel-solid) px-3 py-2 text-sm shadow-lg"
				style="left: {tooltipX + 12}px; top: {tooltipY - 10}px; transform: translateY(-100%);"
			>
				<div class="font-medium text-(--ink)">{tooltipNode.node.name}</div>
				<div class="mt-0.5 text-xs text-(--muted)">{tooltipNode.node.id}</div>
				<div class="mt-1 flex items-center gap-2">
					<span
						class="inline-block size-2 rounded-full"
						style="background-color: {kindColors[tooltipNode.node.kind]}"
					></span>
					<span class="text-xs">{tooltipNode.node.kind}</span>
					{#if tooltipNode.node.visibility}
						<span class="text-xs text-(--muted)">• {tooltipNode.node.visibility}</span>
					{/if}
				</div>
				{#if tooltipTraitMeta && tooltipTraitMeta.traitCount > 0}
					<div class="mt-1 border-t border-(--panel-border) pt-1 text-xs text-(--muted)">
						Implements {tooltipTraitMeta.traitCount} trait{tooltipTraitMeta.traitCount === 1
							? ''
							: 's'}
					</div>
				{/if}
				{#if tooltipIsSynthetic}
					<div class="mt-1 border-t border-(--panel-border) pt-1 text-xs text-(--muted)">
						Projection summary node
					</div>
				{/if}
				{#if tooltipNode.edgeKind && !tooltipNode.isCenter}
					<div class="mt-1 border-t border-(--panel-border) pt-1 text-xs text-(--muted)">
						{tooltipNode.direction === 'in' ? '→' : '←'}
						{tooltipNode.edgeKind}
					</div>
				{/if}
				{#if tooltipNode.node.signature}
					<div
						class="mt-1 truncate border-t border-(--panel-border) pt-1 text-xs font-(--font-code) text-(--muted)"
					>
						{tooltipNode.node.signature}
					</div>
				{/if}
			</div>
		{/if}
	</div>
</div>
