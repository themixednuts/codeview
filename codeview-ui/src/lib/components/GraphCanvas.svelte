<script lang="ts">
  import type { Edge, EdgeKind, NodeKind } from '$lib/graph';
  import type { LayoutNode, LayoutState } from '$lib/layout';
  import { getNodeVisual } from '$lib/visual';
  import { Loader2Icon } from '@lucide/svelte';
  import ZoomIn from '@lucide/svelte/icons/zoom-in';
  import ZoomOut from '@lucide/svelte/icons/zoom-out';
  import Maximize from '@lucide/svelte/icons/maximize';

  type ResolvePoint = (value: LayoutNode | string | number) => { x: number; y: number };

  let {
    layout,
    width = $bindable(),
    height = $bindable(),
    tick,
    loading,
    selected,
    onSelect,
    nodeRadius,
    nodeColor,
    edgeColor,
    edgeClass,
    edgeDimmed,
    resolvePoint
  } = $props<{
    layout: LayoutState | null;
    width: number;
    height: number;
    tick: number;
    loading: boolean;
    selected: LayoutNode | null;
    onSelect: (node: LayoutNode) => void;
    nodeRadius: (kind: NodeKind) => number;
    nodeColor: (kind: NodeKind) => string;
    edgeColor: (kind: EdgeKind) => string;
    edgeClass: (edge: Edge) => string;
    edgeDimmed: (edge: Edge) => boolean;
    resolvePoint: ResolvePoint;
  }>();

  let transform = $state({ x: 0, y: 0, scale: 1 });
  let isPanning = $state(false);
  let panStart = $state({ x: 0, y: 0 });
  let lastFitTick = $state(-1);

  function fitToView() {
    if (!layout || layout.nodes.length === 0 || width === 0 || height === 0) return;

    const padding = 60;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

    for (const node of layout.nodes) {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const v = getNodeVisual(node.kind, selected?.id === node.id);
      const hw = v.width / 2;
      const hh = v.height / 2;
      minX = Math.min(minX, x - hw);
      maxX = Math.max(maxX, x + hw);
      minY = Math.min(minY, y - hh);
      maxY = Math.max(maxY, y + hh);
    }

    const graphWidth = maxX - minX;
    const graphHeight = maxY - minY;

    if (graphWidth <= 0 || graphHeight <= 0) return;

    const scaleX = (width - padding * 2) / graphWidth;
    const scaleY = (height - padding * 2) / graphHeight;
    const scale = Math.min(scaleX, scaleY, 2);

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    transform = {
      x: width / 2 - centerX * scale,
      y: height / 2 - centerY * scale,
      scale
    };
  }

  $effect(() => {
    if (layout && tick > 0 && tick % 30 === 0 && tick !== lastFitTick && tick < 150) {
      fitToView();
      lastFitTick = tick;
    }
  });

  function handleWheel(event: WheelEvent) {
    event.preventDefault();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    const zoomFactor = event.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.max(0.1, Math.min(5, transform.scale * zoomFactor));

    const worldX = (mouseX - transform.x) / transform.scale;
    const worldY = (mouseY - transform.y) / transform.scale;

    transform = {
      x: mouseX - worldX * newScale,
      y: mouseY - worldY * newScale,
      scale: newScale
    };
  }

  function handleMouseDown(event: MouseEvent) {
    if (event.button !== 0) return;
    isPanning = true;
    panStart = { x: event.clientX - transform.x, y: event.clientY - transform.y };
  }

  function handleMouseMove(event: MouseEvent) {
    if (!isPanning) return;
    transform = {
      ...transform,
      x: event.clientX - panStart.x,
      y: event.clientY - panStart.y
    };
  }

  function handleMouseUp() {
    isPanning = false;
  }

  function resetZoom() {
    fitToView();
  }

  function zoomIn() {
    const newScale = Math.min(5, transform.scale * 1.3);
    transform = {
      x: width / 2 - ((width / 2 - transform.x) / transform.scale) * newScale,
      y: height / 2 - ((height / 2 - transform.y) / transform.scale) * newScale,
      scale: newScale
    };
  }

  function zoomOut() {
    const newScale = Math.max(0.1, transform.scale / 1.3);
    transform = {
      x: width / 2 - ((width / 2 - transform.x) / transform.scale) * newScale,
      y: height / 2 - ((height / 2 - transform.y) / transform.scale) * newScale,
      scale: newScale
    };
  }
</script>

<div class="rounded-[var(--radius-panel)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel)] p-6 shadow-[var(--shadow-strong)]">
  <div class="flex flex-wrap items-start justify-between gap-4">
    <div>
      <h2 class="text-2xl font-semibold text-[var(--ink)]">Graph canvas</h2>
      <p class="mt-1 text-sm text-[var(--muted)]">
        Force layout updates as you swap data. Click nodes to highlight paths.
      </p>
    </div>
    <div class="flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
      <span class="h-2 w-2 animate-[shimmer_1.2s_ease-in-out_infinite] rounded-full bg-[var(--accent)]"></span>
      Live layout
    </div>
  </div>
  <div
    class="relative mt-6 h-[560px] overflow-hidden rounded-[var(--radius-card)] corner-squircle border border-dashed border-[var(--panel-border)] bg-[var(--panel-muted)]"
    bind:clientWidth={width}
    bind:clientHeight={height}
  >
    {#if layout}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <svg
        class="h-full w-full"
        class:cursor-grabbing={isPanning}
        class:cursor-grab={!isPanning}
        viewBox={`0 0 ${width || 1} ${height || 1}`}
        data-tick={tick}
        onwheel={handleWheel}
        onmousedown={handleMouseDown}
        onmousemove={handleMouseMove}
        onmouseup={handleMouseUp}
        onmouseleave={handleMouseUp}
      >
        <defs>
          <pattern
            id="grid"
            width={32 * transform.scale}
            height={32 * transform.scale}
            patternUnits="userSpaceOnUse"
            x={transform.x % (32 * transform.scale)}
            y={transform.y % (32 * transform.scale)}
          >
            <path
              d={`M ${32 * transform.scale} 0 L 0 0 0 ${32 * transform.scale}`}
              fill="none"
              stroke="var(--panel-border)"
              stroke-width={0.6 * transform.scale}
              opacity="0.5"
            />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)" />
        <g transform={`translate(${transform.x}, ${transform.y}) scale(${transform.scale})`}>
          <g>
            {#each layout.links as link (link.from + link.to + link.kind)}
              {@const sourcePoint = resolvePoint(link.source)}
              {@const targetPoint = resolvePoint(link.target)}
              <line
                x1={sourcePoint.x}
                y1={sourcePoint.y}
                x2={targetPoint.x}
                y2={targetPoint.y}
                stroke={edgeColor(link.kind)}
                stroke-width={1.5 / transform.scale}
                class={`graph-link ${edgeClass(link)} ${edgeDimmed(link) ? 'opacity-30' : ''}`}
              />
            {/each}
          </g>
          <g>
            {#each layout.nodes as node (node.id)}
              {@const visual = getNodeVisual(node.kind, selected?.id === node.id)}
              <g
                class="graph-node"
                class:selected={selected?.id === node.id}
                transform={`translate(${node.x ?? 0}, ${node.y ?? 0})`}
                role="button"
                tabindex="0"
                onclick={(e) => { e.stopPropagation(); onSelect(node); }}
                onkeydown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(node);
                  }
                }}
              >
                <path
                  d={visual.svgPath}
                  fill={visual.fill}
                  stroke={visual.stroke}
                  stroke-width={visual.strokeWidth}
                  stroke-dasharray={visual.strokeDasharray ?? 'none'}
                />
                <text dy="0.35em" font-size={12 / transform.scale} fill={visual.labelColor}>{node.name}</text>
              </g>
            {/each}
          </g>
        </g>
      </svg>
      <div class="absolute bottom-4 right-4 flex flex-col gap-1">
        <button
          type="button"
          class="flex h-8 w-8 items-center justify-center rounded-[var(--radius-control)] corner-squircle bg-[var(--panel-solid)] text-[var(--ink)] shadow-[var(--shadow-soft)] hover:bg-[var(--panel-strong)]"
          onclick={zoomIn}
          title="Zoom in"
        >
          <ZoomIn size={16} />
        </button>
        <button
          type="button"
          class="flex h-8 w-8 items-center justify-center rounded-[var(--radius-control)] corner-squircle bg-[var(--panel-solid)] text-[var(--ink)] shadow-[var(--shadow-soft)] hover:bg-[var(--panel-strong)]"
          onclick={zoomOut}
          title="Zoom out"
        >
          <ZoomOut size={16} />
        </button>
        <button
          type="button"
          class="flex h-8 w-8 items-center justify-center rounded-[var(--radius-control)] corner-squircle bg-[var(--panel-solid)] text-[var(--ink)] shadow-[var(--shadow-soft)] hover:bg-[var(--panel-strong)]"
          onclick={resetZoom}
          title="Fit to view"
        >
          <Maximize size={16} />
        </button>
      </div>
    {:else}
      <div class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-[var(--muted)]">
        <div class="h-12 w-12 rounded-full border-2 border-[var(--panel-border)] border-t-[var(--accent)] animate-spin"></div>
        <p class="font-semibold text-[var(--ink)]">Preparing the graph layout</p>
        <p>Load a graph JSON file to bring the canvas to life.</p>
      </div>
    {/if}
    {#if loading}
      <div class="absolute inset-0 grid place-content-center bg-[var(--panel-muted)] text-sm text-[var(--muted)]">
        <div class="flex items-center gap-2">
          <Loader2Icon class="animate-spin" size={16} />
          Loading graph data...
        </div>
      </div>
    {/if}
  </div>
</div>
