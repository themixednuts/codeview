<script lang="ts">
  import type { Edge, EdgeKind, Node, NodeKind, Visibility } from '$lib/graph';
  import type { SelectedEdges } from '$lib/ui';
  import { kindColors } from '$lib/tree';
  import { externalDocsUrl } from '$lib/docs';
  import Documentation from './Documentation.svelte';
  import CodeBlock from './CodeBlock.svelte';
  import CollapsibleSection from './CollapsibleSection.svelte';
  import SourceViewer from './SourceViewer.svelte';
  import { tooltip } from '$lib/tooltip';
  import ChevronsDownUp from '@lucide/svelte/icons/chevrons-down-up';
  import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
  import { extLinkModeCtx } from '$lib/context';

  const extLinkMode = $derived(extLinkModeCtx.get());

  type MethodGroup = {
    impl: Node;
    methods: Node[];
  };

  let {
    selected,
    selectedEdges,
    sourceImpls,
    blanketImpls,
    methodGroups,
    kindLabels,
    visibilityLabels,
    edgeLabels,
    displayNode,
    theme = 'light',
    getNodeUrl,
    nodeExists,
    nodeMeta,
    crateName,
    crateVersion,
    crateVersions
  } = $props<{
    selected: Node | null;
    selectedEdges: SelectedEdges;
    sourceImpls: Node[];
    blanketImpls: Node[];
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
    /** Fetch related node metadata (e.g. is_external, kind) */
    nodeMeta?: (nodeId: string) => { is_external?: boolean; kind?: NodeKind } | undefined;
    crateName?: string;
    crateVersion?: string;
    crateVersions?: Record<string, string>;
  }>();

  const totalImpls = $derived(sourceImpls.length + blanketImpls.length);
  const selectedKind = $derived(selected?.kind as NodeKind);

  function crateFromId(id?: string | null) {
    return id?.split('::')[0];
  }

  function resolveVersionForCrate(id?: string | null) {
    const idCrate = crateFromId(id);
    if (!idCrate) return undefined;
    return idCrate === crateName ? crateVersion : undefined;
  }

  function isExternalNode(nodeId: string): boolean {
    return nodeMeta?.(nodeId)?.is_external ?? false;
  }

  function externalNodeKind(nodeId: string): NodeKind | undefined {
    return nodeMeta?.(nodeId)?.kind;
  }

  function externalLinkHandler(nodeId: string): (e: MouseEvent) => void {
    const kind = externalNodeKind(nodeId);
    const crate = crateFromId(nodeId);
    const version = crate ? crateVersions?.[crate] : undefined;
    return (e: MouseEvent) => {
      if (extLinkMode === 'docs') {
        e.preventDefault();
        e.stopPropagation();
        window.open(externalDocsUrl(nodeId, kind, version), '_blank', 'noopener,noreferrer');
      }
    };
  }

  type BoundSegment = { text: string; nodeId?: string };

  /**
   * Split a generic param or where-predicate string into segments,
   * linking trait names that appear in the bound_links map.
   * e.g. "V: SQLParam + 'a" with links {"SQLParam": "drizzle_core::params::SQLParam"}
   * → [{text:"V: "}, {text:"SQLParam", nodeId:"..."}, {text:" + 'a"}]
   */
  function splitBoundSegments(text: string, links: Record<string, string> | undefined): BoundSegment[] {
    if (!links || Object.keys(links).length === 0) return [{ text }];

    // Sort keys longest-first so longer trait names match before shorter substrings
    const keys = Object.keys(links).sort((a, b) => b.length - a.length);

    const segments: BoundSegment[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      let earliest = -1;
      let matchedKey = '';
      for (const key of keys) {
        const idx = remaining.indexOf(key);
        if (idx !== -1 && (earliest === -1 || idx < earliest)) {
          earliest = idx;
          matchedKey = key;
        }
      }
      if (earliest === -1) {
        segments.push({ text: remaining });
        break;
      }
      if (earliest > 0) {
        segments.push({ text: remaining.slice(0, earliest) });
      }
      segments.push({ text: matchedKey, nodeId: links[matchedKey] });
      remaining = remaining.slice(earliest + matchedKey.length);
    }
    return segments;
  }

  // Track collapsible section refs for expand/collapse all
  let signatureRef = $state<CollapsibleSection | null>(null);
  let fieldsRef = $state<CollapsibleSection | null>(null);
  let variantsRef = $state<CollapsibleSection | null>(null);
  let docsRef = $state<CollapsibleSection | null>(null);
  let methodsRef = $state<CollapsibleSection | null>(null);
  let implsRef = $state<CollapsibleSection | null>(null);
  let relationshipsRef = $state<CollapsibleSection | null>(null);
  let attrsRef = $state<CollapsibleSection | null>(null);

  let allRefs = $derived([
    signatureRef,
    fieldsRef,
    variantsRef,
    docsRef,
    methodsRef,
    implsRef,
    relationshipsRef,
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
    methodGroups.reduce((total: number, group: MethodGroup) => total + group.methods.length, 0)
  );

  const edgeKindDescriptions: Record<EdgeKind, string> = {
    Contains: 'This item is a direct child module or member',
    Defines: 'This item defines or declares the target',
    UsesType: 'References this type in a signature or field',
    Implements: 'Implements this trait',
    CallsStatic: 'Calls this function or method directly',
    CallsRuntime: 'Calls this via dynamic dispatch (dyn Trait)',
    Derives: 'Auto-derives this trait via #[derive]',
    ReExports: 'Re-exports this item via pub use',
  };

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


</script>

{#snippet linkedBadge(text: string, links: Record<string, string> | undefined, strong: boolean)}
  <code class="badge {strong ? 'badge-strong' : ''} badge-code">
    {#each splitBoundSegments(text, links) as seg, index (index)}
      {#if seg.nodeId && getNodeUrl}
        {#if isExternalNode(seg.nodeId)}
          <a
            href={getNodeUrl(seg.nodeId)}
            data-sveltekit-noscroll
            onclick={externalLinkHandler(seg.nodeId)}
            class="text-[var(--accent)] hover:underline underline-offset-2"
            title="External dependency"
          >
            {seg.text}
          </a>
        {:else}
          <a href={getNodeUrl(seg.nodeId)} data-sveltekit-noscroll class="text-[var(--accent)] hover:underline underline-offset-2">
            {seg.text}
          </a>
        {/if}
      {:else}
        {seg.text}
      {/if}
    {/each}
  </code>
{/snippet}

{#snippet implRow(implBlock: Node)}
  <div class="flex flex-wrap items-center gap-2 text-sm">
    <span class="badge">impl</span>
    {#if implBlock.generics && implBlock.generics.length > 0}
      {#each implBlock.generics as generic (generic)}
        {@render linkedBadge(generic, implBlock.bound_links, true)}
      {/each}
    {/if}
    {#if implBlock.impl_trait}
      {#if getNodeUrl && nodeExists?.(implBlock.impl_trait) && !isExternalNode(implBlock.impl_trait)}
        <a
          href={getNodeUrl(implBlock.impl_trait)}
          data-sveltekit-noscroll
          class="token-name text-[var(--accent)] hover:underline underline-offset-2"
        >
          {displayNode(implBlock.impl_trait)}
        </a>
      {:else if isExternalNode(implBlock.impl_trait)}
        <a
          href={getNodeUrl?.(implBlock.impl_trait) ?? '#'}
          data-sveltekit-noscroll
          onclick={externalLinkHandler(implBlock.impl_trait)}
          class="token-name text-[var(--accent)] hover:underline underline-offset-2"
          title="Shift+click for external docs"
        >
          {displayNode(implBlock.impl_trait)}
        </a>
      {:else}
        <span class="token-name">{displayNode(implBlock.impl_trait)}</span>
      {/if}
      <span class="text-[var(--muted)]">for</span>
      <span class="token-name">{selected?.name}</span>
    {:else}
      <span class="text-[var(--ink)]">{implBlock.name}</span>
    {/if}
    {#if implBlock.where_clause && implBlock.where_clause.length > 0}
      <span class="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">where</span>
      {#each implBlock.where_clause as predicate (predicate)}
        {@render linkedBadge(predicate, implBlock.bound_links, false)}
      {/each}
    {/if}
  </div>
{/snippet}

{#if selected}
  <div class="max-w-3xl">
    <!-- Header -->
    <div class="mb-6">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <span
            class="badge badge-lg badge-filled text-sm"
            style="background-color: {kindColors[selectedKind]}"
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
            class="badge badge-sm hover:bg-[var(--panel-strong)] hover:text-[var(--ink)] transition-colors inline-flex items-center gap-1"
            onclick={expandAll}
          >
            <ChevronsUpDown size={12} />
            Expand all
          </button>
          <span class="text-[var(--muted)]">|</span>
          <button
            type="button"
            class="badge badge-sm hover:bg-[var(--panel-strong)] hover:text-[var(--ink)] transition-colors inline-flex items-center gap-1"
            onclick={collapseAll}
          >
            <ChevronsDownUp size={12} />
            Collapse all
          </button>
        </div>
      </div>
      <h2 class="mt-3 text-2xl font-bold text-[var(--ink)]">{selected.name}</h2>
      <p class="mt-1 text-sm text-[var(--muted)] font-[var(--font-code)]">{selected.id}</p>
      {#if selected.span}
        <div class="mt-2 text-xs">
          <SourceViewer
            span={selected.span}
            {theme}
            crateName={crateFromId(selected.id) ?? crateName}
            crateVersion={resolveVersionForCrate(selected.id)}
          />
        </div>
      {/if}
      {#if selected.generics && selected.generics.length > 0}
        <div class="mt-3 flex flex-wrap items-center gap-2">
          {#each selected.generics as generic (generic)}
            {@render linkedBadge(generic, selected.bound_links, true)}
          {/each}
        </div>
      {/if}
      {#if selected.where_clause && selected.where_clause.length > 0}
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <span class="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">where</span>
          {#each selected.where_clause as predicate (predicate)}
            {@render linkedBadge(predicate, selected.bound_links, false)}
          {/each}
        </div>
      {/if}
    </div>

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
                <div class="flex flex-wrap items-baseline gap-2">
                  <code class="badge badge-strong badge-code">{arg.name}</code>
                  <span class="text-[var(--muted)]">:</span>
                  {@render linkedBadge(arg.type_name, selected.bound_links, false)}
                </div>
              {/each}
            </div>
          </div>
        {/if}
        {#if selected.signature.output}
          <div class="mt-4">
            <h4 class="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Returns</h4>
            <div class="mt-2">
              {@render linkedBadge(selected.signature.output, selected.bound_links, false)}
            </div>
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
        <div class="rounded-[var(--radius-control)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel)] divide-y divide-[var(--panel-border)]">
          {#each selected.fields as field (field.name)}
            <div class="flex flex-wrap items-baseline gap-2 px-3 py-2 text-sm">
              {#if field.visibility === 'Public'}
                <span class="badge badge-strong text-[var(--accent)]">pub</span>
              {/if}
              <code class="badge badge-strong badge-code">{field.name}</code>
              <span class="text-[var(--muted)]">:</span>
              {@render linkedBadge(formatTypeName(field.type_name), selected.bound_links, false)}
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
            <div class="rounded-[var(--radius-control)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel)] overflow-hidden">
              <div class="flex items-center justify-between gap-2 border-b border-[var(--panel-border)] bg-[var(--panel-solid)] px-3 py-2">
                <code class="token-name">{variant.name}</code>
                {#if variant.fields.length > 0}
                  <span class="badge badge-sm text-[var(--muted)]">
                    {variant.fields.length} field{variant.fields.length === 1 ? '' : 's'}
                  </span>
                {:else}
                  <span class="badge badge-sm text-[var(--muted)]">unit</span>
                {/if}
              </div>
              {#if variant.fields.length > 0}
                <div class="divide-y divide-[var(--panel-border)]">
                  {#each variant.fields as field (field.name)}
                    <div class="flex flex-wrap items-baseline gap-2 px-3 py-2 text-sm">
                      {#if field.visibility === 'Public'}
                        <span class="badge badge-strong text-[var(--accent)]">pub</span>
                      {/if}
                      <code class="badge badge-strong badge-code">{field.name}</code>
                      <span class="text-[var(--muted)]">:</span>
                      {@render linkedBadge(formatTypeName(field.type_name), selected.bound_links, false)}
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
                    <SourceViewer
                      span={group.impl.span}
                      {theme}
                      crateName={crateFromId(group.impl.id) ?? crateName}
                      crateVersion={resolveVersionForCrate(group.impl.id)}
                    />
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
                      <code class="badge badge-strong badge-code">{method.name}</code>
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
                          <SourceViewer
                            span={method.span}
                            {theme}
                            crateName={crateFromId(method.id) ?? crateName}
                            crateVersion={resolveVersionForCrate(method.id)}
                          />
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

    {#if totalImpls > 0}
      <CollapsibleSection
        bind:this={implsRef}
        title="Trait Implementations"
        count={totalImpls}
        defaultOpen={totalImpls <= IMPLS_COLLAPSE_THRESHOLD}
      >
        <div class="space-y-4">
          <!-- Source (user-written) implementations -->
          {#if sourceImpls.length > 0}
            <div class="space-y-2">
              {#each sourceImpls as implBlock (implBlock.id)}
                {@render implRow(implBlock)}
              {/each}
            </div>
          {/if}

          <!-- Auto/blanket implementations -->
          {#if blanketImpls.length > 0}
            <details class="group">
              <summary class="cursor-pointer select-none text-xs font-semibold uppercase tracking-wider text-[var(--muted)] hover:text-[var(--ink)] transition-colors">
                Auto/blanket implementations ({blanketImpls.length})
              </summary>
              <div class="mt-2 space-y-1 opacity-70">
                {#each blanketImpls as implBlock (implBlock.id)}
                  {@render implRow(implBlock)}
                {/each}
              </div>
            </details>
          {/if}
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
                  <span class="badge" {@attach tooltip(edgeKindDescriptions[edge.kind as EdgeKind] ?? edge.kind)}>
                    {edgeLabels[edge.kind]}
                  </span>
                </div>
                <div>
                  {#if getNodeUrl && !isExternalNode(edge.to)}
                    <a href={getNodeUrl(edge.to)} data-sveltekit-noscroll class="text-[var(--ink)] hover:text-[var(--accent)]">{displayNode(edge.to)}</a>
                  {:else if isExternalNode(edge.to) && getNodeUrl}
                    <a href={getNodeUrl(edge.to)} data-sveltekit-noscroll onclick={externalLinkHandler(edge.to)} class="text-[var(--ink)] hover:text-[var(--accent)]" title="Shift+click for external docs">{displayNode(edge.to)}</a>
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
                  <span class="badge" {@attach tooltip(edgeKindDescriptions[edge.kind as EdgeKind] ?? edge.kind)}>
                    {edgeLabels[edge.kind]}
                  </span>
                </div>
                <div>
                  {#if getNodeUrl && !isExternalNode(edge.from)}
                    <a href={getNodeUrl(edge.from)} data-sveltekit-noscroll class="text-[var(--ink)] hover:text-[var(--accent)]">{displayNode(edge.from)}</a>
                  {:else if isExternalNode(edge.from) && getNodeUrl}
                    <a href={getNodeUrl(edge.from)} data-sveltekit-noscroll onclick={externalLinkHandler(edge.from)} class="text-[var(--ink)] hover:text-[var(--accent)]" title="Shift+click for external docs">{displayNode(edge.from)}</a>
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
