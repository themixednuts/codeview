<script lang="ts">
  import type { Edge, EdgeKind, Node, NodeKind, Visibility } from '$lib/graph';
  import type { SelectedEdges } from '$lib/ui';
  import Documentation from './Documentation.svelte';
  import CodeBlock from './CodeBlock.svelte';
  import CollapsibleSection from './CollapsibleSection.svelte';
  import SourceViewer from './SourceViewer.svelte';

  type MethodGroup = {
    impl: Node;
    methods: Node[];
  };

  let {
    selected,
    selectedEdges,
    implBlocks,
    methodGroups,
    kindLabels,
    visibilityLabels,
    edgeLabels,
    displayNode,
    theme = 'light',
    getNodeUrl,
    nodeExists
  } = $props<{
    selected: Node | null;
    selectedEdges: SelectedEdges;
    implBlocks: Node[];
    methodGroups: MethodGroup[];
    kindLabels: Record<NodeKind, string>;
    visibilityLabels: Record<Visibility, string>;
    edgeLabels: Record<EdgeKind, string>;
    displayNode: (id: string) => string;
    theme?: 'dark' | 'light';
    /** Returns URL for navigating to a node */
    getNodeUrl?: (id: string) => string;
    /** Check if a node exists in the graph */
    nodeExists?: (nodeId: string) => boolean;
  }>();

  // Track collapsible section refs for expand/collapse all
  let genericsRef = $state<CollapsibleSection | null>(null);
  let signatureRef = $state<CollapsibleSection | null>(null);
  let fieldsRef = $state<CollapsibleSection | null>(null);
  let variantsRef = $state<CollapsibleSection | null>(null);
  let docsRef = $state<CollapsibleSection | null>(null);
  let methodsRef = $state<CollapsibleSection | null>(null);
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
    methodsRef,
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
  const METHODS_COLLAPSE_THRESHOLD = 8;
  const IMPLS_COLLAPSE_THRESHOLD = 6;
  const EDGES_COLLAPSE_THRESHOLD = 8;

  const methodCount = $derived.by(() =>
    methodGroups.reduce((total, group) => total + group.methods.length, 0)
  );

  const SIGNATURE_WRAP_COLUMN = 100;
  const TYPE_WRAP_COLUMN = 80;

  function formatTypeName(typeName: string): string {
    if (typeName.length <= TYPE_WRAP_COLUMN) return typeName;
    const firstAngle = typeName.indexOf('<');
    const lastAngle = typeName.lastIndexOf('>');
    if (firstAngle === -1 || lastAngle === -1 || lastAngle < firstAngle) {
      return typeName;
    }

    const prefix = typeName.slice(0, firstAngle).trimEnd();
    const inner = typeName.slice(firstAngle + 1, lastAngle);
    const suffix = typeName.slice(lastAngle + 1);

    const args: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < inner.length; i += 1) {
      const ch = inner[i];
      if (ch === '<') depth += 1;
      if (ch === '>') depth = Math.max(0, depth - 1);
      if (ch === ',' && depth === 0) {
        const arg = inner.slice(start, i).trim();
        if (arg) args.push(arg);
        start = i + 1;
      }
    }
    const lastArg = inner.slice(start).trim();
    if (lastArg) args.push(lastArg);

    if (args.length === 0) {
      return typeName;
    }

    const indent = '    ';
    const wrappedArgs = args.map((arg) => `${indent}${arg}`).join(',\n');
    return `${prefix}<\n${wrappedArgs},\n>${suffix}`;
  }

  function formatSignature(node: Node): string | null {
    if (!node.signature) return null;
    const sig = node.signature;
    const parts: string[] = [];
    if (sig.is_const) parts.push('const');
    if (sig.is_async) parts.push('async');
    if (sig.is_unsafe) parts.push('unsafe');
    parts.push('fn');
    parts.push(node.name);
    const args = sig.inputs.map((a) => `${a.name}: ${a.type_name}`);
    const ret = sig.output ? ` -> ${sig.output}` : '';
    const header = parts.join(' ');
    const inline = `${header}(${args.join(', ')})${ret}`;

    if (args.length === 0 || inline.length <= SIGNATURE_WRAP_COLUMN) {
      return inline;
    }

    const indent = '    ';
    const wrappedArgs = args.map((arg) => `${indent}${arg}`).join(',\n');
    return `${header}(\n${wrappedArgs},\n)${ret}`;
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
            class="rounded-[var(--radius-chip)] corner-squircle px-3 py-1 text-sm font-semibold text-white"
            style="background-color: {kindColors[selected.kind]}"
          >
            {kindLabels[selected.kind]}
          </span>
          <span class="badge badge-strong">
            {visibilityLabels[selected.visibility]}
          </span>
        </div>
        <div class="flex items-center gap-1">
          <button
            type="button"
            class="px-2 py-1 text-xs text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--panel)] rounded-[var(--radius-chip)] corner-squircle transition-colors"
            onclick={expandAll}
          >
            Expand all
          </button>
          <span class="text-[var(--muted)]">|</span>
          <button
            type="button"
            class="px-2 py-1 text-xs text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--panel)] rounded-[var(--radius-chip)] corner-squircle transition-colors"
            onclick={collapseAll}
          >
            Collapse all
          </button>
        </div>
      </div>
      <h2 class="mt-3 text-2xl font-bold text-[var(--ink)]">{selected.name}</h2>
      <p class="mt-1 text-sm text-[var(--muted)] font-[var(--font-code)]">{selected.id}</p>
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
            <code class="badge badge-strong font-[var(--font-code)]">{generic}</code>
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
          <CodeBlock code={formatSignature(selected) ?? ''} lang="rust" {theme} />
        </div>
        {#if selected.signature.inputs.length > 0}
          <div class="mt-4">
            <h4 class="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Arguments</h4>
            <div class="mt-2 space-y-2">
              {#each selected.signature.inputs as arg (arg.name)}
                <div class="flex items-baseline gap-2">
                  <code class="token-name">{arg.name}</code>
                  <span class="text-[var(--muted)]">:</span>
                  <code class="token-type">{arg.type_name}</code>
                </div>
              {/each}
            </div>
          </div>
        {/if}
        {#if selected.signature.output}
          <div class="mt-4">
            <h4 class="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Returns</h4>
            <code class="token-type mt-2 block">{selected.signature.output}</code>
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
            <div class="flex flex-wrap items-baseline gap-2 rounded-[var(--radius-control)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel)] px-3 py-2">
              {#if field.visibility === 'Public'}
                <span class="badge badge-strong text-[var(--accent)]">pub</span>
              {/if}
              <code class="token-name">{field.name}</code>
              <span class="text-[var(--muted)]">:</span>
              <code class="token-type break-normal whitespace-pre-wrap">{formatTypeName(field.type_name)}</code>
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
            <div class="rounded-[var(--radius-control)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel)] px-3 py-2">
              <code class="token-name">{variant.name}</code>
              {#if variant.fields.length > 0}
                <div class="ml-4 mt-2 space-y-1 border-l-2 border-[var(--panel-border)] pl-3">
                  {#each variant.fields as field (field.name)}
                    <div class="flex flex-wrap items-baseline gap-2 text-sm">
                      <code class="token-name">{field.name}</code>
                      <span class="text-[var(--muted)]">:</span>
                      <code class="token-type break-normal whitespace-pre-wrap">{formatTypeName(field.type_name)}</code>
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
        <Documentation docs={selected.docs} defaultLang="rust" {theme} docLinks={selected.doc_links ?? {}} {getNodeUrl} {nodeExists} />
      </CollapsibleSection>
    {/if}

    <!-- Methods -->
    {#if methodCount > 0}
      <CollapsibleSection
        bind:this={methodsRef}
        title="Methods"
        count={methodCount}
        defaultOpen={methodCount <= METHODS_COLLAPSE_THRESHOLD}
      >
        <div class="space-y-6">
          {#each methodGroups as group (group.impl.id)}
            <div class="rounded-[var(--radius-card)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel)] overflow-hidden">
              <div class="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <div class="flex items-center gap-2">
                  <span class="badge">impl</span>
                  {#if getNodeUrl && nodeExists?.(selected.id)}
                    <a
                      href={getNodeUrl(selected.id)}
                      data-sveltekit-noscroll
                      class="token-name text-[var(--accent)] hover:underline underline-offset-2"
                    >
                      {selected.name}
                    </a>
                  {:else}
                    <code class="token-name">{selected.name}</code>
                  {/if}
                </div>
                <div class="text-xs">
                  {#if group.impl.span}
                    <SourceViewer span={group.impl.span} {theme} />
                  {:else}
                    <span class="font-[var(--font-code)] text-[var(--muted)]">Location unavailable</span>
                  {/if}
                </div>
              </div>
              <div>
                {#each group.methods as method, index (method.id)}
                  <div
                    class={`bg-[var(--panel-solid)] px-3 py-3 ${index ? 'border-t border-[var(--panel-border)]' : ''}`}
                  >
                    <div class="flex flex-wrap items-center gap-2">
                      {#if method.visibility === 'Public'}
                        <span class="badge badge-strong text-[var(--accent)]">pub</span>
                      {/if}
                      <code class="token-name">{method.name}</code>
                      {#if method.signature?.is_async}
                        <span class="badge">async</span>
                      {/if}
                      {#if method.signature?.is_unsafe}
                        <span class="badge">unsafe</span>
                      {/if}
                      {#if method.signature?.is_const}
                        <span class="badge">const</span>
                      {/if}
                    </div>
                    <div class="flex flex-wrap items-center gap-3 mt-1">
                      {#if method.signature}
                        <div class="flex-1 min-w-0">
                          <CodeBlock code={formatSignature(method) ?? ''} lang="rust" variant="flat" {theme} />
                        </div>
                      {/if}
                      {#if method.span}
                        <div class="text-xs shrink-0">
                          <SourceViewer span={method.span} {theme} />
                        </div>
                      {/if}
                    </div>
                    {#if method.docs}
                      <div class={`mt-3 text-sm text-[var(--muted)] ${method.signature ? 'border-t border-[var(--panel-border)] pt-3' : ''}`}>
                        <Documentation docs={method.docs} defaultLang="rust" {theme} docLinks={method.doc_links ?? {}} {getNodeUrl} {nodeExists} />
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            </div>
          {/each}
        </div>
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
            <div class="flex flex-wrap items-baseline gap-2 text-sm">
              <span class="badge">
                impl
              </span>
              {#if implBlock.impl_trait}
                {#if getNodeUrl && nodeExists?.(implBlock.impl_trait)}
                  <a
                    href={getNodeUrl(implBlock.impl_trait)}
                    data-sveltekit-noscroll
                    class="token-name text-[var(--accent)] hover:underline underline-offset-2"
                  >
                    {displayNode(implBlock.impl_trait)}
                  </a>
                {:else}
                  <span class="token-name">{displayNode(implBlock.impl_trait)}</span>
                {/if}
                <span class="text-[var(--muted)]">for</span>
                {#if getNodeUrl && nodeExists?.(selected.id)}
                  <a
                    href={getNodeUrl(selected.id)}
                    data-sveltekit-noscroll
                    class="token-name text-[var(--accent)] hover:underline underline-offset-2"
                  >
                    {selected.name}
                  </a>
                {:else}
                  <span class="token-name">{selected.name}</span>
                {/if}
              {:else}
                <span class="text-[var(--ink)]">{implBlock.name}</span>
              {/if}
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
          <div class="grid grid-cols-[max-content_1fr] gap-x-2 gap-y-2 text-sm">
            {#if selectedEdges.outgoing.length === 0}
              <p class="col-span-2 text-[var(--muted)]">No outgoing edges</p>
            {:else}
              {#each selectedEdges.outgoing as edge (edge.kind + '-' + edge.to)}
                <div>
                  <span class="badge">
                    {edgeLabels[edge.kind]}
                  </span>
                </div>
                <div>
                  {#if getNodeUrl}
                    <a href={getNodeUrl(edge.to)} data-sveltekit-noscroll class="text-[var(--ink)] hover:text-[var(--accent)]">{displayNode(edge.to)}</a>
                  {:else}
                    <span class="text-[var(--ink)]">{displayNode(edge.to)}</span>
                  {/if}
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
          <div class="grid grid-cols-[max-content_1fr] gap-x-2 gap-y-2 text-sm">
            {#if selectedEdges.incoming.length === 0}
              <p class="col-span-2 text-[var(--muted)]">No incoming edges</p>
            {:else}
              {#each selectedEdges.incoming as edge (edge.kind + '-' + edge.from)}
                <div>
                  <span class="badge">
                    {edgeLabels[edge.kind]}
                  </span>
                </div>
                <div>
                  {#if getNodeUrl}
                    <a href={getNodeUrl(edge.from)} data-sveltekit-noscroll class="text-[var(--ink)] hover:text-[var(--accent)]">{displayNode(edge.from)}</a>
                  {:else}
                    <span class="text-[var(--ink)]">{displayNode(edge.from)}</span>
                  {/if}
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
        title="Source"
        defaultOpen={true}
      >
        <SourceViewer span={selected.span} {theme} />
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
            <code class="token-meta block text-sm">{attr}</code>
          {/each}
        </div>
      </CollapsibleSection>
    {/if}
  </div>
{:else}
  <p class="text-sm text-[var(--muted)]">Select a node to view details</p>
{/if}
