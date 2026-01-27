<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import * as THREE from 'three/webgpu';
  
  import type { EdgeKind, Graph, Node, NodeKind } from '$lib/graph';
  import type { LayoutMode, VisEdge, VisNode } from '$lib/graph-layout';
  import {
    CENTER_X,
    CENTER_Y,
    LAYOUT_HEIGHT,
    LAYOUT_WIDTH,
    computeLayout,
    getEdgeAnchor,
    getNodeDimensions
  } from '$lib/graph-layout';

  interface Props {
    graph: Graph | null;
    selected: Node | null;
    onSelect: (node: Node) => void;
    layoutMode?: LayoutMode;
    centerNode?: string | null;
    onFallback?: () => void;
  }

  let {
    graph,
    selected,
    onSelect,
    layoutMode = 'ego',
    centerNode = null,
    onFallback
  }: Props = $props();

  // Edge filtering - categorize edges as structural or semantic
  const structuralEdgeKinds: EdgeKind[] = ['Contains', 'Defines'];
  const semanticEdgeKinds: EdgeKind[] = ['UsesType', 'Implements', 'CallsStatic', 'CallsRuntime', 'Derives'];

  // Filter state - default: show semantic, hide structural
  let showStructural = $state(false);
  let showSemantic = $state(true);

  let filteredEdges = $derived.by(() => {
    return graph?.edges.filter((edge) => {
      if (structuralEdgeKinds.includes(edge.kind)) {
        return showStructural;
      }
      if (semanticEdgeKinds.includes(edge.kind)) {
        return showSemantic;
      }
      return true;
    }) ?? [];
  });

  let filteredGraph = $derived.by(() => {
    if (!graph) return null;
    return {
      nodes: graph.nodes,
      edges: filteredEdges
    };
  });

  const WIDTH = LAYOUT_WIDTH;
  const HEIGHT = LAYOUT_HEIGHT;
  const RECT_CORNER_RADIUS = 10;
  const HEADER_HEIGHT = 16;
  const PIN_RADIUS = 4;
  const EDGE_NODE_PADDING = 10;

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

  let container = $state<HTMLDivElement | null>(null);
  let canvasEl = $state<HTMLCanvasElement | null>(null);
  let renderer = $state<THREE.WebGPURenderer | null>(null);
  let scene = $state<THREE.Scene | null>(null);
  let camera = $state<THREE.OrthographicCamera | null>(null);
  let nodeGroup = $state<THREE.Group | null>(null);
  let edgeGroup = $state<THREE.Group | null>(null);
  let isWebGPUAvailable = $state(false);
  let initError = $state<string | null>(null);
  let loading = $state(true);
  let frameId: number | null = null;

  let hoveredNodeId = $state<string | null>(null);
  let isDragging = false;
  let lastMouseX = 0;
  let lastMouseY = 0;

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let nodeMeshes = new Map<string, THREE.Mesh>();
  let nodeLabels = $state<{ id: string; text: string; x: number; y: number; isCenter: boolean; visible: boolean }[]>([]);

  const MIN_ZOOM = 0.4;
  const MAX_ZOOM = 2.5;

  let visData = $derived.by(() => {
    if (!filteredGraph || !selected) return { nodes: [] as VisNode[], edges: [] as VisEdge[] };
    return computeLayout(filteredGraph, selected, layoutMode);
  });


  // Minimum zoom level to show non-center labels
  const LABEL_ZOOM_THRESHOLD = 0.7;

  function clearGroup(group: THREE.Group) {
    while (group.children.length > 0) {
      const child = group.children.pop();
      if (child) {
        child.removeFromParent();
      }
    }
  }

  // Flip Y to convert from SVG coordinates (Y down) to Three.js coordinates (Y up)
  function flipY(y: number): number {
    return HEIGHT - y;
  }

  function buildScene() {
    if (!scene || !nodeGroup || !edgeGroup) return;

    clearGroup(nodeGroup);
    clearGroup(edgeGroup);
    nodeMeshes = new Map();

    // Build mesh-based edges (WebGPU doesn't support THREE.Line well)
    for (const edge of visData.edges) {
      const startAnchor = getEdgeAnchor(edge.from, edge.to);
      const endAnchor = getEdgeAnchor(edge.to, edge.from);
      const dx = endAnchor.x - startAnchor.x;
      const dy = endAnchor.y - startAnchor.y;
      const len = Math.hypot(dx, dy) || 1;
      const start = new THREE.Vector3(startAnchor.x, flipY(startAnchor.y), 0);
      const end = new THREE.Vector3(
        endAnchor.x - (dx / len) * EDGE_NODE_PADDING,
        flipY(endAnchor.y - (dy / len) * EDGE_NODE_PADDING),
        0
      );
      const mid = start.clone().lerp(end, 0.5);
      const control = mid.clone().add(new THREE.Vector3(0, edge.direction === 'out' ? 12 : -12, 0));
      const curve = new THREE.QuadraticBezierCurve3(start, control, end);
      const points = curve.getPoints(24);

      // Create mesh-based line segments
      const color = new THREE.Color(edge.direction === 'out' ? '#f97316' : '#94a3b8');
      const lineWidth = 1.2;

      for (let i = 0; i < points.length - 1; i++) {
        const p1 = points[i];
        const p2 = points[i + 1];
        const segDx = p2.x - p1.x;
        const segDy = p2.y - p1.y;
        const segLen = Math.hypot(segDx, segDy) || 1;

        // Create a thin plane for each segment
        const segGeom = new THREE.PlaneGeometry(segLen, lineWidth);
        const segMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8 });
        const segMesh = new THREE.Mesh(segGeom, segMat);

        // Position at midpoint and rotate to align with segment
        segMesh.position.set((p1.x + p2.x) / 2, (p1.y + p2.y) / 2, 0.5);
        segMesh.rotation.z = Math.atan2(segDy, segDx);
        edgeGroup.add(segMesh);
      }
    }

    for (const visNode of visData.nodes) {
      const dims = getNodeDimensions(visNode.node, visNode.isCenter);
      const isRect = dims.isRect;
      const nodeY = flipY(visNode.y);
      let geometry: THREE.BufferGeometry;
      if (isRect) {
        const shape = new THREE.Shape();
        const w = dims.width;
        const h = dims.height;
        const r = RECT_CORNER_RADIUS;
        shape.moveTo(-w / 2 + r, -h / 2);
        shape.lineTo(w / 2 - r, -h / 2);
        shape.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
        shape.lineTo(w / 2, h / 2 - r);
        shape.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
        shape.lineTo(-w / 2 + r, h / 2);
        shape.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
        shape.lineTo(-w / 2, -h / 2 + r);
        shape.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
        geometry = new THREE.ShapeGeometry(shape);
      } else {
        geometry = new THREE.CircleGeometry(dims.width / 2, 32);
      }

      const baseColor = new THREE.Color(kindColors[visNode.node.kind]);
      const material = new THREE.MeshBasicMaterial({ color: baseColor });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(visNode.x, nodeY, 2);
      mesh.userData = {
        nodeId: visNode.node.id,
        baseColor,
        isCenter: visNode.isCenter
      };
      nodeGroup.add(mesh);
      nodeMeshes.set(visNode.node.id, mesh);

      // Add outline ring for circles (meshes work in WebGPU, lines don't)
      if (!isRect) {
        const circleOutline = new THREE.RingGeometry(dims.width / 2 - 1.5, dims.width / 2, 32);
        const outlineMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 });
        const outlineMesh = new THREE.Mesh(circleOutline, outlineMat);
        outlineMesh.position.set(visNode.x, nodeY, 2.1);
        nodeGroup.add(outlineMesh);
      }

      if (isRect) {
        const headerHeight = Math.min(HEADER_HEIGHT, dims.height);
        const headerGeom = new THREE.PlaneGeometry(dims.width, headerHeight);
        const headerMat = new THREE.MeshBasicMaterial({ color: baseColor });
        const headerMesh = new THREE.Mesh(headerGeom, headerMat);
        headerMesh.position.set(visNode.x, nodeY + dims.height / 2 - headerHeight / 2, 2.5);
        nodeGroup.add(headerMesh);

        const pinGeom = new THREE.CircleGeometry(PIN_RADIUS, 16);
        const pinMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffffff') });
        const pinStrokeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#475569') });

        const leftPin = new THREE.Mesh(pinGeom, pinMat);
        leftPin.position.set(visNode.x - dims.width / 2, nodeY, 3);
        nodeGroup.add(leftPin);
        const rightPin = new THREE.Mesh(pinGeom, pinMat);
        rightPin.position.set(visNode.x + dims.width / 2, nodeY, 3);
        nodeGroup.add(rightPin);
        const leftPinStroke = new THREE.Mesh(new THREE.RingGeometry(PIN_RADIUS - 1.2, PIN_RADIUS, 16), pinStrokeMat);
        leftPinStroke.position.copy(leftPin.position);
        nodeGroup.add(leftPinStroke);
        const rightPinStroke = new THREE.Mesh(new THREE.RingGeometry(PIN_RADIUS - 1.2, PIN_RADIUS, 16), pinStrokeMat);
        rightPinStroke.position.copy(rightPin.position);
        nodeGroup.add(rightPinStroke);
      }

    }

    updateLabelPositions();
    updateHighlights();
  }

  function worldToScreen(x: number, y: number): { x: number; y: number } {
    if (!camera || !container) return { x: 0, y: 0 };
    const rect = container.getBoundingClientRect();
    const vector = new THREE.Vector3(x, y, 0);
    vector.project(camera);
    return {
      x: (vector.x + 1) * 0.5 * rect.width,
      y: (-vector.y + 1) * 0.5 * rect.height
    };
  }

  function updateLabelPositions() {
    if (!camera || !container) return;
    const zoom = camera.zoom;
    const rect = container.getBoundingClientRect();

    const nextNodeLabels = visData.nodes.map((visNode) => {
      const dims = getNodeDimensions(visNode.node, visNode.isCenter);
      // For rect nodes, offset to position label in the header area
      // For circle nodes, offset slightly for center node
      const labelOffset = dims.isRect
        ? (dims.height / 2 - Math.min(HEADER_HEIGHT, dims.height) / 2)
        : (visNode.isCenter ? -6 : 0);
      // Use flipped Y coordinate (Three.js world space)
      const pos = worldToScreen(visNode.x, flipY(visNode.y + labelOffset));

      // Only show labels for center node, or other nodes when zoomed in enough
      // Also hide labels that are off-screen
      const isOnScreen = pos.x >= -50 && pos.x <= rect.width + 50 &&
                         pos.y >= -50 && pos.y <= rect.height + 50;
      const visible = visNode.isCenter || (zoom >= LABEL_ZOOM_THRESHOLD && isOnScreen);

      // Truncate long names for non-center nodes
      const maxLen = visNode.isCenter ? 30 : 15;
      const text = visNode.node.name.length > maxLen
        ? visNode.node.name.slice(0, maxLen - 3) + '...'
        : visNode.node.name;

      return {
        id: visNode.node.id,
        text,
        x: pos.x,
        y: pos.y,
        isCenter: visNode.isCenter,
        visible
      };
    });
    nodeLabels = nextNodeLabels;
  }

  function updateHighlights() {
    for (const [id, mesh] of nodeMeshes.entries()) {
      const { baseColor } = mesh.userData as { baseColor: THREE.Color };
      const isSelected = selected?.id === id;
      const isHovered = hoveredNodeId === id;
      const color = baseColor.clone();
      if (isSelected) {
        color.lerp(new THREE.Color('#f97316'), 0.6);
        mesh.scale.set(1.12, 1.12, 1);
      } else if (isHovered) {
        color.lerp(new THREE.Color('#ffffff'), 0.35);
        mesh.scale.set(1.06, 1.06, 1);
      } else {
        mesh.scale.set(1, 1, 1);
      }
      (mesh.material as THREE.MeshBasicMaterial).color = color;
    }
  }

  async function initRenderer() {
    loading = true;
    initError = null;

    if (!container || !canvasEl) {
      requestAnimationFrame(initRenderer);
      return;
    }

    const rect = container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      requestAnimationFrame(initRenderer);
      return;
    }

    if (!('gpu' in navigator)) {
      initError = 'WebGPU is not available in this browser.';
      loading = false;
      onFallback?.();
      return;
    }

    try {
      const nextScene = new THREE.Scene();
      // Orthographic camera centered on the layout
      // left/right/top/bottom define the visible world coordinates relative to camera
      const halfW = WIDTH / 2;
      const halfH = HEIGHT / 2;
      const nextCamera = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, -1000, 1000);
      nextCamera.position.set(halfW, halfH, 10);
      nextCamera.zoom = 1;
      nextCamera.updateProjectionMatrix();

      const nextRenderer = new THREE.WebGPURenderer({ canvas: canvasEl, antialias: true, alpha: true });
      await nextRenderer.init();
      // Use higher pixel ratio for crisp rendering (min 2x for retina-like quality)
      nextRenderer.setPixelRatio(Math.max(window.devicePixelRatio || 1, 2));
      nextRenderer.setSize(rect.width, rect.height);

      const nextNodeGroup = new THREE.Group();
      const nextEdgeGroup = new THREE.Group();
      nextScene.add(nextEdgeGroup);
      nextScene.add(nextNodeGroup);

      scene = nextScene;
      camera = nextCamera;
      renderer = nextRenderer;
      nodeGroup = nextNodeGroup;
      edgeGroup = nextEdgeGroup;

      isWebGPUAvailable = true;
      buildScene();
      startRenderLoop();
      loading = false;
    } catch (error) {
      initError = error instanceof Error ? error.message : 'Failed to initialize Three.js WebGPU renderer';
      loading = false;
      onFallback?.();
    }
  }

  function startRenderLoop() {
    if (!renderer || !scene || !camera) return;
    const loop = () => {
      renderer!.render(scene!, camera!);
      frameId = requestAnimationFrame(loop);
    };
    frameId = requestAnimationFrame(loop);
  }

  function handleResize() {
    if (!renderer || !container || !camera) return;
    const rect = container.getBoundingClientRect();
    renderer.setPixelRatio(Math.max(window.devicePixelRatio || 1, 2));
    renderer.setSize(rect.width, rect.height);
    camera.updateProjectionMatrix();
    updateLabelPositions();
  }

  function zoomTo(factor: number, x: number, y: number) {
    if (!camera) return;
    const rect = container?.getBoundingClientRect();
    if (!rect) return;
    const ndcX = (x / rect.width) * 2 - 1;
    const ndcY = -(y / rect.height) * 2 + 1;
    const before = new THREE.Vector3(ndcX, ndcY, 0).unproject(camera);
    camera.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.zoom * factor));
    camera.updateProjectionMatrix();
    const after = new THREE.Vector3(ndcX, ndcY, 0).unproject(camera);
    camera.position.x += before.x - after.x;
    camera.position.y += before.y - after.y;
    updateLabelPositions();
  }

  function resetView() {
    if (!camera) return;
    camera.position.set(WIDTH / 2, HEIGHT / 2, 10);
    camera.zoom = 1;
    camera.updateProjectionMatrix();
    updateLabelPositions();
  }

  function zoomIn() {
    const rect = container?.getBoundingClientRect();
    if (!rect) return;
    zoomTo(1.15, rect.width / 2, rect.height / 2);
  }

  function zoomOut() {
    const rect = container?.getBoundingClientRect();
    if (!rect) return;
    zoomTo(0.87, rect.width / 2, rect.height / 2);
  }

  function handleMouseDown(event: MouseEvent) {
    if (event.button !== 0) return;
    isDragging = true;
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;
  }

  function handleMouseMove(event: MouseEvent) {
    if (!camera || !container) return;
    if (isDragging) {
      const dx = event.clientX - lastMouseX;
      const dy = event.clientY - lastMouseY;
      camera.position.x -= dx / camera.zoom;
      camera.position.y += dy / camera.zoom;
      lastMouseX = event.clientX;
      lastMouseY = event.clientY;
      updateLabelPositions();
      return;
    }

    const rect = container.getBoundingClientRect();
    pointer.x = (event.clientX - rect.left) / rect.width * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const intersections = raycaster.intersectObjects(Array.from(nodeMeshes.values()));
    if (intersections.length > 0) {
      const mesh = intersections[0].object as THREE.Mesh;
      const nodeId = mesh.userData.nodeId as string;
      if (hoveredNodeId !== nodeId) {
        hoveredNodeId = nodeId;
        updateHighlights();
      }
    } else if (hoveredNodeId) {
      hoveredNodeId = null;
      updateHighlights();
    }
  }

  function handleMouseUp() {
    isDragging = false;
  }

  function handleMouseLeave() {
    isDragging = false;
    hoveredNodeId = null;
    updateHighlights();
  }

  function handleWheel(event: WheelEvent) {
    event.preventDefault();
    zoomTo(event.deltaY > 0 ? 0.9 : 1.1, event.clientX - (container?.getBoundingClientRect().left ?? 0), event.clientY - (container?.getBoundingClientRect().top ?? 0));
  }

  function handleClick(event: MouseEvent) {
    if (!camera || !container || !graph) return;
    const rect = container.getBoundingClientRect();
    pointer.x = (event.clientX - rect.left) / rect.width * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const intersections = raycaster.intersectObjects(Array.from(nodeMeshes.values()));
    if (intersections.length > 0) {
      const mesh = intersections[0].object as THREE.Mesh;
      const nodeId = mesh.userData.nodeId as string;
      const node = graph.nodes.find(n => n.id === nodeId);
      if (node) {
        onSelect(node);
      }
    }
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (!camera) return;
    const step = 24 / camera.zoom;
    switch (event.key) {
      case '+':
      case '=':
        zoomIn();
        break;
      case '-':
      case '_':
        zoomOut();
        break;
      case '0':
        resetView();
        break;
      case 'ArrowLeft':
        camera.position.x -= step;
        updateLabelPositions();
        break;
      case 'ArrowRight':
        camera.position.x += step;
        updateLabelPositions();
        break;
      case 'ArrowUp':
        camera.position.y -= step;
        updateLabelPositions();
        break;
      case 'ArrowDown':
        camera.position.y += step;
        updateLabelPositions();
        break;
      default:
        break;
    }
  }

  $effect(() => {
    if (renderer && scene && camera) {
      void visData;
      buildScene();
    }
  });

  $effect(() => {
    void selected?.id;
    void hoveredNodeId;
    updateHighlights();
  });

  onMount(() => {
    initRenderer();
    const resizeObserver = new ResizeObserver(handleResize);
    if (container) {
      resizeObserver.observe(container);
    }
    return () => {
      resizeObserver.disconnect();
    };
  });

  onDestroy(() => {
    if (frameId !== null) {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
    renderer?.dispose();
    nodeMeshes.clear();
  });
</script>

<div class="rounded-xl border border-[var(--panel-border)] bg-white overflow-hidden">
  <div class="border-b border-[var(--panel-border)] bg-[var(--panel)] px-4 py-2 flex items-center justify-between flex-wrap gap-2">
    <div class="flex items-center gap-3">
      <span class="text-sm font-medium text-[var(--ink)]">Relationship Graph</span>
      <span class="text-xs text-[var(--muted)]">
        {visData.edges.length} edges
      </span>
    </div>
    <div class="flex items-center gap-4 flex-wrap">
      <div class="flex items-center gap-1">
        <button
          type="button"
          onclick={() => showStructural = !showStructural}
          class="px-2 py-1 text-xs rounded-md border transition-colors {showStructural
            ? 'bg-[var(--accent)] text-white border-[var(--accent)]'
            : 'bg-white text-[var(--muted)] border-[var(--panel-border)] hover:bg-[var(--panel)]'}"
          title="Show structural edges (Contains, Defines)"
        >
          Structure
        </button>
        <button
          type="button"
          onclick={() => showSemantic = !showSemantic}
          class="px-2 py-1 text-xs rounded-md border transition-colors {showSemantic
            ? 'bg-[var(--accent)] text-white border-[var(--accent)]'
            : 'bg-white text-[var(--muted)] border-[var(--panel-border)] hover:bg-[var(--panel)]'}"
          title="Show semantic edges (UsesType, Implements, Calls, Derives)"
        >
          Semantic
        </button>
      </div>
      <div class="flex items-center gap-1">
        <button
          type="button"
          onclick={zoomOut}
          class="w-6 h-6 flex items-center justify-center rounded bg-white border border-[var(--panel-border)] text-[var(--muted)] hover:bg-[var(--panel)] text-sm"
          title="Zoom out"
        >−</button>
        <span class="text-xs text-[var(--muted)] w-12 text-center">{Math.round((camera?.zoom ?? 1) * 100)}%</span>
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
    </div>
  </div>
  <button
    type="button"
    class="graph-container three-graph-container relative w-full select-none text-left bg-transparent border-0 p-0"
    aria-label="Three.js relationship graph"
    onmousedown={handleMouseDown}
    onmousemove={handleMouseMove}
    onmouseup={handleMouseUp}
    onmouseleave={handleMouseLeave}
    onwheel={handleWheel}
    onclick={handleClick}
    onkeydown={handleKeyDown}
  >
    <div bind:this={container} class="relative w-full" style="height: 500px;">
      <canvas bind:this={canvasEl} class="absolute inset-0 h-full w-full"></canvas>
      <div class="absolute inset-0 pointer-events-none">
        {#each nodeLabels as label (label.id)}
          {#if label.visible}
            <div
              class="three-node-label {label.isCenter ? 'is-center' : ''}"
              style="transform: translate({label.x}px, {label.y}px) translate(-50%, -50%);"
            >
              {label.text}
            </div>
          {/if}
        {/each}
      </div>
    </div>

    {#if loading}
      <div class="absolute inset-0 flex items-center justify-center bg-white/70">
        <div class="text-center">
          <div class="mb-2 h-8 w-8 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent"></div>
          <p class="text-sm text-[var(--muted)]">Initializing Three.js WebGPU...</p>
        </div>
      </div>
    {:else if initError}
      <div class="absolute inset-0 flex items-center justify-center p-4">
        <div class="text-center">
          <p class="text-sm font-medium text-red-600">WebGPU Unavailable</p>
          <p class="mt-1 text-xs text-[var(--muted)]">{initError}</p>
          <p class="mt-2 text-xs text-[var(--muted)]">Falling back to SVG renderer</p>
        </div>
      </div>
    {/if}
  </button>
</div>
