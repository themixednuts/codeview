<script lang="ts">
  import type { Edge, EdgeKind, Node, NodeKind, Visibility } from '$lib/graph';
  import type { SelectedEdges } from '$lib/ui';
  import Documentation from './Documentation.svelte';
  import CodeBlock from './CodeBlock.svelte';
  import CollapsibleSection from './CollapsibleSection.svelte';

  let {
    selected,
    selectedEdges,
    implBlocks,
    kindLabels,
    visibilityLabels,
    edgeLabels,
    displayNode
  } = $props<{
    selected: Node | null;
    selectedEdges: SelectedEdges;
    implBlocks: Node[];
    kindLabels: Record<NodeKind, string>;
    visibilityLabels: Record<Visibility, string>;
    edgeLabels: Record<EdgeKind, string>;
    displayNode: (id: string) => string;
  }>();

  // Track collapsible section refs for expand/collapse all
  let genericsRef = $state<CollapsibleSection | null>(null);
  let signatureRef = $state<CollapsibleSection | null>(null);
  let fieldsRef = $state<CollapsibleSection | null>(null);
  let variantsRef = $state<CollapsibleSection | null>(null);
  let docsRef = $state<CollapsibleSection | null>(null);
  let implsRef = $state<CollapsibleSection | null>(null);
  let relationshipsRef = $state<CollapsibleSection | null>(null);
  let sourceRef = $state<CollapsibleSection | null>(null);
  let attrsRef = $state<CollapsibleSection | null>(null);

  let allRefs = $derived([
    genericsRef,
    signatureRef,
    fieldsRef,
    variantsRef,
    docsRef,
    implsRef,
    relationshipsRef,
    sourceRef,
    attrsRef
  ].filter(Boolean) as CollapsibleSection[]);

  function expandAll() {
    for (const ref of allRefs) {
      ref.setOpen(true);
    }
  }

  function collapseAll() {
    for (const ref of allRefs) {
      ref.setOpen(false);
    }
  }

  // Smart defaults: collapse sections with many items
  const FIELDS_COLLAPSE_THRESHOLD = 5;
  const VARIANTS_COLLAPSE_THRESHOLD = 5;
  const IMPLS_COLLAPSE_THRESHOLD = 6;
  const EDGES_COLLAPSE_THRESHOLD = 8;

  function formatSignature(selected: Node): string | null {
    if (!selected.signature) return null;
    const sig = selected.signature;
    const parts: string[] = [];
    if (sig.is_const) parts.push('const');
    if (sig.is_async) parts.push('async');
    if (sig.is_unsafe) parts.push('unsafe');
    parts.push('fn');
    const args = sig.inputs.map((a) => `${a.name}: ${a.type_name}`).join(', ');
    const ret = sig.output ? ` -> ${sig.output}` : '';
    return `${parts.join(' ')}(${args})${ret}`;
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

</script>

{#if selected}
  <div class="max-w-3xl">
    <!-- Header -->
    <div class="mb-6">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <span
            class="rounded-lg px-3 py-1 text-sm font-semibold text-white"
            style="background-color: {kindColors[selected.kind]}"
          >
            {kindLabels[selected.kind]}
          </span>
          <span class="rounded-lg border border-[var(--panel-border)] bg-white px-3 py-1 text-sm text-[var(--muted)]">
            {visibilityLabels[selected.visibility]}
          </span>
        </div>
        <div class="flex items-center gap-1">
          <button
            type="button"
            class="px-2 py-1 text-xs text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--panel)] rounded transition-colors"
            onclick={expandAll}
          >
            Expand all
          </button>
          <span class="text-[var(--muted)]">|</span>
          <button
            type="button"
            class="px-2 py-1 text-xs text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--panel)] rounded transition-colors"
            onclick={collapseAll}
          >
            Collapse all
          </button>
        </div>
      </div>
      <h2 class="mt-3 text-2xl font-bold text-[var(--ink)]">{selected.name}</h2>
      <p class="mt-1 font-mono text-sm text-[var(--muted)]">{selected.id}</p>
    </div>

    <!-- Generics -->
    {#if selected.generics && selected.generics.length > 0}
      <CollapsibleSection
        bind:this={genericsRef}
        title="Type Parameters"
        count={selected.generics.length}
        defaultOpen={true}
      >
        <div class="flex flex-wrap gap-2">
          {#each selected.generics as generic (generic)}
            <code class="rounded bg-[var(--panel)] px-2 py-1 text-sm text-[var(--ink)]">{generic}</code>
          {/each}
        </div>
      </CollapsibleSection>
    {/if}

    <!-- Signature (always open) -->
    {#if selected.signature}
      <CollapsibleSection
        bind:this={signatureRef}
        title="Signature"
        defaultOpen={true}
      >
        <div>
          <CodeBlock code={formatSignature(selected) ?? ''} lang="rust" theme="light" />
        </div>
        {#if selected.signature.inputs.length > 0}
          <div class="mt-4">
            <h4 class="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Arguments</h4>
            <div class="mt-2 space-y-2">
              {#each selected.signature.inputs as arg (arg.name)}
                <div class="flex items-baseline gap-2">
                  <code class="font-semibold text-[var(--ink)]">{arg.name}</code>
                  <span class="text-[var(--muted)]">:</span>
                  <code class="text-[var(--accent-strong)]">{arg.type_name}</code>
                </div>
              {/each}
            </div>
          </div>
        {/if}
        {#if selected.signature.output}
          <div class="mt-4">
            <h4 class="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Returns</h4>
            <code class="mt-2 block text-[var(--accent-strong)]">{selected.signature.output}</code>
          </div>
        {/if}
      </CollapsibleSection>
    {/if}

    <!-- Fields (collapse if many) -->
    {#if selected.fields && selected.fields.length > 0}
      <CollapsibleSection
        bind:this={fieldsRef}
        title="Fields"
        count={selected.fields.length}
        defaultOpen={selected.fields.length <= FIELDS_COLLAPSE_THRESHOLD}
      >
        <div class="space-y-2">
          {#each selected.fields as field (field.name)}
            <div class="flex items-baseline gap-2 rounded-lg bg-[var(--panel)] px-3 py-2">
              {#if field.visibility === 'Public'}
                <span class="text-xs text-green-600">pub</span>
              {/if}
              <code class="font-semibold text-[var(--ink)]">{field.name}</code>
              <span class="text-[var(--muted)]">:</span>
              <code class="text-[var(--accent-strong)]">{field.type_name}</code>
            </div>
          {/each}
        </div>
      </CollapsibleSection>
    {/if}

    <!-- Variants (collapse if many) -->
    {#if selected.variants && selected.variants.length > 0}
      <CollapsibleSection
        bind:this={variantsRef}
        title="Variants"
        count={selected.variants.length}
        defaultOpen={selected.variants.length <= VARIANTS_COLLAPSE_THRESHOLD}
      >
        <div class="space-y-3">
          {#each selected.variants as variant (variant.name)}
            <div class="rounded-lg bg-[var(--panel)] px-3 py-2">
              <code class="font-semibold text-[var(--ink)]">{variant.name}</code>
              {#if variant.fields.length > 0}
                <div class="ml-4 mt-2 space-y-1 border-l-2 border-[var(--panel-border)] pl-3">
                  {#each variant.fields as field (field.name)}
                    <div class="flex items-baseline gap-2 text-sm">
                      <code class="text-[var(--ink)]">{field.name}</code>
                      <span class="text-[var(--muted)]">:</span>
                      <code class="text-[var(--accent-strong)]">{field.type_name}</code>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      </CollapsibleSection>
    {/if}

    <!-- Documentation (always open) -->
    {#if selected.docs}
      <CollapsibleSection
        bind:this={docsRef}
        title="Documentation"
        defaultOpen={true}
      >
        <Documentation docs={selected.docs} defaultLang="rust" theme="light" />
      </CollapsibleSection>
    {/if}

    {#if implBlocks.length > 0}
      <CollapsibleSection
        bind:this={implsRef}
        title="Trait Implementations"
        count={implBlocks.length}
        defaultOpen={implBlocks.length <= IMPLS_COLLAPSE_THRESHOLD}
      >
        <div class="space-y-2">
          {#each implBlocks as implBlock (implBlock.id)}
            <div class="flex items-baseline gap-2 text-sm">
              <span class="rounded bg-[var(--panel)] px-2 py-0.5 text-xs font-medium text-[var(--muted)]">
                impl
              </span>
              <span class="text-[var(--ink)]">{implBlock.name}</span>
            </div>
          {/each}
        </div>
      </CollapsibleSection>
    {/if}

    <!-- Relationships (collapse if many edges) -->
    <CollapsibleSection
      bind:this={relationshipsRef}
      title="Relationships"
      count={selectedEdges.outgoing.length + selectedEdges.incoming.length}
      defaultOpen={selectedEdges.outgoing.length + selectedEdges.incoming.length <= EDGES_COLLAPSE_THRESHOLD}
    >
      <div class="grid gap-6 md:grid-cols-2">
        <!-- Outgoing edges -->
        <div>
          <h4 class="text-xs font-semibold uppercase tracking-wider text-[var(--muted)] mb-2">
            Outgoing ({selectedEdges.outgoing.length})
          </h4>
          <div class="space-y-2">
            {#if selectedEdges.outgoing.length === 0}
              <p class="text-sm text-[var(--muted)]">No outgoing edges</p>
            {:else}
              {#each selectedEdges.outgoing as edge (edge.kind + '-' + edge.to)}
                <div class="flex items-baseline gap-2 text-sm">
                  <span class="rounded bg-[var(--panel)] px-2 py-0.5 text-xs font-medium text-[var(--muted)]">
                    {edgeLabels[edge.kind]}
                  </span>
                  <span class="text-[var(--ink)]">{displayNode(edge.to)}</span>
                </div>
              {/each}
            {/if}
          </div>
        </div>

        <!-- Incoming edges -->
        <div>
          <h4 class="text-xs font-semibold uppercase tracking-wider text-[var(--muted)] mb-2">
            Incoming ({selectedEdges.incoming.length})
          </h4>
          <div class="space-y-2">
            {#if selectedEdges.incoming.length === 0}
              <p class="text-sm text-[var(--muted)]">No incoming edges</p>
            {:else}
              {#each selectedEdges.incoming as edge (edge.kind + '-' + edge.from)}
                <div class="flex items-baseline gap-2 text-sm">
                  <span class="rounded bg-[var(--panel)] px-2 py-0.5 text-xs font-medium text-[var(--muted)]">
                    {edgeLabels[edge.kind]}
                  </span>
                  <span class="text-[var(--ink)]">{displayNode(edge.from)}</span>
                </div>
              {/each}
            {/if}
          </div>
        </div>
      </div>
    </CollapsibleSection>

    <!-- Source location -->
    {#if selected.span}
      <CollapsibleSection
        bind:this={sourceRef}
        title="Source Location"
        defaultOpen={true}
      >
        <div class="font-mono text-sm">
          <span class="text-[var(--ink)]">{selected.span.file}</span>
          <span class="text-[var(--muted)]">:{selected.span.line}:{selected.span.column}</span>
        </div>
      </CollapsibleSection>
    {/if}

    <!-- Attributes -->
    {#if selected.attrs && selected.attrs.length > 0}
      <CollapsibleSection
        bind:this={attrsRef}
        title="Attributes"
        count={selected.attrs.length}
        defaultOpen={selected.attrs.length <= 3}
      >
        <div class="space-y-1">
          {#each selected.attrs as attr (attr)}
            <code class="block text-sm text-[var(--muted)]">{attr}</code>
          {/each}
        </div>
      </CollapsibleSection>
    {/if}
  </div>
{:else}
  <p class="text-sm text-[var(--muted)]">Select a node to view details</p>
{/if}
