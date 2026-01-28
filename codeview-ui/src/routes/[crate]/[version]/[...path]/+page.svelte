<script lang="ts">
  import type { Edge, EdgeKind, Graph, Node, NodeKind, Visibility, ImplType } from '$lib/graph';
  import type { SelectedEdges } from '$lib/ui';
  import type { LayoutMode } from '$lib/components/LayoutSwitcher.svelte';
  import { page } from '$app/state';
  import { getNodeDetail } from '$lib/graph.remote';
  import { nodeIdFromPath } from '$lib/url';
  import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
  import RelationshipGraph from '$lib/components/RelationshipGraph.svelte';
  import LayoutSwitcher from '$lib/components/LayoutSwitcher.svelte';
  import NodeDetails from '$lib/components/NodeDetails.svelte';

  import { getContext } from 'svelte';

  const theme = $derived(getContext<() => 'light' | 'dark'>('theme')());
  const getNodeUrl = $derived(getContext<() => (id: string) => string>('getNodeUrl')());
  const graphForDisplay = $derived(getContext<() => { nodes: Node[]; edges: Edge[] } | null>('graphForDisplay')());

  const nodeId = $derived(nodeIdFromPath(page.params.crate, page.params.path));
  const detailQuery = $derived(getNodeDetail(nodeId));
  const detail = $derived(detailQuery.current);
  const selected = $derived(detail?.node ?? null);
  let layoutMode = $state<LayoutMode>('ego');

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

  const selectedEdges = $derived.by<SelectedEdges>(() => {
    if (!detail) return { incoming: [], outgoing: [] };
    return {
      incoming: detail.edges.filter((e) => e.to === detail.node.id),
      outgoing: detail.edges.filter((e) => e.from === detail.node.id)
    };
  });

  function displayNode(id: string) {
    return detail?.relatedNodes.find((n) => n.id === id)?.name ?? id.split('::').pop() ?? id;
  }

  function nodeExists(nodeId: string): boolean {
    return detail?.relatedNodes.some((n) => n.id === nodeId) ?? false;
  }

  // Build a mini-graph for the relationship graph visualization
  const relationshipGraph = $derived.by(() => {
    if (!detail) return null;
    const allNodes = [detail.node, ...detail.relatedNodes.map((n) => ({
      ...n,
      span: undefined,
      attrs: [],
      fields: undefined,
      variants: undefined,
      signature: undefined,
      generics: undefined,
      docs: undefined,
    } as Node))];
    return { nodes: allNodes, edges: detail.edges } as Graph;
  });

  function isTraitImpl(node: Node): boolean {
    if (node.kind !== 'Impl') return false;
    return node.impl_type === 'Trait' || node.name.includes(' for ');
  }

  function isInherentImpl(node: Node): boolean {
    if (node.kind !== 'Impl') return false;
    return node.impl_type === 'Inherent' || (!node.name.includes(' for ') && node.impl_type !== 'Trait');
  }

  type MethodGroup = { impl: Node; methods: Node[] };

  const implBlocks = $derived.by(() => {
    if (!detail || !selected) return [];
    const relatedMap = new Map(detail.relatedNodes.map((n) => [n.id, n as Node]));
    const blocks: Node[] = [];
    for (const edge of detail.edges) {
      if (edge.kind === 'Defines' && edge.from === selected.id) {
        const target = relatedMap.get(edge.to);
        if (target && isTraitImpl(target)) blocks.push(target);
      }
    }
    return blocks;
  });

  const methodGroups = $derived.by(() => {
    if (!detail || !selected) return [] as MethodGroup[];
    const relatedMap = new Map(detail.relatedNodes.map((n) => [n.id, n as Node]));

    const inherentImpls: Node[] = [];
    for (const edge of detail.edges) {
      if (edge.kind === 'Defines' && edge.from === selected.id) {
        const target = relatedMap.get(edge.to);
        if (target && isInherentImpl(target)) inherentImpls.push(target);
      }
    }

    const groups = new Map<string, MethodGroup>();
    for (const impl of inherentImpls) {
      groups.set(impl.id, { impl, methods: [] });
    }

    for (const edge of detail.edges) {
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
  });
</script>

{#if detailQuery.loading}
  <div class="text-sm text-[var(--muted)]">Loading...</div>
{:else if selected && detail}
  <div class="space-y-6">
    <!-- Breadcrumbs -->
    {#if graphForDisplay}
      <svelte:boundary>
        <Breadcrumbs graph={graphForDisplay} {selected} {getNodeUrl} />
        {#snippet failed(error, reset)}
          <div class="text-xs text-[var(--danger)]">Failed to load breadcrumbs</div>
        {/snippet}
      </svelte:boundary>
    {/if}

    <!-- Layout Switcher -->
    <div class="flex items-center justify-between">
      <h2 class="text-sm font-medium text-[var(--muted)]">Relationship Graph</h2>
      <LayoutSwitcher mode={layoutMode} onModeChange={(m) => layoutMode = m} />
    </div>

    <!-- Visual Relationship Graph -->
    {#if relationshipGraph}
      <svelte:boundary>
        <RelationshipGraph
          graph={relationshipGraph}
          {selected}
          {getNodeUrl}
          {layoutMode}
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
        {selectedEdges}
        {implBlocks}
        {methodGroups}
        {kindLabels}
        {visibilityLabels}
        {edgeLabels}
        {displayNode}
        {theme}
        {getNodeUrl}
        {nodeExists}
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
