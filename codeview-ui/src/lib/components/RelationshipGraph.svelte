<script lang="ts">
  import type { Edge, Graph, Node, NodeKind } from '$lib/graph';
  // Note: Use plain Map/Set for temporary computation to avoid proxy overhead
  // SvelteMap/SvelteSet should only be used for persistent reactive state

  let {
    graph,
    selected,
    onSelect
  } = $props<{
    graph: Graph;
    selected: Node;
    onSelect: (node: Node) => void;
  }>();

  type VisNode = {
    node: Node;
    x: number;
    y: number;
    baseX: number;
    baseY: number;
    angle: number;
    isCenter: boolean;
    edgeKind: string;
    direction: 'in' | 'out' | 'center';
    layer: number;
    indexInLayer: number;
    totalInLayer: number;
    layoutRadius: number; // The radius used during layout
  };

  type VisEdge = {
    from: VisNode;
    to: VisNode;
    kind: string;
    direction: 'in' | 'out';
  };

  const WIDTH = 700;
  const HEIGHT = 500;
  const CENTER_X = WIDTH / 2;
  const CENTER_Y = HEIGHT / 2;
  const BASE_RADIUS = 160;
  const CENTER_RADIUS = 46;
  const OUTER_RADIUS = 30;
  const ARC_PADDING = 12;
  const HOVER_RING = 4;
  const LAYER_SPACING = 50;
  const MAX_NODES_PER_LAYER = 16;

  // Pan and zoom state
  let zoom = $state(1);
  let panX = $state(0);
  let panY = $state(0);
  let isPanning = $state(false);
  let panStartX = 0;
  let panStartY = 0;
  let panStartPanX = 0;
  let panStartPanY = 0;

  // Tooltip state
  let tooltipNode = $state<VisNode | null>(null);
  let tooltipX = $state(0);
  let tooltipY = $state(0);

  const MIN_ZOOM = 0.3;
  const MAX_ZOOM = 3;

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
  }

  function handleMouseLeave() {
    isPanning = false;
    tooltipNode = null;
  }

  function resetView() {
    zoom = 1;
    panX = 0;
    panY = 0;
  }

  function zoomIn() {
    zoom = Math.min(MAX_ZOOM, zoom * 1.2);
  }

  function zoomOut() {
    zoom = Math.max(MIN_ZOOM, zoom / 1.2);
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

  const kindColors: Record<NodeKind, string> = {
    Crate: '#e85d04',
    Module: '#2d6a4f',
    Struct: '#9d4edd',
    Union: '#7b2cbf',
    Enum: '#3a86ff',
    Trait: '#06d6a0',
    TraitAlias: '#0db39e',
    Impl: '#8d99ae',
    Function: '#f72585',
    Method: '#b5179e',
    TypeAlias: '#ff6d00'
  };

  const edgeColors: Record<string, string> = {
    Contains: '#94a3b8',
    Defines: '#64748b',
    UsesType: '#3b82f6',
    Implements: '#10b981',
    CallsStatic: '#f43f5e',
    CallsRuntime: '#ec4899',
    Derives: '#8b5cf6'
  };

  let hoveredNodeId = $state<string | null>(null);
  let hoveredEdgeIndex = $state<number | null>(null);

  let visData = $derived(computeLayout(graph, selected));

  // Compute positions with fan-out effect for hovered node
  let animatedNodes = $derived.by(() => {
    const nodes = visData.nodes;
    if (!hoveredNodeId) return nodes;

    const hoveredNode = nodes.find((n) => n.node.id === hoveredNodeId);
    if (!hoveredNode || hoveredNode.isCenter) return nodes;

    // Find siblings (same direction and layer)
    const siblings = nodes.filter(
      (n) =>
        !n.isCenter &&
        n.direction === hoveredNode.direction &&
        n.layer === hoveredNode.layer
    );

    if (siblings.length <= 1) return nodes;

    const siblingIndexById = new Map(
      siblings.map((sibling, index) => [sibling.node.id, index] as const)
    );
    const hoveredIndex = siblingIndexById.get(hoveredNodeId);
    if (hoveredIndex === undefined) return nodes;
    const fanOutAngle = Math.min(0.22, 1.2 / siblings.length);

    return nodes.map((n) => {
      if (n.isCenter) return n;
      if (n.direction !== hoveredNode.direction || n.layer !== hoveredNode.layer) return n;

      const siblingIndex = siblingIndexById.get(n.node.id);
      if (siblingIndex === undefined) return n;
      const distanceFromHovered = siblingIndex - hoveredIndex;

      // Apply fan-out: push siblings away from hovered node
      const angleOffset = distanceFromHovered * fanOutAngle;
      const newAngle = n.angle + angleOffset;

      // Use the same radius from layout
      const direction = n.direction === 'in' ? -1 : 1;
      const newX = CENTER_X + direction * n.layoutRadius * Math.cos(newAngle);
      const newY = CENTER_Y + n.layoutRadius * Math.sin(newAngle);

      return { ...n, x: newX, y: newY };
    });
  });

  let animatedNodeMap = $derived.by(() => {
    const map = new Map<string, VisNode>();
    for (const node of animatedNodes) {
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

  function computeLayout(graph: Graph, selected: Node): { nodes: VisNode[]; edges: VisEdge[] } {
    // Use plain Map for computation (not SvelteMap) to avoid proxy overhead
    const nodeMap = new Map<string, Node>();
    for (const node of graph.nodes) {
      nodeMap.set(node.id, node);
    }

    const incoming = graph.edges.filter((e) => e.to === selected.id);
    const outgoing = graph.edges.filter((e) => e.from === selected.id);

    // Deduplicate nodes (a node might have multiple edges to/from selected)
    // Use plain Map for computation
    const incomingNodes = new Map<string, { node: Node; kinds: string[] }>();
    const outgoingNodes = new Map<string, { node: Node; kinds: string[] }>();

    for (const edge of incoming) {
      const node = nodeMap.get(edge.from);
      if (node && node.id !== selected.id) {
        if (!incomingNodes.has(node.id)) {
          incomingNodes.set(node.id, { node, kinds: [] });
        }
        incomingNodes.get(node.id)!.kinds.push(edge.kind);
      }
    }

    for (const edge of outgoing) {
      const node = nodeMap.get(edge.to);
      if (node && node.id !== selected.id) {
        if (!outgoingNodes.has(node.id)) {
          outgoingNodes.set(node.id, { node, kinds: [] });
        }
        outgoingNodes.get(node.id)!.kinds.push(edge.kind);
      }
    }

    const visNodes: VisNode[] = [];
    const visEdges: VisEdge[] = [];

    // Center node
    const centerNode: VisNode = {
      node: selected,
      x: CENTER_X,
      y: CENTER_Y,
      baseX: CENTER_X,
      baseY: CENTER_Y,
      angle: 0,
      isCenter: true,
      edgeKind: '',
      direction: 'center',
      layer: 0,
      indexInLayer: 0,
      totalInLayer: 1,
      layoutRadius: 0
    };
    visNodes.push(centerNode);

    // Layout nodes in an arc - simple approach
    function layoutNodes(
      entries: { node: Node; kinds: string[] }[],
      direction: 'in' | 'out'
    ): VisNode[] {
      const result: VisNode[] = [];
      if (entries.length === 0) return result;

      const directionMultiplier = direction === 'in' ? -1 : 1;
      const count = entries.length;

      // Use full arc (nearly full semicircle) and adjust radius if needed
      const maxArc = Math.PI * 0.95; // Use 95% of semicircle

      // For many nodes, increase radius to give more arc length
      // Each node needs ~55px of arc space (can overlap slightly)
      const minArcPerNode = OUTER_RADIUS * 2 + ARC_PADDING;
      const neededArcLength = count * minArcPerNode;
      const minRadiusForArc = neededArcLength / maxArc;
      const radius = Math.max(BASE_RADIUS, minRadiusForArc);

      // Calculate angle spread - use what we need up to max
      const actualArcNeeded = (count - 1) * minArcPerNode / radius;
      const arcSpread = Math.min(maxArc, Math.max(actualArcNeeded, Math.PI * 0.4));

      const angleStep = count > 1 ? arcSpread / (count - 1) : 0;
      const startAngle = count > 1 ? -arcSpread / 2 : 0;

      entries.forEach((entry, i) => {
        const angle = startAngle + i * angleStep;
        const x = CENTER_X + directionMultiplier * radius * Math.cos(angle);
        const y = CENTER_Y + radius * Math.sin(angle);

        const visNode: VisNode = {
          node: entry.node,
          x,
          y,
          baseX: x,
          baseY: y,
          angle,
          isCenter: false,
          edgeKind: formatEdgeKinds(entry.kinds),
          direction,
          layer: 0,
          indexInLayer: i,
          totalInLayer: count,
          layoutRadius: radius
        };
        result.push(visNode);
      });

      return result;
    }

    const inArray = Array.from(incomingNodes.values());
    const outArray = Array.from(outgoingNodes.values());

    const inVisNodes = layoutNodes(inArray, 'in');
    const outVisNodes = layoutNodes(outArray, 'out');

    visNodes.push(...inVisNodes);
    visNodes.push(...outVisNodes);

    // Create edges
    for (const visNode of inVisNodes) {
      const entry = incomingNodes.get(visNode.node.id)!;
      visEdges.push({
        from: visNode,
        to: centerNode,
        kind: formatEdgeKinds(entry.kinds),
        direction: 'in'
      });
    }

    for (const visNode of outVisNodes) {
      const entry = outgoingNodes.get(visNode.node.id)!;
      visEdges.push({
        from: centerNode,
        to: visNode,
        kind: formatEdgeKinds(entry.kinds),
        direction: 'out'
      });
    }

    return { nodes: visNodes, edges: visEdges };
  }

  function handleNodeClick(node: Node) {
    if (node.id !== selected.id) {
      onSelect(node);
    }
  }

  function getNodeRadius(isCenter: boolean): number {
    return isCenter ? CENTER_RADIUS : OUTER_RADIUS;
  }

  function truncateName(name: string, maxLen: number): string {
    if (name.length <= maxLen) return name;
    return name.slice(0, maxLen - 1) + '...';
  }

  function formatEdgeKinds(kinds: string[]): string {
    return Array.from(new Set(kinds)).join(', ');
  }

  // Calculate label positions to avoid overlap
  function getLabelPosition(
    edge: VisEdge,
    edgeIndex: number,
    allEdges: VisEdge[],
    animatedNodeMap: Map<string, VisNode>
  ): { x: number; y: number; anchor: string; isHighlighted: boolean } {
    // Find the animated positions for this edge's nodes
    const fromNode = animatedNodeMap.get(edge.from.node.id) ?? edge.from;
    const toNode = animatedNodeMap.get(edge.to.node.id) ?? edge.to;

    const dx = toNode.x - fromNode.x;
    const dy = toNode.y - fromNode.y;
    const len = Math.hypot(dx, dy);
    const edgeAngle = Math.atan2(dy, dx);

    // Check if this edge is being hovered
    const isHighlighted = hoveredEdgeIndex === edgeIndex ||
      hoveredNodeId === edge.from.node.id ||
      hoveredNodeId === edge.to.node.id;

    // Position label closer to the non-center node (outer node) where there's more space
    const t = edge.direction === 'in' ? 0.25 : 0.75;
    let midX = fromNode.x + dx * t;
    let midY = fromNode.y + dy * t;

    // Offset perpendicular to the edge to avoid overlapping with the line
    if (len === 0) {
      return { x: fromNode.x, y: fromNode.y, anchor: 'middle', isHighlighted };
    }

    const perpX = -dy / len;
    const perpY = dx / len;

    // Only offset if there are edges with SIMILAR angles (would actually overlap)
    // Edges going in different directions don't need offsetting from each other
    const similarEdges: number[] = [];
    for (let i = 0; i < allEdges.length; i++) {
      const other = allEdges[i];
      // Must be same direction (in/out)
      if (other.direction !== edge.direction) continue;

      const otherFrom = animatedNodeMap.get(other.from.node.id) ?? other.from;
      const otherTo = animatedNodeMap.get(other.to.node.id) ?? other.to;
      const otherDx = otherTo.x - otherFrom.x;
      const otherDy = otherTo.y - otherFrom.y;
      const otherAngle = Math.atan2(otherDy, otherDx);

      // Check if angles are similar (within ~20 degrees)
      const angleDiff = Math.abs(edgeAngle - otherAngle);
      const normalizedDiff = Math.min(angleDiff, Math.PI * 2 - angleDiff);
      if (normalizedDiff < 0.35) {
        similarEdges.push(i);
      }
    }

    // Only apply offset if there are multiple edges with similar angles
    const myIndex = similarEdges.indexOf(edgeIndex);
    const baseOffset = 8;
    let crowdOffset = 0;
    if (similarEdges.length > 1 && myIndex >= 0) {
      crowdOffset = (myIndex - (similarEdges.length - 1) / 2) * 14;
    }

    midX += perpX * (baseOffset + crowdOffset);
    midY += perpY * (baseOffset + crowdOffset);

    // Determine anchor based on position relative to center
    const anchor = midX < CENTER_X - 20 ? 'start' : midX > CENTER_X + 20 ? 'end' : 'middle';

    return { x: midX, y: midY, anchor, isHighlighted };
  }
</script>

<div class="rounded-xl border border-[var(--panel-border)] bg-white overflow-hidden">
  <div class="border-b border-[var(--panel-border)] bg-[var(--panel)] px-4 py-2 flex items-center justify-between">
    <span class="text-sm font-medium text-[var(--ink)]">Relationship Graph</span>
    <div class="flex items-center gap-4">
      <!-- Zoom controls -->
      <div class="flex items-center gap-1">
        <button
          type="button"
          onclick={zoomOut}
          class="w-6 h-6 flex items-center justify-center rounded bg-white border border-[var(--panel-border)] text-[var(--muted)] hover:bg-[var(--panel)] text-sm"
          title="Zoom out"
        >−</button>
        <span class="text-xs text-[var(--muted)] w-12 text-center">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          onclick={zoomIn}
          class="w-6 h-6 flex items-center justify-center rounded bg-white border border-[var(--panel-border)] text-[var(--muted)] hover:bg-[var(--panel)] text-sm"
          title="Zoom in"
        >+</button>
        <button
          type="button"
          onclick={resetView}
          class="ml-1 px-2 h-6 flex items-center justify-center rounded bg-white border border-[var(--panel-border)] text-[var(--muted)] hover:bg-[var(--panel)] text-xs"
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
    class="graph-container relative select-none"
    style="cursor: {isPanning ? 'grabbing' : 'grab'};"
    onwheel={handleWheel}
    onmousedown={handleMouseDown}
    onmousemove={handleMouseMove}
    onmouseup={handleMouseUp}
    onmouseleave={handleMouseLeave}
  >
    <svg viewBox="0 0 {WIDTH} {HEIGHT}" class="w-full" style="max-height: 500px;">
      <defs>
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
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b" />
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
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#475569" />
      </marker>
    </defs>

    <g transform="translate({panX}, {panY}) scale({zoom})">
      <!-- Edges (non-highlighted first, then highlighted on top) -->
    {#each visData.edges as edge, edgeIndex (edge.from.node.id + '|' + edge.to.node.id + '|' + edge.kind)}
      {@const fromNode = animatedNodeMap.get(edge.from.node.id) ?? edge.from}
      {@const toNode = animatedNodeMap.get(edge.to.node.id) ?? edge.to}
      {@const dx = toNode.x - fromNode.x}
      {@const dy = toNode.y - fromNode.y}
      {@const len = Math.hypot(dx, dy) || 1}
      {@const fromRadius = getNodeRadius(edge.from.isCenter)}
      {@const toRadius = getNodeRadius(edge.to.isCenter)}
      {@const startX = fromNode.x + (dx / len) * fromRadius}
      {@const startY = fromNode.y + (dy / len) * fromRadius}
      {@const endX = toNode.x - (dx / len) * (toRadius + 8)}
      {@const endY = toNode.y - (dy / len) * (toRadius + 8)}
      {@const isHighlighted = hoveredNodeId === edge.from.node.id || hoveredNodeId === edge.to.node.id || hoveredEdgeIndex === edgeIndex}
      <g
        class="edge transition-opacity duration-150"
        style="opacity: {hoveredNodeId && !isHighlighted ? 0.3 : 1}"
        onmouseenter={() => hoveredEdgeIndex = edgeIndex}
        onmouseleave={() => hoveredEdgeIndex = null}
      >
        <line
          x1={startX}
          y1={startY}
          x2={endX}
          y2={endY}
          stroke={edge.direction === 'out' ? 'var(--accent)' : (isHighlighted ? '#475569' : '#94a3b8')}
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
      {@const labelPos = getLabelPosition(edge, edgeIndex, visData.edges, animatedNodeMap)}
      {@const isHighlighted = labelPos.isHighlighted}
      <g
        class="transition-opacity duration-150"
        style="opacity: {hoveredNodeId && !isHighlighted ? 0.2 : 1}"
      >
        {#if isHighlighted}
          <!-- Background for highlighted labels -->
          <rect
            x={labelPos.x - (labelPos.anchor === 'end' ? 50 : labelPos.anchor === 'middle' ? 25 : 0)}
            y={labelPos.y - 10}
            width="50"
            height="14"
            fill="white"
            rx="3"
            class="transition-all duration-150"
          />
        {/if}
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
    {#each animatedNodes as visNode (visNode.node.id)}
      {@const radius = getNodeRadius(visNode.isCenter)}
      {@const isHovered = hoveredNodeId === visNode.node.id}
      {@const isRelatedToHover = hoveredNeighborIds?.has(visNode.node.id) ?? false}
      {@const shouldDim = hoveredNodeId && !isHovered && !isRelatedToHover && !visNode.isCenter}
      <g
        class="node cursor-pointer transition-all duration-150"
        style="transform: translate({visNode.x}px, {visNode.y}px); opacity: {shouldDim ? 0.3 : 1}"
        onclick={() => handleNodeClick(visNode.node)}
        onmouseenter={(e) => { hoveredNodeId = visNode.node.id; showTooltip(visNode, e); }}
        onmousemove={(e) => showTooltip(visNode, e)}
        onmouseleave={() => { hoveredNodeId = null; hideTooltip(); }}
        role="button"
        tabindex="0"
        onkeydown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleNodeClick(visNode.node);
          }
        }}
      >
        <!-- Node circle -->
        <circle
            r={isHovered && !visNode.isCenter ? radius + HOVER_RING : radius}
          fill={kindColors[visNode.node.kind]}
          class="transition-all duration-150 {visNode.isCenter
            ? 'stroke-[var(--accent)] stroke-[3px]'
            : isHovered
              ? 'stroke-[var(--accent)] stroke-[3px]'
              : 'hover:stroke-[var(--accent)] hover:stroke-2'}"
        />
        <!-- Node name -->
        <text
          y={visNode.isCenter ? -2 : 0}
          text-anchor="middle"
          dominant-baseline="middle"
          class="fill-white font-medium pointer-events-none {visNode.isCenter ? 'text-sm' : 'text-[11px]'}"
        >
          {truncateName(visNode.node.name, visNode.isCenter ? 12 : 8)}
        </text>
        <!-- Kind label for center node -->
        {#if visNode.isCenter}
          <text
            y={14}
            text-anchor="middle"
            class="fill-white/70 text-[10px] pointer-events-none"
          >
            {visNode.node.kind}
          </text>
        {/if}
      </g>
    {/each}

    <!-- Labels for directions -->
    {#if visData.nodes.filter(n => n.direction === 'in').length > 0}
      <text x={60} y={30} class="fill-[var(--muted)] text-xs font-medium">
        ← Incoming
      </text>
    {/if}
    {#if visData.nodes.filter(n => n.direction === 'out').length > 0}
      <text x={WIDTH - 60} y={30} text-anchor="end" class="fill-[var(--muted)] text-xs font-medium">
        Outgoing →
      </text>
    {/if}

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
        class="absolute pointer-events-none z-50 px-3 py-2 rounded-lg shadow-lg border border-[var(--panel-border)] bg-white text-sm max-w-xs"
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
          <div class="text-xs font-mono text-[var(--muted)] mt-1 pt-1 border-t border-[var(--panel-border)] truncate">
            {tooltipNode.node.signature}
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>
