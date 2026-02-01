<script lang="ts">
  import type { Graph, Node } from '$lib/graph';
  import type { LayoutMode, VisEdge, VisNode } from '$lib/graph-layout';
  import { kindColors } from '$lib/tree-constants';
  import { KeyedMemo, keyEqual, keyOf } from '$lib/reactivity.svelte';
  import {
    CENTER_X,
    CENTER_Y,
    LAYOUT_HEIGHT,
    LAYOUT_WIDTH,
    getEdgeAnchor,
    getNodeDimensions
  } from '$lib/graph-layout';
  import {
    buildBaseScene,
    buildNodeMap,
    computeSceneLabels,
  } from '$lib/renderers/graph';
  import { perf } from '$lib/perf';

  let {
    graph,
    selected,
    getNodeUrl,
    layoutMode = 'ego',
    showStructural = false,
    showSemantic = true,
    onToggleStructural,
    onToggleSemantic
  } = $props<{
    graph: Graph;
    selected: Node;
    getNodeUrl: (id: string) => string;
    layoutMode?: LayoutMode;
    showStructural?: boolean;
    showSemantic?: boolean;
    onToggleStructural?: () => void;
    onToggleSemantic?: () => void;
  }>();

  type DragOffset = { x: number; y: number };

  const WIDTH = LAYOUT_WIDTH;
  const HEIGHT = LAYOUT_HEIGHT;
  const RECT_CORNER_RADIUS = 10;
  const HEADER_HEIGHT = 18;
  const GRID_SIZE = 32;
  const EDGE_NODE_PADDING = 10;
  const HOVER_RING = 4;
  const LABEL_CHAR_RATIO = 0.6;

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
  let dragOffsets = $state.raw<Record<string, DragOffset>>({});
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
    if (e.button === 0) { // Left click
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
    isPanning = false;
    if (!dragNodeId) {
      isInteracting = false;
    }
    tooltipNode = null;
  }

  function resetView() {
    zoom = 1;
    panX = 0;
    panY = 0;
    dragOffsets = {};
  }

  function zoomIn() {
    zoom = Math.min(MAX_ZOOM, zoom * 1.2);
  }

  function zoomOut() {
    zoom = Math.max(MIN_ZOOM, zoom / 1.2);
  }

  /** Convert screen (clientX/Y) to SVG viewBox coordinates using native SVG APIs. */
  function screenToSvg(clientX: number, clientY: number): DOMPoint {
    if (!svgEl) return new DOMPoint(0, 0);
    const ctm = svgEl.getScreenCTM();
    if (!ctm) return new DOMPoint(0, 0);
    return new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
  }

  /** Convert screen mouse coords to world (scene) coordinates, accounting for pan & zoom. */
  function getWorldPoint(e: MouseEvent): { x: number; y: number } {
    const svg = screenToSvg(e.clientX, e.clientY);
    return {
      x: (svg.x - panX) / zoom,
      y: (svg.y - panY) / zoom
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
    const offset = dragOffsets[visNode.node.id] ?? { x: 0, y: 0 };
    dragBasePos = { x: visNode.x - offset.x, y: visNode.y - offset.y };
  }

  function updateNodeDrag(e: MouseEvent) {
    if (!dragNodeId) return;
    perf.frame('interact', 'dragFrame', () => {
      // Screen-space threshold (5px) — consistent across zoom levels, like Excalidraw
      if (!didDrag && Math.hypot(e.clientX - dragStartScreen.x, e.clientY - dragStartScreen.y) > 5) {
        didDrag = true;
      }
      if (!didDrag) return;
      const world = getWorldPoint(e);
      const dx = world.x - dragStart.x;
      const dy = world.y - dragStart.y;
      const nextX = dragNodeStart.x + dx;
      const nextY = dragNodeStart.y + dy;
      dragOffsets = {
        ...dragOffsets,
        [dragNodeId!]: { x: nextX - dragBasePos.x, y: nextY - dragBasePos.y }
      };
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

  function handleGlobalMouseMove(e: MouseEvent) {
    if (dragNodeId) {
      updateNodeDrag(e);
    }
  }

  function handleGlobalMouseUp() {
    if (dragNodeId) {
      endNodeDrag();
    }
  }

  function showTooltip(visNode: VisNode, e: MouseEvent) {
    tooltipNode = visNode;
    const rect = (e.currentTarget as HTMLElement).closest('.graph-container')?.getBoundingClientRect();
    if (rect) {
      tooltipX = e.clientX - rect.left;
      tooltipY = e.clientY - rect.top;
    }
  }

  function hideTooltip() {
    tooltipNode = null;
  }

  const edgeColors: Record<string, string> = {
    Contains: '#94a3b8',
    Defines: '#64748b',
    UsesType: '#3b82f6',
    Implements: '#10b981',
    CallsStatic: '#f43f5e',
    CallsRuntime: '#ec4899',
    Derives: '#8b5cf6'
  };

  function getNodeLabelMetrics(nodeWidth: number, isRect: boolean, isCenter: boolean): {
    maxChars: number;
    maxWidth: number;
    fontSize: number;
  } {
    const fontSize = isCenter ? 14 : 11;
    const padding = isRect ? 20 : (isCenter ? 16 : 12);
    const maxWidth = Math.max(24, nodeWidth - padding);
    const maxChars = Math.max(4, Math.floor(maxWidth / (fontSize * LABEL_CHAR_RATIO)));
    return { maxChars, maxWidth, fontSize };
  }

  function estimateLabelWidth(label: string, fontSize: number): number {
    return label.length * fontSize * LABEL_CHAR_RATIO;
  }

  function getEdgeLabelMetrics(kind: string, isHighlighted: boolean): {
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

  // Stage 1: base scene (layout + similarity groups). Cached behind KeyedMemo.
  const baseSceneMemo = new KeyedMemo(
    () => keyOf(graph, selected.id, layoutMode, showStructural, showSemantic),
    () => perf.time('derived', 'baseScene', () => buildBaseScene(graph, selected, layoutMode, { showStructural, showSemantic }), { threshold: 5 }),
    { equalsKey: keyEqual }
  );
  let baseScene = $derived(baseSceneMemo.current);

  let positionedNodes = $derived.by(() => {
    return perf.frame('derived', 'positionedNodes', () =>
      baseScene.nodes.map((node) => {
        const offset = dragOffsets[node.node.id];
        if (!offset) return node;
        return { ...node, x: node.x + offset.x, y: node.y + offset.y };
      })
    );
  });

  let positionedNodeMap = $derived.by(() => perf.frame('derived', 'positionedNodeMap', () => buildNodeMap(positionedNodes)));

  // Viewport culling — only render nodes/edges visible in the current view
  const CULL_MARGIN = 100; // px margin around viewport for labels
  let visibleBounds = $derived.by(() => ({
    minX: -panX / zoom - CULL_MARGIN,
    minY: -panY / zoom - CULL_MARGIN,
    maxX: (-panX + WIDTH) / zoom + CULL_MARGIN,
    maxY: (-panY + HEIGHT) / zoom + CULL_MARGIN,
  }));

  function isNodeVisible(node: VisNode): boolean {
    const dims = getNodeDimensions(node.node, node.isCenter);
    const hw = dims.width / 2;
    const hh = dims.height / 2;
    return (
      node.x + hw >= visibleBounds.minX &&
      node.x - hw <= visibleBounds.maxX &&
      node.y + hh >= visibleBounds.minY &&
      node.y - hh <= visibleBounds.maxY
    );
  }

  let visibleNodeIds = $derived.by(() => {
    return perf.frame('derived', 'visibleNodeIds', () => {
      const ids = new Set<string>();
      for (const node of positionedNodes) {
        if (isNodeVisible(node)) ids.add(node.node.id);
      }
      return ids;
    });
  });

  let visibleNodes = $derived(positionedNodes.filter(n => visibleNodeIds.has(n.node.id)));

  let visibleEdges = $derived.by(() => {
    return perf.frame('derived', 'visibleEdges', () =>
      baseScene.edges
        .map((edge, i) => ({ edge, index: i }))
        .filter(({ edge }) => {
          const fromNode = positionedNodeMap.get(edge.from.node.id) ?? edge.from;
          const toNode = positionedNodeMap.get(edge.to.node.id) ?? edge.to;
          if (visibleNodeIds.has(edge.from.node.id) || visibleNodeIds.has(edge.to.node.id)) return true;
          const minX = Math.min(fromNode.x, toNode.x);
          const maxX = Math.max(fromNode.x, toNode.x);
          const minY = Math.min(fromNode.y, toNode.y);
          const maxY = Math.max(fromNode.y, toNode.y);
          return !(maxX < visibleBounds.minX || minX > visibleBounds.maxX ||
                   maxY < visibleBounds.minY || minY > visibleBounds.maxY);
        })
    );
  });

  let hoveredNeighborIds = $derived.by(() => {
    if (!hoveredNodeId) return null;
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

  function nodeLink(node: Node): { href: string; external: boolean } {
    if (node.is_external) {
      return { href: docsUrlForNode(node.id), external: true };
    }
    return { href: getNodeUrl(node.id), external: false };
  }

  // Stage 2: label positions. Recomputes with drag-aware positions (cheap).
  let edgeLabelPositions = $derived.by(() => {
    return perf.frame('derived', 'edgeLabelPositions', () =>
      computeSceneLabels(
        baseScene,
        positionedNodeMap,
        (kind) => getEdgeLabelMetrics(kind, false)
      )
    );
  });
</script>

<svelte:window onmousemove={handleGlobalMouseMove} onmouseup={handleGlobalMouseUp} />

<div class="rounded-[var(--radius-card)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel-solid)] overflow-hidden">
  <div class="border-b border-[var(--panel-border)] bg-[var(--panel)] px-4 py-2 flex items-center justify-between flex-wrap gap-2">
    <div class="flex items-center gap-3">
      <span class="text-sm font-medium text-[var(--ink)]">Relationship Graph</span>
      <!-- Edge count indicator -->
      <span class="text-xs text-[var(--muted)]">
        {baseScene.edges.length} edges
      </span>
    </div>
    <div class="flex items-center gap-4 flex-wrap">
      <!-- Edge type filters -->
      <div class="flex items-center gap-1">
        <button
          type="button"
          onclick={() => onToggleStructural?.()}
          class="px-2 py-1 text-xs rounded-[var(--radius-control)] corner-squircle border transition-colors {showStructural
            ? 'bg-[var(--accent)] text-white border-[var(--accent)]'
            : 'bg-[var(--panel-solid)] text-[var(--muted)] border-[var(--panel-border)] hover:bg-[var(--panel-strong)]'}"
          title="Show structural edges (Contains, Defines)"
        >
          Structure
        </button>
        <button
          type="button"
          onclick={() => onToggleSemantic?.()}
          class="px-2 py-1 text-xs rounded-[var(--radius-control)] corner-squircle border transition-colors {showSemantic
            ? 'bg-[var(--accent)] text-white border-[var(--accent)]'
            : 'bg-[var(--panel-solid)] text-[var(--muted)] border-[var(--panel-border)] hover:bg-[var(--panel-strong)]'}"
          title="Show semantic edges (UsesType, Implements, Calls, Derives)"
        >
          Semantic
        </button>
      </div>
      <!-- Zoom controls -->
      <div class="flex items-center gap-1">
        <button
          type="button"
          onclick={zoomOut}
          class="w-6 h-6 flex items-center justify-center rounded-[var(--radius-control)] corner-squircle bg-[var(--panel-solid)] border border-[var(--panel-border)] text-[var(--muted)] hover:bg-[var(--panel-strong)] text-sm"
          title="Zoom out"
        >−</button>
        <span class="text-xs text-[var(--muted)] w-12 text-center">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          onclick={zoomIn}
          class="w-6 h-6 flex items-center justify-center rounded-[var(--radius-control)] corner-squircle bg-[var(--panel-solid)] border border-[var(--panel-border)] text-[var(--muted)] hover:bg-[var(--panel-strong)] text-sm"
          title="Zoom in"
        >+</button>
        <button
          type="button"
          onclick={resetView}
          class="ml-1 px-2 h-6 flex items-center justify-center rounded-[var(--radius-control)] corner-squircle bg-[var(--panel-solid)] border border-[var(--panel-border)] text-[var(--muted)] hover:bg-[var(--panel-strong)] text-xs"
          title="Reset view"
        >Reset</button>
      </div>
      <div class="flex items-center gap-4 text-xs text-[var(--muted)]">
        <span class="flex items-center gap-1">
          <span class="inline-block w-3 h-0.5 bg-[var(--muted)]"></span>
          Incoming
        </span>
        <span class="flex items-center gap-1">
          <span class="inline-block w-3 h-0.5 bg-[var(--accent)]"></span>
          Outgoing
        </span>
      </div>
    </div>
  </div>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    {@attach captureContainer}
    class="graph-container relative select-none h-[500px]"
    style="cursor: {isPanning ? 'grabbing' : 'grab'};"
    onwheel={handleWheel}
    onmousedown={handleMouseDown}
    onmousemove={handleMouseMove}
    onmouseup={handleMouseUp}
    onmouseleave={handleMouseLeave}
  >
    <svg bind:this={svgEl} viewBox="0 0 {WIDTH} {HEIGHT}" class="w-full h-full" preserveAspectRatio="xMidYMid slice">
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
    <g transform="translate({panX}, {panY}) scale({zoom})">
      <!-- Edges (culled to viewport, with invisible hit areas for easier hovering) -->
    {#each visibleEdges as { edge, index: edgeIndex } (edge.from.node.id + '|' + edge.to.node.id + '|' + edge.kind)}
      {@const fromNode = positionedNodeMap.get(edge.from.node.id) ?? edge.from}
      {@const toNode = positionedNodeMap.get(edge.to.node.id) ?? edge.to}
      {@const startAnchor = getEdgeAnchor(fromNode, toNode)}
      {@const endAnchor = getEdgeAnchor(toNode, fromNode)}
      {@const dx = endAnchor.x - startAnchor.x}
      {@const dy = endAnchor.y - startAnchor.y}
      {@const len = Math.hypot(dx, dy) || 1}
      {@const startX = startAnchor.x}
      {@const startY = startAnchor.y}
      {@const endX = endAnchor.x - (dx / len) * EDGE_NODE_PADDING}
      {@const endY = endAnchor.y - (dy / len) * EDGE_NODE_PADDING}
      {@const pathD = `M ${startX} ${startY} L ${endX} ${endY}`}
      {@const isHighlighted = hoveredNodeId === edge.from.node.id || hoveredNodeId === edge.to.node.id || hoveredEdgeIndex === edgeIndex}
      <g
        class="edge {isInteracting ? '' : 'transition-opacity duration-150'}"
        style="opacity: {hoveredNodeId && !isHighlighted ? 0.3 : 1}"
        onmouseenter={() => { if (!dragNodeId) hoveredEdgeIndex = edgeIndex; }}
        onmouseleave={() => { if (!dragNodeId) hoveredEdgeIndex = null; }}
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
            : (isHighlighted ? 'var(--edge-in-strong)' : 'var(--edge-in)')}
          stroke-width={isHighlighted ? 3 : 2}
          marker-end={edge.direction === 'out'
            ? (isHighlighted ? 'url(#arrow-out-highlight)' : 'url(#arrow-out)')
            : (isHighlighted ? 'url(#arrow-in-highlight)' : 'url(#arrow-in)')}
          class={isInteracting ? '' : 'transition-all duration-150'}
          style="pointer-events: none"
        />
      </g>
    {/each}

    <!-- Edge labels (rendered after edges so they're on top, culled to viewport) -->
    {#each visibleEdges as { edge, index: edgeIndex } (edge.from.node.id + '|' + edge.to.node.id + '|' + edge.kind + '|label')}
      {@const isHighlighted = hoveredEdgeIndex === edgeIndex ||
        hoveredNodeId === edge.from.node.id ||
        hoveredNodeId === edge.to.node.id}
      {@const labelMetrics = getEdgeLabelMetrics(edge.kind, isHighlighted)}
      {@const labelPos = edgeLabelPositions[edgeIndex] ?? { x: 0, y: 0, anchor: 'middle' }}
      <g
        class="{isInteracting ? '' : 'transition-opacity duration-150'}"
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
          class="pointer-events-none {isInteracting ? '' : 'transition-all duration-150'} {isHighlighted
            ? 'text-[11px] font-medium fill-[var(--ink)]'
            : 'text-[9px] fill-[var(--muted)]'}"
        >
          {edge.kind}
        </text>
      </g>
    {/each}

    <!-- Nodes (culled to viewport) -->
    {#each visibleNodes as visNode (visNode.node.id)}
      {@const isHovered = hoveredNodeId === visNode.node.id}
      {@const isRelatedToHover = hoveredNeighborIds?.has(visNode.node.id) ?? false}
      {@const shouldDim = hoveredNodeId && !isHovered && !isRelatedToHover && !visNode.isCenter}
      {@const isDragging = dragNodeId === visNode.node.id}
      {@const dims = getNodeDimensions(visNode.node, visNode.isCenter)}
      {@const hoverScale = isHovered && !visNode.isCenter && !isDragging ? 1.06 : 1}
      {@const nodeWidth = dims.width}
      {@const nodeHeight = dims.height}
      {@const cornerRadius = RECT_CORNER_RADIUS}
      {@const headerHeight = dims.isRect
        ? Math.min(HEADER_HEIGHT + (visNode.isCenter ? 2 : 0), nodeHeight - 12)
        : Math.min(HEADER_HEIGHT, nodeHeight)}
      {@const rectX = -nodeWidth / 2}
      {@const rectY = -nodeHeight / 2}
      {@const headerRadius = Math.min(cornerRadius, headerHeight)}
      {@const headerDividerY = rectY + headerHeight}
      {@const bodyCenterY = headerDividerY + (nodeHeight - headerHeight) / 2}
      {@const headerPath = dims.isRect
        ? `M ${rectX + headerRadius} ${rectY} H ${rectX + nodeWidth - headerRadius} A ${headerRadius} ${headerRadius} 0 0 1 ${rectX + nodeWidth} ${rectY + headerRadius} V ${headerDividerY} H ${rectX} V ${rectY + headerRadius} A ${headerRadius} ${headerRadius} 0 0 1 ${rectX + headerRadius} ${rectY} Z`
        : ''}
      {@const radius = nodeWidth / 2}
      {@const labelMetrics = getNodeLabelMetrics(nodeWidth, dims.isRect, visNode.isCenter)}
      {@const nodeLabel = truncateName(visNode.node.name, labelMetrics.maxChars)}
      {@const compressLabel = estimateLabelWidth(nodeLabel, labelMetrics.fontSize) > labelMetrics.maxWidth}
      {@const link = nodeLink(visNode.node)}
      <a
        href={link.href}
        data-sveltekit-noscroll={link.external ? undefined : true}
        target={link.external ? '_blank' : undefined}
        rel={link.external ? 'noopener noreferrer' : undefined}
      >
      <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
      <g
        class="node cursor-grab"
        class:cursor-grabbing={isDragging}
        style="transform: translate({visNode.x}px, {visNode.y}px) scale({hoverScale}); opacity: {shouldDim ? 0.3 : 1};{isInteracting || isDragging ? '' : ' transition: transform 150ms ease-out, opacity 150ms ease-out;'}"
        onmousedown={(e) => startNodeDrag(visNode, e)}
        onclick={(e) => handleNodeClick(visNode.node, e)}
        onmouseenter={(e) => { if (!dragNodeId) { hoveredNodeId = visNode.node.id; showTooltip(visNode, e); } }}
        onmousemove={(e) => { if (!dragNodeId) showTooltip(visNode, e); }}
        onmouseleave={() => { if (!dragNodeId) { hoveredNodeId = null; hideTooltip(); } }}
      >
        {#if dims.isRect}
          <!-- Body fill -->
          <rect
            x={rectX}
            y={rectY}
            width={nodeWidth}
            height={nodeHeight}
            rx={cornerRadius}
            fill={kindColors[visNode.node.kind]}
            opacity="0.88"
          />
          <!-- Header fill -->
          <path d={headerPath} fill={kindColors[visNode.node.kind]} opacity="0.96" />
          <!-- Divider line -->
          <line
            x1={rectX + 6}
            x2={rectX + nodeWidth - 6}
            y1={headerDividerY}
            y2={headerDividerY}
            stroke="rgba(255,255,255,0.25)"
            stroke-width="1"
          />
          <!-- Stroke overlay -->
          <rect
            x={rectX}
            y={rectY}
            width={nodeWidth}
            height={nodeHeight}
            rx={cornerRadius}
            fill="none"
            class="{isInteracting ? '' : 'transition-all duration-150'} {visNode.isCenter || isHovered
              ? 'stroke-[var(--accent)] stroke-[3px]'
              : ''}"
          />
        {:else}
          <circle
            r={radius}
            fill={kindColors[visNode.node.kind]}
            class="{isInteracting ? '' : 'transition-all duration-150'} {visNode.isCenter || isHovered
              ? 'stroke-[var(--accent)] stroke-[3px]'
              : ''}"
          />
        {/if}
        <!-- Node name -->
        <text
          y={dims.isRect ? rectY + headerHeight / 2 : (visNode.isCenter ? -3 : 0)}
          text-anchor="middle"
          dominant-baseline="middle"
          textLength={compressLabel ? labelMetrics.maxWidth : null}
          lengthAdjust={compressLabel ? 'spacingAndGlyphs' : null}
          class="fill-white font-medium pointer-events-none {visNode.isCenter ? 'text-sm' : 'text-[11px]'}"
        >
          {nodeLabel}
        </text>
        <!-- Kind label for center node -->
        {#if dims.isRect || visNode.isCenter}
          <text
            y={dims.isRect ? bodyCenterY : 14}
            text-anchor="middle"
            class="fill-white/70 text-[10px] pointer-events-none"
          >
            {visNode.node.kind}
          </text>
        {/if}
      </g>
      </a>
    {/each}


    <!-- Empty state hints -->
    {#if baseScene.nodes.length === 1}
      <text x={CENTER_X} y={CENTER_Y + 80} text-anchor="middle" class="fill-[var(--muted)] text-sm">
        No direct relationships
      </text>
    {/if}
      </g>
    </svg>

    <!-- Tooltip -->
    {#if tooltipNode}
      <div
        class="absolute pointer-events-none z-50 px-3 py-2 rounded-[var(--radius-popover)] corner-squircle shadow-lg border border-[var(--panel-border)] bg-[var(--panel-solid)] text-sm max-w-xs"
        style="left: {tooltipX + 12}px; top: {tooltipY - 10}px; transform: translateY(-100%);"
      >
        <div class="font-medium text-[var(--ink)]">{tooltipNode.node.name}</div>
        <div class="text-xs text-[var(--muted)] mt-0.5">{tooltipNode.node.id}</div>
        <div class="flex items-center gap-2 mt-1">
          <span
            class="inline-block w-2 h-2 rounded-full"
            style="background-color: {kindColors[tooltipNode.node.kind]}"
          ></span>
          <span class="text-xs">{tooltipNode.node.kind}</span>
          {#if tooltipNode.node.visibility}
            <span class="text-xs text-[var(--muted)]">• {tooltipNode.node.visibility}</span>
          {/if}
        </div>
        {#if tooltipNode.edgeKind && !tooltipNode.isCenter}
          <div class="text-xs text-[var(--muted)] mt-1 pt-1 border-t border-[var(--panel-border)]">
            {tooltipNode.direction === 'in' ? '→' : '←'} {tooltipNode.edgeKind}
          </div>
        {/if}
        {#if tooltipNode.node.signature}
          <div class="text-xs font-[var(--font-code)] text-[var(--muted)] mt-1 pt-1 border-t border-[var(--panel-border)] truncate">
            {tooltipNode.node.signature}
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>
