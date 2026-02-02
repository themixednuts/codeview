<script lang="ts">
  import type { Edge, EdgeKind, Node, NodeKind, Visibility, Graph } from '$lib/graph';
  import type { SelectedEdges } from '$lib/ui';
  import type { LayoutMode } from '$lib/components/LayoutSwitcher.svelte';
  import type { NodeDetail } from '$lib/schema';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { getNodeDetail } from '$lib/graph.remote';
  import { cached, cacheKey } from '$lib/cache.svelte';
  import { CrossEdgeUpdatesConnection } from '$lib/updates.svelte';
  import { Memo } from '$lib/reactivity.svelte';
  import { onDestroy } from 'svelte';
  import { perf } from '$lib/perf';
  import { isHosted } from '$lib/platform';
  import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
  import { Loader2Icon } from '@lucide/svelte';
  import RelationshipGraph from '$lib/components/RelationshipGraph.svelte';
  import LayoutSwitcher from '$lib/components/LayoutSwitcher.svelte';
  import NodeDetails from '$lib/components/NodeDetails.svelte';

  import { themeCtx, getNodeUrlCtx, graphForDisplayCtx, crateVersionsCtx } from '$lib/context';

  let { nodeId, parentHint } = $props<{
    nodeId: string;
    parentHint?: string;
  }>();

  const theme = $derived(themeCtx.get());
  const getNodeUrl = $derived(getNodeUrlCtx.get());
  const graphForDisplay = $derived(graphForDisplayCtx.get());
  const crateVersions = $derived(crateVersionsCtx.get());

  const crateName = $derived(page.params.crate);
  const crateVersion = $derived(page.params.version);
  const edgeUpdates = new CrossEdgeUpdatesConnection();
  const refreshToken = $derived(edgeUpdates.updateTick);

  $effect(() => {
    if (!nodeId || !isHosted) return;
    edgeUpdates.connect(nodeId);
  });
  onDestroy(() => edgeUpdates.destroy());

  const detail: NodeDetail | null = $derived(
    await cached(
      cacheKey('nodeDetail', nodeId, crateVersion),
      getNodeDetail({ nodeId, version: crateVersion, refresh: refreshToken })
    )
  );

  const VALID_LAYOUTS: LayoutMode[] = ['ego', 'force', 'hierarchical', 'radial'];
  const layoutParam = $derived(page.url.searchParams.get('layout'));
  const layoutMode: LayoutMode = $derived(
    VALID_LAYOUTS.includes(layoutParam as LayoutMode) ? (layoutParam as LayoutMode) : 'ego'
  );

  function setLayoutMode(mode: LayoutMode) {
    const url = new URL(page.url);
    if (mode === 'ego') {
      url.searchParams.delete('layout');
    } else {
      url.searchParams.set('layout', mode);
    }
    goto(url.toString(), { replaceState: true, noScroll: true, keepFocus: true });
  }

  // Edge filter toggles — default: structural=off, semantic=on
  const showStructural = $derived(page.url.searchParams.get('structural') === '1');
  const showSemantic = $derived(page.url.searchParams.get('semantic') !== '0');

  function updateSearchParam(key: string, value: string | null) {
    const url = new URL(page.url);
    if (value === null) {
      url.searchParams.delete(key);
    } else {
      url.searchParams.set(key, value);
    }
    goto(url.toString(), { replaceState: true, noScroll: true, keepFocus: true });
  }

  function toggleStructural() {
    updateSearchParam('structural', showStructural ? null : '1');
  }

  function toggleSemantic() {
    updateSearchParam('semantic', showSemantic ? '0' : null);
  }

  const kindLabels: Record<NodeKind, string> = {
    Crate: 'Crate', Module: 'Module', Struct: 'Struct', Union: 'Union',
    Enum: 'Enum', Trait: 'Trait', TraitAlias: 'Trait alias', Impl: 'Impl',
    Function: 'Function', Method: 'Method', TypeAlias: 'Type alias'
  };
  const visibilityLabels: Record<Visibility, string> = {
    Public: 'Public', Crate: 'Crate', Restricted: 'Restricted',
    Inherited: 'Inherited', Unknown: 'Unknown'
  };
  const edgeLabels: Record<EdgeKind, string> = {
    Contains: 'Contains', Defines: 'Defines', UsesType: 'Uses type',
    Implements: 'Implements', CallsStatic: 'Calls', CallsRuntime: 'Runtime calls',
    Derives: 'Derives', ReExports: 'Re-exports'
  };

  const selected = $derived(detail?.node ?? null);

  const selectedEdgesMemo = new Memo<SelectedEdges>(() => {
    if (!detail) return { incoming: [], outgoing: [] };
    return perf.time('derived', 'selectedEdges', () => ({
      incoming: detail!.edges.filter((e) => e.to === detail!.node.id),
      outgoing: detail!.edges.filter((e) => e.from === detail!.node.id)
    }), { detail: (r) => `${r.incoming.length}in ${r.outgoing.length}out` });
  });
  const selectedEdges = $derived(selectedEdgesMemo.current);

  function displayNode(id: string) {
    return detail?.relatedNodes.find((n) => n.id === id)?.name ?? id.split('::').pop() ?? id;
  }

  function nodeExists(nodeId: string): boolean {
    if (graphForDisplay?.nodes.some((n) => n.id === nodeId)) return true;
    return detail?.relatedNodes.some((n) => n.id === nodeId) ?? false;
  }

  function nodeMeta(nodeId: string): { is_external?: boolean; kind?: NodeKind } | undefined {
    return detail?.relatedNodes.find((n) => n.id === nodeId);
  }

  // Build a mini-graph for the relationship graph visualization
  const relationshipGraphMemo = new Memo(
    () => {
      if (!detail) return null;
      return perf.time('derived', 'relationshipGraph', () => {
        const allNodes = [detail!.node, ...detail!.relatedNodes.map((n) => ({
          ...n,
          span: undefined,
          attrs: [],
          fields: undefined,
          variants: undefined,
          signature: undefined,
          generics: undefined,
          docs: undefined,
        } as Node))];
        return { nodes: allNodes, edges: detail!.edges } as Graph;
      }, {
        detail: (r) => `${r.nodes.length}n ${r.edges.length}e`
      });
    },
    (a, b) => a === b || (a != null && b != null && a.nodes.length === b.nodes.length && a.edges === b.edges)
  );
  const relationshipGraph = $derived(relationshipGraphMemo.current);

  function isTraitImpl(node: Node): boolean {
    if (node.kind !== 'Impl') return false;
    return node.impl_type === 'Trait' || node.name.includes(' for ');
  }

  function isInherentImpl(node: Node): boolean {
    if (node.kind !== 'Impl') return false;
    return node.impl_type === 'Inherent' || (!node.name.includes(' for ') && node.impl_type !== 'Trait');
  }

  type MethodGroup = { impl: Node; methods: Node[] };

  const implBlocksMemo = new Memo(() => {
    if (!detail || !selected) return [] as Node[];
    return perf.time('derived', 'implBlocks', () => {
      const relatedMap = new Map(detail!.relatedNodes.map((n) => [n.id, n as Node]));
      const blocks: Node[] = [];
      for (const edge of detail!.edges) {
        if (edge.kind === 'Defines' && edge.from === selected!.id) {
          const target = relatedMap.get(edge.to);
          if (target && isTraitImpl(target)) blocks.push(target);
        }
      }
      return blocks;
    }, { detail: (r) => `${r.length} impls` });
  });
  const implBlocks = $derived(implBlocksMemo.current);

  // Split trait impls into source (user-written) and blanket/auto-trait
  const sourceImpls = $derived(implBlocks.filter((b) => !b.is_external));
  const blanketImpls = $derived(implBlocks.filter((b) => b.is_external));

  // Build a set of impl block IDs for edge filtering
  const implBlockIdsMemo = new Memo(() => new Set(implBlocks.map((b) => b.id)));
  const implBlockIds = $derived(implBlockIdsMemo.current);

  // Filter out redundant edges: Defines→impl and incoming UsesType←impl
  const filteredEdgesMemo = new Memo<SelectedEdges>(() => {
    if (!detail) return { incoming: [], outgoing: [] };
    const isTypeNode = ['Struct', 'Enum', 'Union', 'Trait', 'TraitAlias', 'TypeAlias'].includes(selected?.kind ?? '');
    if (!isTypeNode) return selectedEdges;
    return perf.time('derived', 'detailFilteredEdges', () => ({
      outgoing: selectedEdges.outgoing.filter((e) => {
        if (e.kind === 'Defines' && implBlockIds.has(e.to)) return false;
        return true;
      }),
      incoming: selectedEdges.incoming.filter((e) => {
        if (e.kind === 'UsesType' && implBlockIds.has(e.from)) return false;
        return true;
      })
    }), { detail: (r) => `${r.incoming.length}in ${r.outgoing.length}out` });
  });
  const filteredEdges = $derived(filteredEdgesMemo.current);

  const methodGroupsMemo = new Memo(() => {
    if (!detail || !selected) return [] as MethodGroup[];
    return perf.time('derived', 'methodGroups', () => {
      const relatedMap = new Map(detail!.relatedNodes.map((n) => [n.id, n as Node]));

      const inherentImpls: Node[] = [];
      for (const edge of detail!.edges) {
        if (edge.kind === 'Defines' && edge.from === selected!.id) {
          const target = relatedMap.get(edge.to);
          if (target && isInherentImpl(target)) inherentImpls.push(target);
        }
      }

      const groups = new Map<string, MethodGroup>();
      for (const impl of inherentImpls) {
        groups.set(impl.id, { impl, methods: [] });
      }

      for (const edge of detail!.edges) {
        if ((edge.kind === 'Contains' || edge.kind === 'Defines') && groups.has(edge.from)) {
          const target = relatedMap.get(edge.to);
          if (target && (target.kind === 'Method' || target.kind === 'Function')) {
            groups.get(edge.from)?.methods.push(target);
          }
        }
      }

      return Array.from(groups.values())
        .filter((g) => g.methods.length > 0)
        .map((g) => {
          g.methods.sort((a, b) => a.name.localeCompare(b.name));
          return g;
        });
    }, { detail: (r) => `${r.length} groups, ${r.reduce((s, g) => s + g.methods.length, 0)} methods` });
  });
  const methodGroups = $derived(methodGroupsMemo.current);
</script>

<svelte:boundary>
  {#if selected && detail}
    <div class="space-y-6">
      <!-- Breadcrumbs -->
      {#if graphForDisplay}
        <svelte:boundary>
          <Breadcrumbs graph={graphForDisplay} {selected} {getNodeUrl} {parentHint} />
          {#snippet failed(error, reset)}
            <div class="text-xs text-[var(--danger)]">Failed to load breadcrumbs</div>
          {/snippet}
        </svelte:boundary>
      {/if}

      <!-- Layout Switcher -->
      <div class="flex items-center justify-end">
        <LayoutSwitcher mode={layoutMode} onModeChange={setLayoutMode} />
      </div>

      <!-- Visual Relationship Graph -->
      {#if relationshipGraph}
        <svelte:boundary>
          <RelationshipGraph
            graph={relationshipGraph}
            {selected}
            {getNodeUrl}
            {layoutMode}
            {showStructural}
            {showSemantic}
            onToggleStructural={toggleStructural}
            onToggleSemantic={toggleSemantic}
          />
          {#snippet failed(error, reset)}
            <div class="rounded-[var(--radius-card)] corner-squircle border border-[var(--danger-border)] bg-[var(--danger-bg)] p-4 text-sm text-[var(--danger)]">
              <p class="font-medium">Failed to render relationship graph</p>
              <button type="button" class="mt-2 text-[var(--accent)] hover:underline" onclick={reset}>Try again</button>
            </div>
          {/snippet}
        </svelte:boundary>
      {/if}

      <!-- Node Details -->
      <svelte:boundary>
        <NodeDetails
          {selected}
          selectedEdges={filteredEdges}
          {sourceImpls}
          {blanketImpls}
          {methodGroups}
          {kindLabels}
          {visibilityLabels}
          {edgeLabels}
          {displayNode}
          {theme}
          {getNodeUrl}
          {nodeExists}
          {nodeMeta}
          {crateName}
          {crateVersion}
          {crateVersions}
        />
        {#snippet failed(error, reset)}
          <div class="rounded-[var(--radius-card)] corner-squircle border border-[var(--danger-border)] bg-[var(--danger-bg)] p-4 text-sm text-[var(--danger)]">
            <p class="font-medium">Failed to render node details</p>
            <button type="button" class="mt-2 text-[var(--accent)] hover:underline" onclick={reset}>Try again</button>
          </div>
        {/snippet}
      </svelte:boundary>
    </div>
  {:else}
    <div class="flex h-full items-center justify-center">
      <div class="text-center text-[var(--muted)]">
        <p class="text-lg">Node not found</p>
        <p class="mt-1 text-sm">The requested item could not be found in the graph.</p>
      </div>
    </div>
  {/if}

  {#snippet pending()}
    <div class="flex h-full items-center justify-center">
      <div class="flex items-center gap-2 text-sm text-[var(--muted)]">
        <Loader2Icon class="animate-spin" size={16} />
        Loading...
      </div>
    </div>
  {/snippet}

  {#snippet failed(error, reset)}
    <div class="flex h-full items-center justify-center p-6">
      <div class="rounded-[var(--radius-card)] corner-squircle border border-[var(--danger-border)] bg-[var(--danger-bg)] p-6 text-center max-w-md">
        <p class="font-medium text-[var(--danger)]">Something went wrong</p>
        <p class="mt-2 text-sm text-[var(--muted)]">An error occurred while loading this node.</p>
        <button type="button" class="mt-4 rounded-[var(--radius-control)] corner-squircle bg-[var(--accent)] px-4 py-2 text-sm text-white hover:opacity-90" onclick={reset}>
          Reload
        </button>
      </div>
    </div>
  {/snippet}
</svelte:boundary>
