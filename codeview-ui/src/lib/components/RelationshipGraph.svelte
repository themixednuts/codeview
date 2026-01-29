<script lang="ts">
  import type { Edge, EdgeKind, Graph, Node, NodeKind } from '$lib/graph';
  import type { LayoutMode, VisEdge, VisNode } from '$lib/graph-layout';
  import { kindColors } from '$lib/tree-constants';
  import { Memo, KeyedMemo, keyEqual, keyOf } from '$lib/reactivity.svelte';
  import {
    CENTER_X,
    CENTER_Y,
    LAYOUT_HEIGHT,
    LAYOUT_WIDTH,
    computeLayout,
    getEdgeAnchor,
    getNodeDimensions
  } from '$lib/graph-layout';
  // Note: Use plain Map/Set for temporary computation to avoid proxy overhead
  // SvelteMap/SvelteSet should only be used for persistent reactive state

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

  // Edge filtering - categorize edges as structural or semantic
  const structuralEdgeKinds: EdgeKind[] = ['Contains', 'Defines'];
  const semanticEdgeKinds: EdgeKind[] = ['UsesType', 'Implements', 'CallsStatic', 'CallsRuntime', 'Derives'];

  // Filter edges before layout
  const filteredEdgesMemo = new Memo(() => {
    return graph.edges.filter((edge: Edge) => {
      if (structuralEdgeKinds.includes(edge.kind)) {
        return showStructural;
      }
      if (semanticEdgeKinds.includes(edge.kind)) {
        return showSemantic;
      }
      return true; // Unknown edge kinds default to visible
    });
  });
  let filteredEdges = $derived(filteredEdgesMemo.current);

  // Create filtered graph for layout
  const filteredGraphMemo = new Memo(() => ({
    nodes: graph.nodes,
    edges: filteredEdges
  }));
  let filteredGraph = $derived(filteredGraphMemo.current);

  // Edge counts for UI display
  const edgeCountsMemo = new Memo(() => {
    const structural = graph.edges.filter((e: Edge) => structuralEdgeKinds.includes(e.kind)).length;
    const semantic = graph.edges.filter((e: Edge) => semanticEdgeKinds.includes(e.kind)).length;
    const total = graph.edges.length;
    const visible = filteredEdges.length;
    return { structural, semantic, total, visible };
  });
  let edgeCounts = $derived(edgeCountsMemo.current);

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

  let containerEl = $state<HTMLDivElement | null>(null);
  let dragNodeId = $state<string | null>(null);
  let dragOffsets = $state<Record<string, DragOffset>>({});
  let dragStart = { x: 0, y: 0 };
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

    // Zoom toward mouse position
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Convert mouse position to SVG coordinates
    const svgX = (mouseX / rect.width) * WIDTH;
    const svgY = (mouseY / rect.height) * HEIGHT;

    // Adjust pan to zoom toward mouse
    const zoomRatio = newZoom / zoom;
    panX = svgX - (svgX - panX) * zoomRatio;
    panY = svgY - (svgY - panY) * zoomRatio;

    zoom = newZoom;
  }

  function handleMouseDown(e: MouseEvent) {
    if (e.button === 0) { // Left click
      isPanning = true;
      panStartX = e.clientX;
      panStartY = e.clientY;
      panStartPanX = panX;
      panStartPanY = panY;
    }
  }

  function handleMouseMove(e: MouseEvent) {
    if (dragNodeId) return;
    if (isPanning) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const dx = (e.clientX - panStartX) * (WIDTH / rect.width) / zoom;
      const dy = (e.clientY - panStartY) * (HEIGHT / rect.height) / zoom;
      panX = panStartPanX + dx;
      panY = panStartPanY + dy;
    }
  }

  function handleMouseUp() {
    isPanning = false;
    endNodeDrag();
  }

  function handleMouseLeave() {
    isPanning = false;
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

  function getWorldPoint(e: MouseEvent): { x: number; y: number } {
    if (!containerEl) return { x: 0, y: 0 };
    const rect = containerEl.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * WIDTH;
    const svgY = ((e.clientY - rect.top) / rect.height) * HEIGHT;
    return {
      x: (svgX - panX) / zoom,
      y: (svgY - panY) / zoom
    };
  }

  function startNodeDrag(visNode: VisNode, e: MouseEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    dragNodeId = visNode.node.id;
    didDrag = false;
    dragStart = getWorldPoint(e);
    dragNodeStart = { x: visNode.x, y: visNode.y };
    const offset = dragOffsets[visNode.node.id] ?? { x: 0, y: 0 };
    dragBasePos = { x: visNode.x - offset.x, y: visNode.y - offset.y };
  }

  function updateNodeDrag(e: MouseEvent) {
    if (!dragNodeId) return;
    const world = getWorldPoint(e);
    const dx = world.x - dragStart.x;
    const dy = world.y - dragStart.y;
    if (!didDrag && Math.hypot(dx, dy) > 2) {
      didDrag = true;
    }
    if (!didDrag) return;
    const nextX = dragNodeStart.x + dx;
    const nextY = dragNodeStart.y + dy;
    dragOffsets = {
      ...dragOffsets,
      [dragNodeId]: { x: nextX - dragBasePos.x, y: nextY - dragBasePos.y }
    };
  }

  function endNodeDrag() {
    if (dragNodeId && didDrag) {
      suppressClick = true;
    }
    dragNodeId = null;
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

  const visDataMemo = new KeyedMemo(
    () => keyOf(filteredGraph, selected.id, layoutMode),
    () => {
      const t0 = performance.now();
      const result = computeLayout(filteredGraph, selected, layoutMode);
      const dt = performance.now() - t0;
      if (dt > 5) console.log(`[perf:derived] visData ${dt.toFixed(1)}ms`);
      return result;
    },
    { equalsKey: keyEqual }
  );
  let visData = $derived(visDataMemo.current);

  let layoutNodes = $derived.by(() => visData.nodes);

  let positionedNodes = $derived.by(() => {
    return layoutNodes.map((node) => {
      const offset = dragOffsets[node.node.id];
      if (!offset) return node;
      return { ...node, x: node.x + offset.x, y: node.y + offset.y };
    });
  });

  let positionedNodeMap = $derived.by(() => {
    const map = new Map<string, VisNode>();
    for (const node of positionedNodes) {
      map.set(node.node.id, node);
    }
    return map;
  });

  let hoveredNeighborIds = $derived.by(() => {
    if (!hoveredNodeId) return null;
    const neighbors = new Set<string>();
    for (const edge of visData.edges) {
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

  // Precompute edge angle similarity groups (O(e log e) instead of O(e²))
  let edgeSimilarityGroups = $derived.by(() => {
    const t0 = performance.now();
    const edges = visData.edges;
    if (edges.length === 0) return new Map<number, { group: number[]; indexOf: number }>();

    // Compute angle + direction for each edge
    type EdgeAngle = { index: number; angle: number; direction: string };
    const edgeAngles: EdgeAngle[] = edges.map((edge, i) => {
      const fromNode = positionedNodeMap.get(edge.from.node.id) ?? edge.from;
      const toNode = positionedNodeMap.get(edge.to.node.id) ?? edge.to;
      const dx = toNode.x - fromNode.x;
      const dy = toNode.y - fromNode.y;
      return { index: i, angle: Math.atan2(dy, dx), direction: edge.direction };
    });

    // Sort by direction then angle for efficient grouping
    const sorted = [...edgeAngles].sort((a, b) => {
      if (a.direction !== b.direction) return a.direction < b.direction ? -1 : 1;
      return a.angle - b.angle;
    });

    // Group edges with similar angles (within 0.35 radians) and same direction
    const result = new Map<number, { group: number[]; indexOf: number }>();
    let groupStart = 0;
    while (groupStart < sorted.length) {
      const group: number[] = [sorted[groupStart].index];
      let groupEnd = groupStart + 1;
      while (groupEnd < sorted.length
        && sorted[groupEnd].direction === sorted[groupStart].direction
        && Math.abs(sorted[groupEnd].angle - sorted[groupStart].angle) < 0.35
      ) {
        group.push(sorted[groupEnd].index);
        groupEnd++;
      }
      for (let k = 0; k < group.length; k++) {
        result.set(group[k], { group, indexOf: k });
      }
      groupStart = groupEnd;
    }

    const dt = performance.now() - t0;
    if (dt > 2) console.log(`[perf:derived] edgeSimilarityGroups ${dt.toFixed(1)}ms (${edges.length} edges)`);
    return result;
  });

  // Calculate label position for an edge using precomputed groups
  function getLabelPosition(
    edge: VisEdge,
    edgeIndex: number,
    labelWidth: number
  ): { x: number; y: number; anchor: string } {
    const fromNode = positionedNodeMap.get(edge.from.node.id) ?? edge.from;
    const toNode = positionedNodeMap.get(edge.to.node.id) ?? edge.to;

    const startAnchor = getEdgeAnchor(fromNode, toNode);
    const endAnchor = getEdgeAnchor(toNode, fromNode);
    const edgeDx = endAnchor.x - startAnchor.x;
    const edgeDy = endAnchor.y - startAnchor.y;
    const len = Math.hypot(edgeDx, edgeDy);

    if (len === 0) {
      return { x: fromNode.x, y: fromNode.y, anchor: 'middle' };
    }

    const inset = Math.min(EDGE_NODE_PADDING, len * 0.35);
    const startX = startAnchor.x + (edgeDx / len) * inset;
    const startY = startAnchor.y + (edgeDy / len) * inset;
    const endX = endAnchor.x - (edgeDx / len) * inset;
    const endY = endAnchor.y - (edgeDy / len) * inset;

    let midX = (startX + endX) / 2;
    let midY = (startY + endY) / 2;

    const perpX = -edgeDy / len;
    const perpY = edgeDx / len;

    const similarity = edgeSimilarityGroups.get(edgeIndex);
    const lineGap = Math.hypot(endX - startX, endY - startY);
    const sizePenalty = Math.max(0, (labelWidth - lineGap) * 0.25);
    const baseOffset = 10 + sizePenalty;
    let crowdOffset = 0;
    if (similarity && similarity.group.length > 1) {
      crowdOffset = (similarity.indexOf - (similarity.group.length - 1) / 2) * 14;
    }

    midX += perpX * (baseOffset + crowdOffset);
    midY += perpY * (baseOffset + crowdOffset);

    return { x: midX, y: midY, anchor: 'middle' };
  }
</script>

<svelte:window onmousemove={handleGlobalMouseMove} onmouseup={handleGlobalMouseUp} />

<div class="rounded-[var(--radius-card)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel-solid)] overflow-hidden">
  <div class="border-b border-[var(--panel-border)] bg-[var(--panel)] px-4 py-2 flex items-center justify-between flex-wrap gap-2">
    <div class="flex items-center gap-3">
      <span class="text-sm font-medium text-[var(--ink)]">Relationship Graph</span>
      <!-- Edge count indicator -->
      <span class="text-xs text-[var(--muted)]">
        {visData.edges.length} edges
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
    <svg viewBox="0 0 {WIDTH} {HEIGHT}" class="w-full h-full" preserveAspectRatio="xMidYMid slice">
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
      <!-- Edges (non-highlighted first, then highlighted on top) -->
    {#each visData.edges as edge, edgeIndex (edge.from.node.id + '|' + edge.to.node.id + '|' + edge.kind)}
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
        class="edge transition-opacity duration-150"
        style="opacity: {hoveredNodeId && !isHighlighted ? 0.3 : 1}"
        onmouseenter={() => hoveredEdgeIndex = edgeIndex}
        onmouseleave={() => hoveredEdgeIndex = null}
      >
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
          class="transition-all duration-150"
        />
      </g>
    {/each}

    <!-- Edge labels (rendered after edges so they're on top) -->
    {#each visData.edges as edge, edgeIndex (edge.from.node.id + '|' + edge.to.node.id + '|' + edge.kind + '|label')}
      {@const isHighlighted = hoveredEdgeIndex === edgeIndex ||
        hoveredNodeId === edge.from.node.id ||
        hoveredNodeId === edge.to.node.id}
      {@const labelMetrics = getEdgeLabelMetrics(edge.kind, isHighlighted)}
      {@const labelPos = getLabelPosition(edge, edgeIndex, labelMetrics.width)}
      <g
        class="transition-opacity duration-150"
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
          class="transition-all duration-150"
        />
        <text
          x={labelPos.x}
          y={labelPos.y}
          text-anchor={labelPos.anchor}
          dominant-baseline="middle"
          class="pointer-events-none transition-all duration-150 {isHighlighted
            ? 'text-[11px] font-medium fill-[var(--ink)]'
            : 'text-[9px] fill-[var(--muted)]'}"
        >
          {edge.kind}
        </text>
      </g>
    {/each}

    <!-- Nodes -->
    {#each positionedNodes as visNode (visNode.node.id)}
      {@const isHovered = hoveredNodeId === visNode.node.id}
      {@const isRelatedToHover = hoveredNeighborIds?.has(visNode.node.id) ?? false}
      {@const shouldDim = hoveredNodeId && !isHovered && !isRelatedToHover && !visNode.isCenter}
      {@const dims = getNodeDimensions(visNode.node, visNode.isCenter)}
      {@const hoverScale = isHovered && !visNode.isCenter ? 1.06 : 1}
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
      {@const isDragging = dragNodeId === visNode.node.id}
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
        style="transform: translate({visNode.x}px, {visNode.y}px) scale({hoverScale}); opacity: {shouldDim ? 0.3 : 1};{isDragging ? '' : ' transition: transform 150ms ease-out, opacity 150ms ease-out;'}"
        onmousedown={(e) => startNodeDrag(visNode, e)}
        onclick={(e) => handleNodeClick(visNode.node, e)}
        onmouseenter={(e) => { hoveredNodeId = visNode.node.id; showTooltip(visNode, e); }}
        onmousemove={(e) => showTooltip(visNode, e)}
        onmouseleave={() => { hoveredNodeId = null; hideTooltip(); }}
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
            class="transition-all duration-150 {visNode.isCenter
              ? 'stroke-[var(--accent)] stroke-[3px]'
              : isHovered
                ? 'stroke-[var(--accent)] stroke-[3px]'
                : 'hover:stroke-[var(--accent)] hover:stroke-2'}"
          />
        {:else}
          <circle
            r={radius}
            fill={kindColors[visNode.node.kind]}
            class="transition-all duration-150 {visNode.isCenter
              ? 'stroke-[var(--accent)] stroke-[3px]'
              : isHovered
                ? 'stroke-[var(--accent)] stroke-[3px]'
                : 'hover:stroke-[var(--accent)] hover:stroke-2'}"
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
    {#if visData.nodes.length === 1}
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
