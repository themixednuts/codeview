<script lang="ts">
  import { page } from '$app/state';
  import { getContext } from 'svelte';
  import { getNodeDetail } from '$lib/graph.remote';
  import NodeDetails from '$lib/components/NodeDetails.svelte';
  import type { Edge, Node, EdgeKind, NodeKind, Visibility } from '$lib/graph';

  const theme = $derived(getContext<() => 'light' | 'dark'>('theme')());
  const getNodeUrl = $derived(getContext<() => (id: string) => string>('getNodeUrl')());

  const crateName = $derived(page.params.crate);
  const detailQuery = $derived(getNodeDetail(crateName));

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

  const detail = $derived(detailQuery.current);
  const selected = $derived(detail?.node ?? null);
  const selectedEdges = $derived.by(() => {
    if (!detail) return { incoming: [], outgoing: [] };
    return {
      incoming: detail.edges.filter((e) => e.to === detail.node.id),
      outgoing: detail.edges.filter((e) => e.from === detail.node.id)
    };
  });

  function displayNode(id: string) {
    return detail?.relatedNodes.find((n) => n.id === id)?.name ?? id.split('::').pop() ?? id;
  }
</script>

{#if detailQuery.loading}
  <div class="text-sm text-[var(--muted)]">Loading...</div>
{:else if selected}
  <NodeDetails
    {selected}
    {selectedEdges}
    implBlocks={[]}
    methodGroups={[]}
    {kindLabels}
    {visibilityLabels}
    {edgeLabels}
    {displayNode}
    {theme}
    {getNodeUrl}
  />
{:else}
  <div class="flex h-full items-center justify-center">
    <div class="text-center text-[var(--muted)]">
      <p class="text-lg">Crate overview</p>
      <p class="mt-1 text-sm">Select an item from the tree to view its details</p>
    </div>
  </div>
{/if}
