<script lang="ts">
  import type { Edge, EdgeKind, Node, NodeKind, Visibility } from '$lib/graph';
  import type { SelectedEdges } from '$lib/ui';

  let { selected, selectedEdges, kindLabels, visibilityLabels, edgeLabels, displayNode } = $props<{
    selected: Node | null;
    selectedEdges: SelectedEdges;
    kindLabels: Record<NodeKind, string>;
    visibilityLabels: Record<Visibility, string>;
    edgeLabels: Record<EdgeKind, string>;
    displayNode: (id: string) => string;
  }>();

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
      <h2 class="mt-3 text-2xl font-bold text-[var(--ink)]">{selected.name}</h2>
      <p class="mt-1 font-mono text-sm text-[var(--muted)]">{selected.id}</p>
    </div>

    <!-- Generics -->
    {#if selected.generics && selected.generics.length > 0}
      <section class="mb-6 rounded-xl border border-[var(--panel-border)] bg-white p-4">
        <h3 class="text-sm font-semibold uppercase tracking-wider text-[var(--muted)]">Type Parameters</h3>
        <div class="mt-2 flex flex-wrap gap-2">
          {#each selected.generics as generic}
            <code class="rounded bg-[var(--panel)] px-2 py-1 text-sm text-[var(--ink)]">{generic}</code>
          {/each}
        </div>
      </section>
    {/if}

    <!-- Signature -->
    {#if selected.signature}
      <section class="mb-6 rounded-xl border border-[var(--panel-border)] bg-white p-4">
        <h3 class="text-sm font-semibold uppercase tracking-wider text-[var(--muted)]">Signature</h3>
        <pre class="mt-2 overflow-x-auto rounded-lg bg-[var(--panel)] p-3 font-mono text-sm text-[var(--ink)]">{formatSignature(selected)}</pre>
        {#if selected.signature.inputs.length > 0}
          <div class="mt-4">
            <h4 class="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Arguments</h4>
            <div class="mt-2 space-y-2">
              {#each selected.signature.inputs as arg}
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
      </section>
    {/if}

    <!-- Fields -->
    {#if selected.fields && selected.fields.length > 0}
      <section class="mb-6 rounded-xl border border-[var(--panel-border)] bg-white p-4">
        <h3 class="text-sm font-semibold uppercase tracking-wider text-[var(--muted)]">Fields</h3>
        <div class="mt-3 space-y-2">
          {#each selected.fields as field}
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
      </section>
    {/if}

    <!-- Variants -->
    {#if selected.variants && selected.variants.length > 0}
      <section class="mb-6 rounded-xl border border-[var(--panel-border)] bg-white p-4">
        <h3 class="text-sm font-semibold uppercase tracking-wider text-[var(--muted)]">Variants</h3>
        <div class="mt-3 space-y-3">
          {#each selected.variants as variant}
            <div class="rounded-lg bg-[var(--panel)] px-3 py-2">
              <code class="font-semibold text-[var(--ink)]">{variant.name}</code>
              {#if variant.fields.length > 0}
                <div class="ml-4 mt-2 space-y-1 border-l-2 border-[var(--panel-border)] pl-3">
                  {#each variant.fields as field}
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
      </section>
    {/if}

    <!-- Documentation -->
    {#if selected.docs}
      <section class="mb-6 rounded-xl border border-[var(--panel-border)] bg-white p-4">
        <h3 class="text-sm font-semibold uppercase tracking-wider text-[var(--muted)]">Documentation</h3>
        <div class="mt-2 whitespace-pre-wrap text-sm text-[var(--ink)]">{selected.docs}</div>
      </section>
    {/if}

    <!-- Relationships -->
    <div class="grid gap-6 md:grid-cols-2">
      <!-- Outgoing edges -->
      <section class="rounded-xl border border-[var(--panel-border)] bg-white p-4">
        <h3 class="text-sm font-semibold uppercase tracking-wider text-[var(--muted)]">
          Outgoing ({selectedEdges.outgoing.length})
        </h3>
        <div class="mt-3 space-y-2">
          {#if selectedEdges.outgoing.length === 0}
            <p class="text-sm text-[var(--muted)]">No outgoing edges</p>
          {:else}
            {#each selectedEdges.outgoing as edge}
              <div class="flex items-baseline gap-2 text-sm">
                <span class="rounded bg-[var(--panel)] px-2 py-0.5 text-xs font-medium text-[var(--muted)]">
                  {edgeLabels[edge.kind]}
                </span>
                <span class="text-[var(--ink)]">{displayNode(edge.to)}</span>
              </div>
            {/each}
          {/if}
        </div>
      </section>

      <!-- Incoming edges -->
      <section class="rounded-xl border border-[var(--panel-border)] bg-white p-4">
        <h3 class="text-sm font-semibold uppercase tracking-wider text-[var(--muted)]">
          Incoming ({selectedEdges.incoming.length})
        </h3>
        <div class="mt-3 space-y-2">
          {#if selectedEdges.incoming.length === 0}
            <p class="text-sm text-[var(--muted)]">No incoming edges</p>
          {:else}
            {#each selectedEdges.incoming as edge}
              <div class="flex items-baseline gap-2 text-sm">
                <span class="rounded bg-[var(--panel)] px-2 py-0.5 text-xs font-medium text-[var(--muted)]">
                  {edgeLabels[edge.kind]}
                </span>
                <span class="text-[var(--ink)]">{displayNode(edge.from)}</span>
              </div>
            {/each}
          {/if}
        </div>
      </section>
    </div>

    <!-- Source location -->
    {#if selected.span}
      <section class="mt-6 rounded-xl border border-[var(--panel-border)] bg-white p-4">
        <h3 class="text-sm font-semibold uppercase tracking-wider text-[var(--muted)]">Source Location</h3>
        <div class="mt-2 font-mono text-sm">
          <span class="text-[var(--ink)]">{selected.span.file}</span>
          <span class="text-[var(--muted)]">:{selected.span.line}:{selected.span.column}</span>
        </div>
      </section>
    {/if}

    <!-- Attributes -->
    {#if selected.attrs && selected.attrs.length > 0}
      <section class="mt-6 rounded-xl border border-[var(--panel-border)] bg-white p-4">
        <h3 class="text-sm font-semibold uppercase tracking-wider text-[var(--muted)]">Attributes</h3>
        <div class="mt-2 space-y-1">
          {#each selected.attrs as attr}
            <code class="block text-sm text-[var(--muted)]">{attr}</code>
          {/each}
        </div>
      </section>
    {/if}
  </div>
{:else}
  <p class="text-sm text-[var(--muted)]">Select a node to view details</p>
{/if}
