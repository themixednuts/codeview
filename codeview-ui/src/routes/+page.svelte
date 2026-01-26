<script lang="ts">
  import type {
    ArgumentInfo,
    Confidence,
    Edge,
    EdgeKind,
    FieldInfo,
    FunctionSignature,
    Graph,
    Node,
    NodeKind,
    Span,
    VariantInfo,
    Visibility
  } from '$lib/graph';
  import { SvelteSet } from 'svelte/reactivity';
  import { sampleGraph } from '$lib/sample-graph';
  import GraphTree from '$lib/components/GraphTree.svelte';
  import NodeDetails from '$lib/components/NodeDetails.svelte';
  import RelationshipGraph from '$lib/components/RelationshipGraph.svelte';
  import type { SelectedEdges } from '$lib/ui';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { browser } from '$app/environment';

  // Use $state.raw to avoid deep proxy overhead for large graphs
  let graph = $state.raw<Graph | null>(sampleGraph);
  let loadError = $state<string | null>(null);
  let loading = $state(false);
  let filter = $state('');
  let hideExternal = $state(true);
  let selectedId = $state<string | null>(null);
  const kindFilter = new SvelteSet<NodeKind>();

  const selected = $derived.by(() => {
    if (!graph || !selectedId) return null;
    return graph.nodes.find((node) => node.id === selectedId) ?? null;
  });

  function syncUrl() {
    if (!browser) return;
    const params = new URLSearchParams();
    if (selectedId) params.set('node', selectedId);
    if (!hideExternal) params.set('deps', 'show');
    if (filter) params.set('q', filter);
    const search = params.toString();
    const nextUrl = search ? `${page.url.pathname}?${search}` : page.url.pathname;
    const currentUrl = page.url.pathname + page.url.search;
    if (nextUrl === currentUrl) return;
    goto(nextUrl, { replaceState: true, keepFocus: true, noScroll: true });
  }

  function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : 'Unknown error.';
  }

  $effect(() => {
    if (!browser) return;
    const params = page.url.searchParams;
    const nextFilter = params.get('q') ?? '';
    const nextHideExternal = params.get('deps') !== 'show';
    const nextSelectedId = params.get('node');

    if (filter !== nextFilter) {
      filter = nextFilter;
    }
    if (hideExternal !== nextHideExternal) {
      hideExternal = nextHideExternal;
    }
    if (selectedId !== nextSelectedId) {
      selectedId = nextSelectedId;
    }
  });

  function updateFilter(value: string) {
    if (value === filter) return;
    filter = value;
    syncUrl();
  }

  function updateHideExternal(value: boolean) {
    if (value === hideExternal) return;
    hideExternal = value;
    syncUrl();
  }

  const nodeKindOrder: NodeKind[] = [
    'Crate',
    'Module',
    'Struct',
    'Enum',
    'Trait',
    'Impl',
    'Function',
    'Method',
    'TypeAlias',
    'Union',
    'TraitAlias'
  ];

  const nodeKindSet = new Set<NodeKind>(nodeKindOrder);
  const visibilitySet = new Set<Visibility>([
    'Public',
    'Crate',
    'Restricted',
    'Inherited',
    'Unknown'
  ]);
  const edgeKindSet = new Set<EdgeKind>([
    'Contains',
    'Defines',
    'UsesType',
    'Implements',
    'CallsStatic',
    'CallsRuntime',
    'Derives'
  ]);
  const confidenceSet = new Set<Confidence>(['Static', 'Runtime', 'Inferred']);

  const kindLabels: Record<NodeKind, string> = {
    Crate: 'Crate',
    Module: 'Module',
    Struct: 'Struct',
    Union: 'Union',
    Enum: 'Enum',
    Trait: 'Trait',
    TraitAlias: 'Trait alias',
    Impl: 'Impl',
    Function: 'Function',
    Method: 'Method',
    TypeAlias: 'Type alias'
  };

  const edgeLabels: Record<EdgeKind, string> = {
    Contains: 'Contains',
    Defines: 'Defines',
    UsesType: 'Uses type',
    Implements: 'Implements',
    CallsStatic: 'Calls',
    CallsRuntime: 'Runtime calls',
    Derives: 'Derives'
  };

  const visibilityLabels: Record<Visibility, string> = {
    Public: 'Public',
    Crate: 'Crate',
    Restricted: 'Restricted',
    Inherited: 'Inherited',
    Unknown: 'Unknown'
  };

  // Filter graph to hide external crates if enabled
  let filteredGraph = $derived.by(() => {
    if (!graph) return null;
    if (!hideExternal) return graph;

    // Get IDs of non-external nodes
    const nonExternalIds = new Set(
      graph.nodes.filter((n) => !n.is_external).map((n) => n.id)
    );

    return {
      nodes: graph.nodes.filter((n) => !n.is_external),
      edges: graph.edges.filter((e) => nonExternalIds.has(e.from) && nonExternalIds.has(e.to))
    };
  });

  let stats = $derived({
    nodeCount: filteredGraph?.nodes.length ?? 0,
    edgeCount: filteredGraph?.edges.length ?? 0,
    totalNodeCount: graph?.nodes.length ?? 0,
    externalCount: graph?.nodes.filter((n) => n.is_external).length ?? 0,
    kindCounts: nodeKindOrder
      .map((kind) => ({
        kind,
        count: filteredGraph?.nodes.filter((n) => n.kind === kind).length ?? 0
      }))
      .filter((e) => e.count > 0)
  });

  const visibleSelected = $derived.by(() => {
    if (!selected || !filteredGraph) return null;
    return filteredGraph.nodes.some((node) => node.id === selected.id) ? selected : null;
  });

  const selectedEdges = $derived.by<SelectedEdges>(() => {
    if (!filteredGraph || !visibleSelected) {
      return { incoming: [], outgoing: [] };
    }
    return {
      incoming: filteredGraph.edges.filter((edge) => edge.to === visibleSelected.id),
      outgoing: filteredGraph.edges.filter((edge) => edge.from === visibleSelected.id)
    };
  });

  function displayNode(id: string) {
    return graph?.nodes.find((node) => node.id === id)?.name ?? id;
  }

  function handleSelect(node: Node) {
    if (node.id === selectedId) return;
    selectedId = node.id;
    syncUrl();
  }

  function resetGraph() {
    graph = sampleGraph;
    loadError = null;
    filter = '';
    hideExternal = true;
    selectedId = null;
    kindFilter.clear();
    syncUrl();
  }

  // Web Worker for parsing large JSON files (> 100KB) to keep UI responsive
  const WORKER_THRESHOLD = 100 * 1024;
  let jsonWorker: Worker | null = null;

  function getJsonWorker(): Worker {
    if (!jsonWorker) {
      jsonWorker = new Worker(
        new URL('$lib/workers/json-parser.ts', import.meta.url),
        { type: 'module' }
      );
    }
    return jsonWorker;
  }

  async function parseJsonWithWorker(text: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const worker = getJsonWorker();
      const handler = (event: MessageEvent) => {
        worker.removeEventListener('message', handler);
        if (event.data.type === 'success') {
          resolve(event.data.data);
        } else {
          reject(new Error(event.data.error));
        }
      };
      worker.addEventListener('message', handler);
      worker.postMessage({ type: 'parse', text });
    });
  }

  async function handleFileChange(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    loading = true;
    loadError = null;
    try {
      const text = await file.text();

      let parsed: unknown;
      if (text.length > WORKER_THRESHOLD) {
        // Use worker for large files to keep UI responsive
        parsed = await parseJsonWithWorker(text);
      } else {
        parsed = JSON.parse(text);
      }

      const nextGraph = parseGraph(parsed);
      if (!nextGraph) {
        throw new Error('Invalid Codeview graph format.');
      }
      graph = nextGraph;
      filter = '';
      hideExternal = true;
      selectedId = null;
      kindFilter.clear();
      syncUrl();
    } catch (error) {
      loadError = error instanceof Error ? error.message : 'Failed to load graph JSON.';
    } finally {
      loading = false;
      input.value = '';
    }
  }

  function parseGraph(payload: unknown): Graph | null {
    if (!payload || typeof payload !== 'object') return null;
    const data = payload as { nodes?: unknown; edges?: unknown };
    if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) return null;

    const parseNodeKind = (value: unknown): NodeKind =>
      nodeKindSet.has(value as NodeKind) ? (value as NodeKind) : 'Module';
    const parseVisibility = (value: unknown): Visibility =>
      visibilitySet.has(value as Visibility) ? (value as Visibility) : 'Unknown';
    const parseEdgeKind = (value: unknown): EdgeKind =>
      edgeKindSet.has(value as EdgeKind) ? (value as EdgeKind) : 'UsesType';
    const parseConfidence = (value: unknown): Confidence =>
      confidenceSet.has(value as Confidence) ? (value as Confidence) : 'Inferred';

    const parseSpan = (value: unknown): Node['span'] => {
      if (!value || typeof value !== 'object') return null;
      const span = value as Partial<Span>;
      if (typeof span.file !== 'string') return null;
      if (!Number.isFinite(span.line) || !Number.isFinite(span.column)) return null;
      return {
        file: span.file,
        line: Math.max(1, Number(span.line)),
        column: Math.max(1, Number(span.column))
      };
    };

    const parseFields = (value: unknown): FieldInfo[] | null => {
      if (!Array.isArray(value)) return null;
      const fields = value
        .filter((field) => field && typeof field === 'object')
        .map((field) => {
          const entry = field as Partial<FieldInfo>;
          if (typeof entry.name !== 'string' || typeof entry.type_name !== 'string') return null;
          return {
            name: entry.name,
            type_name: entry.type_name,
            visibility: parseVisibility(entry.visibility)
          };
        })
        .filter((field): field is FieldInfo => field !== null);
      return fields.length > 0 ? fields : null;
    };

    const parseVariants = (value: unknown): VariantInfo[] | null => {
      if (!Array.isArray(value)) return null;
      const variants = value
        .filter((variant) => variant && typeof variant === 'object')
        .map((variant) => {
          const entry = variant as Partial<VariantInfo>;
          if (typeof entry.name !== 'string') return null;
          const fields = Array.isArray(entry.fields) ? parseFields(entry.fields) ?? [] : [];
          return { name: entry.name, fields };
        })
        .filter((variant): variant is VariantInfo => variant !== null);
      return variants.length > 0 ? variants : null;
    };

    const parseSignature = (value: unknown): FunctionSignature | null => {
      if (!value || typeof value !== 'object') return null;
      const entry = value as Partial<FunctionSignature>;
      const inputs = Array.isArray(entry.inputs)
        ? entry.inputs
            .filter((input) => input && typeof input === 'object')
            .map((input) => {
              const arg = input as Partial<ArgumentInfo>;
              if (typeof arg.name !== 'string' || typeof arg.type_name !== 'string') return null;
              return { name: arg.name, type_name: arg.type_name };
            })
            .filter((input): input is ArgumentInfo => input !== null)
        : [];
      return {
        inputs,
        output: typeof entry.output === 'string' ? entry.output : null,
        is_async: entry.is_async === true,
        is_unsafe: entry.is_unsafe === true,
        is_const: entry.is_const === true
      };
    };

    const nodes = data.nodes
      .filter((node) => node && typeof node === 'object')
      .map((node, index) => {
        const entry = node as Partial<Node>;
        const id = typeof entry.id === 'string' && entry.id.length > 0
          ? entry.id
          : `unknown-${index}`;
        const name = typeof entry.name === 'string' && entry.name.length > 0
          ? entry.name
          : id;
        return {
          id,
          name,
          kind: parseNodeKind(entry.kind),
          visibility: parseVisibility(entry.visibility),
          span: parseSpan(entry.span),
          attrs: Array.isArray(entry.attrs)
            ? entry.attrs.filter((attr): attr is string => typeof attr === 'string')
            : [],
          is_external: entry.is_external === true,
          fields: parseFields(entry.fields),
          variants: parseVariants(entry.variants),
          signature: parseSignature(entry.signature),
          generics: Array.isArray(entry.generics)
            ? entry.generics.filter((generic): generic is string => typeof generic === 'string')
            : null,
          docs: typeof entry.docs === 'string' ? entry.docs : null
        } as Node;
      });

    const edges = data.edges
      .filter((edge) => edge && typeof edge === 'object')
      .map((edge) => {
        const entry = edge as Partial<Edge>;
        if (typeof entry.from !== 'string' || typeof entry.to !== 'string') return null;
        return {
          from: entry.from,
          to: entry.to,
          kind: parseEdgeKind(entry.kind),
          confidence: parseConfidence(entry.confidence)
        } as Edge;
      })
      .filter((edge): edge is Edge => edge !== null);

    return { nodes, edges };
  }

  function toggleKindFilter(kind: NodeKind) {
    if (kindFilter.has(kind)) {
      kindFilter.delete(kind);
    } else {
      kindFilter.add(kind);
    }
  }
</script>

<svelte:head>
  <title>Codeview</title>
</svelte:head>

<div class="flex h-screen flex-col bg-[var(--bg)]">
  <!-- Header -->
  <header class="flex items-center justify-between border-b border-[var(--panel-border)] bg-white/80 px-4 py-2">
    <div class="flex items-center gap-4">
      <h1 class="text-lg font-semibold text-[var(--ink)]">Codeview</h1>
      <div class="flex items-center gap-2 text-sm text-[var(--muted)]">
        <span>{stats.nodeCount} nodes</span>
        <span class="text-[var(--panel-border)]">|</span>
        <span>{stats.edgeCount} edges</span>
      </div>
    </div>
    <div class="flex items-center gap-2">
      {#if stats.externalCount > 0}
        <label class="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--panel-border)] bg-white px-3 py-1.5 text-sm text-[var(--muted)] hover:bg-[var(--panel)]">
          <input
            type="checkbox"
            bind:checked={() => hideExternal, updateHideExternal}
            class="accent-[var(--accent)]"
          />
          <span>Hide deps ({stats.externalCount})</span>
        </label>
      {/if}
      <label
        class="cursor-pointer rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--accent-strong)]"
      >
        Load JSON
        <input type="file" accept=".json" class="hidden" onchange={handleFileChange} />
      </label>
      <button
        type="button"
        class="rounded-lg border border-[var(--panel-border)] bg-white px-3 py-1.5 text-sm text-[var(--muted)] hover:bg-[var(--panel)]"
        onclick={resetGraph}
      >
        Reset
      </button>
    </div>
  </header>

  {#if loadError}
    <div class="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
      {loadError}
    </div>
  {/if}

  <!-- Main content -->
  <div class="flex flex-1 overflow-hidden">
    <!-- Left sidebar: Tree view -->
    <div class="flex w-80 flex-col border-r border-[var(--panel-border)] bg-white/60">
      <!-- Search -->
      <div class="border-b border-[var(--panel-border)] p-2">
        <input
          type="text"
          placeholder="Search items..."
          class="w-full rounded-lg border border-[var(--panel-border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
          bind:value={() => filter, updateFilter}
        />
      </div>

      <!-- Kind filters -->
      <div class="flex flex-wrap gap-1 border-b border-[var(--panel-border)] p-2">
        {#each stats.kindCounts as { kind, count } (kind)}
          <button
            type="button"
            class="rounded-full px-2 py-0.5 text-xs {kindFilter.has(kind)
              ? 'bg-[var(--accent)] text-white'
              : 'bg-[var(--panel)] text-[var(--muted)] hover:bg-[var(--panel-strong)]'}"
            onclick={() => toggleKindFilter(kind)}
          >
            {kindLabels[kind]} ({count})
          </button>
        {/each}
      </div>

      <!-- Tree -->
      <div class="flex-1 overflow-hidden">
        <svelte:boundary>
          <GraphTree
            graph={filteredGraph}
            selected={visibleSelected}
            onSelect={handleSelect}
            filter={filter}
            {kindFilter}
          />
          {#snippet failed(error, reset)}
            <div class="p-4 text-sm text-red-600">
              <p class="font-medium">Failed to render tree</p>
              <p class="mt-1 text-xs text-[var(--muted)]">{errorMessage(error)}</p>
              <button type="button" class="mt-2 text-[var(--accent)] hover:underline" onclick={reset}>Try again</button>
            </div>
          {/snippet}
        </svelte:boundary>
      </div>
    </div>

    <!-- Right panel: Details -->
    <div class="flex-1 overflow-auto bg-[var(--bg)] p-6">
      {#if visibleSelected && filteredGraph}
        <div class="space-y-6">
          <!-- Visual Relationship Graph -->
          <svelte:boundary>
            <RelationshipGraph graph={filteredGraph} selected={visibleSelected} onSelect={handleSelect} />
            {#snippet failed(error, reset)}
              <div class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-600">
                <p class="font-medium">Failed to render relationship graph</p>
                <p class="mt-1 text-xs">{errorMessage(error)}</p>
                <button type="button" class="mt-2 text-[var(--accent)] hover:underline" onclick={reset}>Try again</button>
              </div>
            {/snippet}
          </svelte:boundary>

          <!-- Detailed Info -->
          <svelte:boundary>
            <NodeDetails
              selected={visibleSelected}
              {selectedEdges}
              {kindLabels}
              {visibilityLabels}
              {edgeLabels}
              {displayNode}
            />
            {#snippet failed(error, reset)}
              <div class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-600">
                <p class="font-medium">Failed to render node details</p>
                <p class="mt-1 text-xs">{errorMessage(error)}</p>
                <button type="button" class="mt-2 text-[var(--accent)] hover:underline" onclick={reset}>Try again</button>
              </div>
            {/snippet}
          </svelte:boundary>
        </div>
      {:else}
        <div class="flex h-full items-center justify-center">
          <div class="text-center text-[var(--muted)]">
            <p class="text-lg">Select an item from the tree</p>
            <p class="mt-1 text-sm">Click on any item to view its details, fields, and relationships</p>
          </div>
        </div>
      {/if}
    </div>
  </div>
</div>
