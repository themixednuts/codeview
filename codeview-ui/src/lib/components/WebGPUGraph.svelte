<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { base } from '$app/paths';
  import type { Graph, Node } from '$lib/graph';

  interface Props {
    graph: Graph | null;
    selected: Node | null;
    onSelect: (node: Node) => void;
    layoutMode?: 'ego' | 'force' | 'hierarchical' | 'radial';
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

  let canvas = $state<HTMLCanvasElement | null>(null);
  let container = $state<HTMLDivElement | null>(null);
  let renderer = $state<any | null>(null);
  let isWebGPUAvailable = $state(false);
  let initError = $state<string | null>(null);
  let loading = $state(true);
  let pixelRatio = $state(1);
  let frameId: number | null = null;
  let fallbackTriggered = $state(false);

  // Mouse state for pan/zoom
  let isDragging = false;
  let lastMouseX = 0;
  let lastMouseY = 0;

  const wasmModuleUrl = `${base}/wasm/codeview-render/codeview_render.js`;

  function triggerFallback(message: string) {
    initError = message;
    loading = false;
    if (!fallbackTriggered) {
      fallbackTriggered = true;
      onFallback?.();
    }
  }

  async function loadWasmModule() {
    try {
      const wasm = await import(/* @vite-ignore */ wasmModuleUrl);
      if (typeof wasm.default === 'function') {
        await wasm.default();
      }
      return wasm;
    } catch (error) {
      throw new Error(
        'WebGPU module not found. Build with "wasm-pack build codeview-render --target web --features web" and copy "codeview-render/pkg" to "codeview-ui/static/wasm/codeview-render".'
      );
    }
  }

  // Try to load the WASM module
  async function initRenderer() {
    loading = true;
    initError = null;
    fallbackTriggered = false;

    try {
      if (!canvas || !container) {
        requestAnimationFrame(initRenderer);
        return;
      }
      // Dynamic import of the WASM module
      const wasm = await loadWasmModule();

      // Check if WebGPU is available
      isWebGPUAvailable = wasm.isWebGPUAvailable();

      if (!isWebGPUAvailable) {
        triggerFallback(
          'WebGPU is not available in your browser. Try Chrome 113+, Edge 113+, or Firefox 141+.'
        );
        return;
      }

      // Create the renderer
      pixelRatio = window.devicePixelRatio || 1;
      const rect = container.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width * pixelRatio));
      const height = Math.max(1, Math.floor(rect.height * pixelRatio));
      canvas.width = width;
      canvas.height = height;

      renderer = await wasm.GraphRenderer.create(canvas);

      // Load graph if available
      if (graph) {
        renderer.loadGraph(JSON.stringify(graph));
      }

      // Set initial layout mode
      renderer.setLayoutMode(layoutMode);

      // Set center node if specified
      if (centerNode) {
        renderer.setCenterNode(centerNode);
      } else if (selected) {
        renderer.setCenterNode(selected.id);
      }

      // Start render loop
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      frameId = requestAnimationFrame(renderLoop);

      loading = false;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to initialize WebGPU renderer';
      triggerFallback(message);
    }
  }

  function renderLoop() {
    if (!renderer) {
      frameId = null;
      return;
    }

    try {
      renderer.render();
    } catch {
      // Handle render errors gracefully
    }

    frameId = requestAnimationFrame(renderLoop);
  }

  function handleMouseDown(event: MouseEvent) {
    if (event.button !== 0) return;
    if (!canvas) return;
    isDragging = true;
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;
    canvas.style.cursor = 'grabbing';
  }

  function handleMouseMove(event: MouseEvent) {
    if (!renderer) return;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * pixelRatio;
    const y = (event.clientY - rect.top) * pixelRatio;

    if (isDragging) {
      const dx = (event.clientX - lastMouseX) * pixelRatio;
      const dy = (event.clientY - lastMouseY) * pixelRatio;
      renderer.pan(dx, dy);
      lastMouseX = event.clientX;
      lastMouseY = event.clientY;
    } else {
      // Hit test for hover
      const nodeId = renderer.hitTest(x, y);
      renderer.setHovered(nodeId);
    }
  }

  function handleMouseUp() {
    isDragging = false;
    if (canvas) {
      canvas.style.cursor = 'grab';
    }
  }

  function handleMouseLeave() {
    if (renderer) {
      renderer.setHovered(null);
    }
    isDragging = false;
    if (canvas) {
      canvas.style.cursor = 'grab';
    }
  }

  function handleClick(event: MouseEvent) {
    if (!renderer || !graph) return;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * pixelRatio;
    const y = (event.clientY - rect.top) * pixelRatio;

    const nodeId = renderer.hitTest(x, y);
    if (nodeId) {
      const node = graph.nodes.find(n => n.id === nodeId);
      if (node) {
        onSelect(node);
      }
    }
  }

  function handleWheel(event: WheelEvent) {
    if (!renderer) return;
    if (!canvas) return;
    event.preventDefault();

    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * pixelRatio;
    const y = (event.clientY - rect.top) * pixelRatio;

    const factor = event.deltaY > 0 ? 0.9 : 1.1;
    renderer.zoom(factor, x, y);
  }

  function handleResize() {
    if (!renderer || !container || !canvas) return;

    const rect = container.getBoundingClientRect();
    pixelRatio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(rect.width * pixelRatio));
    const height = Math.max(1, Math.floor(rect.height * pixelRatio));

    if (width > 0 && height > 0) {
      canvas.width = width;
      canvas.height = height;
      renderer.resize(width, height);
    }
  }

  function resetView() {
    if (renderer) {
      renderer.resetView();
    }
  }

  // Watch for graph changes
  $effect(() => {
    if (renderer && graph) {
      renderer.loadGraph(JSON.stringify(graph));
    }
  });

  // Watch for layout mode changes
  $effect(() => {
    if (renderer) {
      renderer.setLayoutMode(layoutMode);
    }
  });

  // Watch for center node changes
  $effect(() => {
    if (renderer) {
      const center = centerNode ?? selected?.id ?? null;
      renderer.setCenterNode(center);
    }
  });

  // Watch for selection changes
  $effect(() => {
    if (renderer) {
      renderer.setSelected(selected?.id ?? null);
    }
  });

  onMount(() => {
    initRenderer();

    // Set up resize observer
    const resizeObserver = new ResizeObserver(handleResize);
    if (container) {
      resizeObserver.observe(container);
    }

    return () => {
      resizeObserver.disconnect();
    };
  });

  onDestroy(() => {
    renderer = null;
    if (frameId !== null) {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
  });
</script>

<div
  bind:this={container}
  class="relative h-full w-full overflow-hidden rounded-xl border border-[var(--panel-border)] bg-[var(--panel)]"
>
  <!-- Canvas -->
  <canvas
    bind:this={canvas}
    class="h-full w-full cursor-grab"
    onmousedown={handleMouseDown}
    onmousemove={handleMouseMove}
    onmouseup={handleMouseUp}
    onmouseleave={handleMouseLeave}
    onclick={handleClick}
    onwheel={handleWheel}
  ></canvas>

  {#if !loading && !initError}
    <!-- Controls overlay -->
    <div class="absolute right-2 top-2 z-10 flex gap-1">
      <button
        type="button"
        class="rounded bg-white/90 px-2 py-1 text-xs shadow hover:bg-white"
        onclick={resetView}
        title="Reset view"
      >
        Reset
      </button>
    </div>
  {/if}

  {#if loading}
    <div class="absolute inset-0 flex items-center justify-center">
      <div class="text-center">
        <div class="mb-2 h-8 w-8 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent"></div>
        <p class="text-sm text-[var(--muted)]">Initializing WebGPU...</p>
      </div>
    </div>
  {:else if initError}
    <div class="absolute inset-0 flex items-center justify-center p-4">
      <div class="text-center">
        <p class="text-sm font-medium text-red-600">WebGPU Unavailable</p>
        <p class="mt-1 text-xs text-[var(--muted)]">{initError}</p>
        <p class="mt-2 text-xs text-[var(--muted)]">
          Falling back to SVG renderer
        </p>
      </div>
    </div>
  {/if}
</div>
