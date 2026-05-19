<script lang="ts">
	import type { Edge, EdgeKind, Node, NodeKind } from '$lib/graph';
	import { isPublic, visibilityLabel } from '$lib/display-names';
	import type {
		GenericBound,
		GenericParam,
		TypeRef,
		WherePredicate,
	} from '$lib/schema';

	/** Final segment of a `::`-separated path. `std::vec::Vec` → `Vec`. */
	function pathTail(path: string): string {
		const idx = path.lastIndexOf('::');
		return idx >= 0 ? path.slice(idx + 2) : path;
	}

	type SelectedEdges = {
		incoming: Edge[];
		outgoing: Edge[];
	};
	import { resolve } from '$app/paths';
	import { kindColors } from '$lib/tree';
	import { externalDocsUrl } from '$lib/docs';
	import Documentation from './Documentation.svelte';
	import CodeBlock from './CodeBlock.svelte';
	import CollapsibleSection from './CollapsibleSection.svelte';
	import DocSection from './DocSection.svelte';
	import SignatureBlock from './SignatureBlock.svelte';
	import SourceViewer from './SourceViewer.svelte';
	import { tooltip } from '$lib/tooltip';
	import { hyphenateCrateName, normalizeCrateName } from '$lib/crate-names';
	import ChevronsDownUp from '@lucide/svelte/icons/chevrons-down-up';
	import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
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
		edgeLabels,
		displayNode,
		theme = 'light',
		getNodeUrl,
		nodeExists,
		nodeMeta,
		crateName,
		crateVersion,
		crateVersions,
		belowTitle,
	} = $props<{
		selected: Node | null;
		selectedEdges: SelectedEdges;
		sourceImpls: Node[];
		blanketImpls: Node[];
		methodGroups: MethodGroup[];
		kindLabels: Record<NodeKind, string>;
		edgeLabels: Record<EdgeKind, string>;
		displayNode: (id: string) => string;
		theme?: 'dark' | 'light';
		/** Returns URL for navigating to a node */
		getNodeUrl?: (id: string) => string;
		/** Check if a node exists in the graph */
		nodeExists?: (nodeId: string) => boolean;
		/** Fetch related node metadata (full related node when available). */
		nodeMeta?: (nodeId: string) => Node | undefined;
		crateName?: string;
		crateVersion?: string;
		crateVersions?: Record<string, string>;
		/** Optional content inserted right after the title block (kind label +
		 *  h1 + path + source) and before the Documentation / Methods / etc.
		 *  sections. The DetailView hoists the relationship graph card into
		 *  this slot so the visual context appears before the doc prose. */
		belowTitle?: import('svelte').Snippet;
	}>();

	const totalImpls = $derived(sourceImpls.length + blanketImpls.length);
	const selectedKind = $derived(selected?.kind as NodeKind);

	function crateFromId(id?: string | null) {
		return id?.split('::')[0];
	}

	function resolveVersionForCrate(id?: string | null) {
		const idCrate = crateFromId(id);
		if (!idCrate) return crateVersion;
		if (crateName && normalizeCrateName(idCrate) === normalizeCrateName(crateName)) {
			return crateVersion;
		}
		return (
			crateVersions?.[idCrate] ??
			crateVersions?.[normalizeCrateName(idCrate)] ??
			crateVersions?.[hyphenateCrateName(idCrate)]
		);
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

	// Track collapsible section refs for expand/collapse all.
	// The top-level doc sections (Documentation, Methods, Trait Impls,
	// Relationships, Attributes) are no longer collapsible — they render
	// inline via DocSection, matching the doc-classic design.
	let signatureRef = $state<CollapsibleSection | null>(null);
	let fieldsRef = $state<CollapsibleSection | null>(null);
	let variantsRef = $state<CollapsibleSection | null>(null);
	let typeInfoRef = $state<CollapsibleSection | null>(null);
	let boundsRef = $state<CollapsibleSection | null>(null);
	let variantTypeRef = $state<CollapsibleSection | null>(null);

	let allRefs = $derived(
		[signatureRef, fieldsRef, variantsRef, typeInfoRef, boundsRef, variantTypeRef].filter(
			Boolean,
		) as CollapsibleSection[],
	);

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
		methodGroups.reduce((total: number, group: MethodGroup) => total + group.methods.length, 0),
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

	function implCategoryLabel(category: Node['impl_category']): string | null {
		switch (category) {
			case 'Blanket':
				return 'blanket';
			case 'Negative':
				return 'negative';
			case 'Synthetic':
				return 'synthetic';
			case 'Trait':
				return 'trait';
			case 'Inherent':
				return 'inherent';
			default:
				return null;
		}
	}

	function isTupleVariant(fields: { name: string }[]): boolean {
		return fields.length > 0 && fields.every((f) => /^\d+$/.test(f.name));
	}

	// fn signatures are now formatted by SignatureBlock, which measures the
	// real container width via ResizeObserver and picks inline-vs-multiline
	// dynamically — see SignatureBlock.svelte for the rustfmt-style break
	// shape (header `(`, one arg per line, closing `)` before `->`).
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

</script>

{#snippet idLink(id: string, display: string)}
	{#if getNodeUrl && nodeExists?.(id) && !isExternalNode(id)}
		<a
			href={resolve(getNodeUrl(id))}
			data-sveltekit-noscroll
			class="text-(--accent) underline-offset-2 hover:underline"
		>
			{display}
		</a>
	{:else if isExternalNode(id) && getNodeUrl}
		<a
			href={resolve(getNodeUrl(id))}
			data-sveltekit-noscroll
			onclick={externalLinkHandler(id)}
			class="text-(--accent) underline-offset-2 hover:underline"
			title="External dependency"
		>
			{display}
		</a>
	{:else}
		{display}
	{/if}
{/snippet}

<!-- Recursively render a TypeRef as inline content. Each ResolvedPath
	 becomes a link to its node (when available); generic args nest as
	 chevron-bracketed groups for visual scanning. -->
{#snippet typeContent(t: TypeRef)}
	{#if t.kind === 'ResolvedPath'}
		{@render idLink(t.id, pathTail(t.path))}
		{#if t.args}{@render genericArgs(t.args)}{/if}
	{:else if t.kind === 'DynTrait'}
		<span class="text-(--muted)">dyn </span>
		{#each t.traits as poly, i (i)}
			{#if i > 0}<span class="text-(--muted)"> + </span>{/if}
			{@render typeContent(poly.trait)}
		{/each}
		{#if t.lifetime}<span class="text-(--muted)"> + {t.lifetime}</span>{/if}
	{:else if t.kind === 'Generic'}
		<span class="token-name">{t.name}</span>
	{:else if t.kind === 'Primitive'}
		<span class="token-name">{t.name}</span>
	{:else if t.kind === 'BorrowedRef'}
		<span class="text-(--muted)">&{t.lifetime ? `${t.lifetime} ` : ''}{t.mutable ? 'mut ' : ''}</span>
		{@render typeContent(t.inner)}
	{:else if t.kind === 'Tuple'}
		<span class="text-(--muted)">(</span>
		{#each t.elements as el, i (i)}
			{#if i > 0}<span class="text-(--muted)">, </span>{/if}
			{@render typeContent(el)}
		{/each}{#if t.elements.length === 1}<span class="text-(--muted)">,</span>{/if}
		<span class="text-(--muted)">)</span>
	{:else if t.kind === 'Slice'}
		<span class="text-(--muted)">[</span>{@render typeContent(t.element)}<span class="text-(--muted)">]</span>
	{:else if t.kind === 'Array'}
		<span class="text-(--muted)">[</span>{@render typeContent(t.element)}<span class="text-(--muted)">; {t.len}]</span>
	{:else if t.kind === 'ImplTrait'}
		<span class="text-(--muted)">impl </span>
		{#each t.bounds as b, i (i)}
			{#if i > 0}<span class="text-(--muted)"> + </span>{/if}
			{@render boundContent(b)}
		{/each}
	{:else if t.kind === 'RawPointer'}
		<span class="text-(--muted)">*{t.mutable ? 'mut ' : 'const '}</span>{@render typeContent(t.inner)}
	{:else if t.kind === 'QualifiedPath'}
		<span class="text-(--muted)">&lt;</span>{@render typeContent(t.self_type)}{#if t.trait}<span class="text-(--muted)"> as </span>{@render typeContent(t.trait)}{/if}<span class="text-(--muted)">&gt;::</span><span class="token-name">{t.name}</span>{#if t.args}{@render genericArgs(t.args)}{/if}
	{:else if t.kind === 'FunctionPointer'}
		<span class="text-(--muted)">fn(</span>
		{#each t.sig.inputs as inp, i (i)}
			{#if i > 0}<span class="text-(--muted)">, </span>{/if}
			{#if inp.name}<span class="token-name">{inp.name}</span><span class="text-(--muted)">: </span>{/if}
			{@render typeContent(inp.type)}
		{/each}
		<span class="text-(--muted)">)</span>
		{#if t.sig.output}<span class="text-(--muted)"> -&gt; </span>{@render typeContent(t.sig.output)}{/if}
	{:else if t.kind === 'Infer'}
		<span class="token-name">_</span>
	{:else if t.kind === 'Pat'}
		{@render typeContent(t.base)}<span class="text-(--muted)"> is {t.pat}</span>
	{/if}
{/snippet}

{#snippet genericArgs(args: import('$lib/schema').GenericArgs)}
	{#if args.kind === 'AngleBracketed'}
		{@const allParts: number = args.args.length + (args.constraints?.length ?? 0)}
		{#if allParts > 0}
			<ChevronLeftIcon class="generic-bracket" size={14} strokeWidth={2.5} />
			{#each args.args as arg, i (i)}
				{#if i > 0}<span class="generic-sep">, </span>{/if}
				{#if arg.kind === 'Type'}
					{@render typeContent(arg.value)}
				{:else if arg.kind === 'Lifetime'}
					<span class="token-name">{arg.name}</span>
				{:else if arg.kind === 'Const'}
					<span class="token-name">{arg.expr}</span>
				{:else if arg.kind === 'Infer'}
					<span class="token-name">_</span>
				{/if}
			{/each}
			{#if args.constraints && args.constraints.length > 0}
				{#each args.constraints as c, i (i)}
					{#if args.args.length > 0 || i > 0}<span class="generic-sep">, </span>{/if}
					<span class="token-name">{c.name}</span>
					{#if c.binding.kind === 'Equality'}
						<span class="text-(--muted)"> = </span>
						{#if c.binding.value.kind === 'Type'}{@render typeContent(c.binding.value.value)}{:else}<span class="token-name">{c.binding.value.expr}</span>{/if}
					{:else}
						<span class="text-(--muted)">: </span>
						{#each c.binding.bounds as b, j (j)}
							{#if j > 0}<span class="text-(--muted)"> + </span>{/if}
							{@render boundContent(b)}
						{/each}
					{/if}
				{/each}
			{/if}
			<ChevronRightIcon class="generic-bracket" size={14} strokeWidth={2.5} />
		{/if}
	{:else if args.kind === 'Parenthesized'}
		<span class="text-(--muted)">(</span>
		{#each args.inputs as inp, i (i)}
			{#if i > 0}<span class="text-(--muted)">, </span>{/if}
			{@render typeContent(inp)}
		{/each}
		<span class="text-(--muted)">)</span>
		{#if args.output}<span class="text-(--muted)"> -&gt; </span>{@render typeContent(args.output)}{/if}
	{/if}
{/snippet}

{#snippet boundContent(b: GenericBound)}
	{#if b.kind === 'Trait'}
		{#if b.modifier === 'maybe'}<span class="text-(--muted)">?</span>{/if}
		{#if b.modifier === 'maybe_const'}<span class="text-(--muted)">~const </span>{/if}
		{@render typeContent(b.trait)}
	{:else if b.kind === 'Outlives'}
		<span class="token-name">{b.lifetime}</span>
	{:else if b.kind === 'Use'}
		<span class="text-(--muted)">use&lt;</span>
		{#each b.captures as c, i (i)}{#if i > 0}<span class="text-(--muted)">, </span>{/if}<span class="token-name">{c.name}</span>{/each}
		<span class="text-(--muted)">&gt;</span>
	{/if}
{/snippet}

{#snippet paramBadge(p: GenericParam, strong: boolean)}
	<code class="badge {strong ? 'badge-strong' : ''} badge-code">
		{#if p.kind.kind === 'Const'}<span class="text-(--muted)">const </span>{/if}
		<span class="token-name">{p.name}</span>
		{#if p.kind.kind === 'Type' && p.kind.bounds && p.kind.bounds.length > 0}
			<span class="text-(--muted)">: </span>
			{#each p.kind.bounds as b, i (i)}
				{#if i > 0}<span class="text-(--muted)"> + </span>{/if}
				{@render boundContent(b)}
			{/each}
		{/if}
		{#if p.kind.kind === 'Lifetime' && p.kind.outlives && p.kind.outlives.length > 0}
			<span class="text-(--muted)">: </span>
			{#each p.kind.outlives as lt, i (i)}{#if i > 0}<span class="text-(--muted)"> + </span>{/if}<span class="token-name">{lt}</span>{/each}
		{/if}
		{#if p.kind.kind === 'Const'}
			<span class="text-(--muted)">: </span>{@render typeContent(p.kind.type)}
			{#if p.kind.default}<span class="text-(--muted)"> = {p.kind.default}</span>{/if}
		{/if}
		{#if p.kind.kind === 'Type' && p.kind.default}
			<span class="text-(--muted)"> = </span>{@render typeContent(p.kind.default)}
		{/if}
	</code>
{/snippet}

{#snippet wherePredBadge(pred: WherePredicate)}
	<code class="badge badge-code">
		{#if pred.kind === 'Bound'}
			{@render typeContent(pred.type)}
			<span class="text-(--muted)">: </span>
			{#each pred.bounds as b, i (i)}{#if i > 0}<span class="text-(--muted)"> + </span>{/if}{@render boundContent(b)}{/each}
		{:else if pred.kind === 'Lifetime'}
			<span class="token-name">{pred.lifetime}</span>
			<span class="text-(--muted)">: </span>
			{#each pred.outlives as lt, i (i)}{#if i > 0}<span class="text-(--muted)"> + </span>{/if}<span class="token-name">{lt}</span>{/each}
		{:else if pred.kind === 'Eq'}
			{@render typeContent(pred.lhs)}
			<span class="text-(--muted)"> = </span>
			{#if pred.rhs.kind === 'Type'}{@render typeContent(pred.rhs.value)}{:else}<span class="token-name">{pred.rhs.expr}</span>{/if}
		{/if}
	</code>
{/snippet}

<!-- Badge wrapping a TypeRef — used by argument types, return types,
	 field types, where any single type expression needs a styled chip. -->
{#snippet typeBadge(t: TypeRef, strong: boolean)}
	<code class="badge {strong ? 'badge-strong' : ''} badge-code">{@render typeContent(t)}</code>
{/snippet}

{#snippet traitLink(traitId: string)}
	<code class="badge badge-strong badge-code">
		{#if getNodeUrl && nodeExists?.(traitId) && !isExternalNode(traitId)}
			<a
				href={resolve(getNodeUrl(traitId))}
				data-sveltekit-noscroll
				class="text-(--accent) underline-offset-2 hover:underline"
			>
				{displayNode(traitId)}
			</a>
		{:else if isExternalNode(traitId)}
			<a
				href={resolve(getNodeUrl?.(traitId) ?? '#')}
				data-sveltekit-noscroll
				onclick={externalLinkHandler(traitId)}
				class="text-(--accent) underline-offset-2 hover:underline"
				title="Shift+click for external docs"
			>
				{displayNode(traitId)}
			</a>
		{:else}
			{displayNode(traitId)}
		{/if}
	</code>
{/snippet}

{#snippet implRow(implBlock: Node)}
	{@const implCategory = implCategoryLabel(implBlock.impl_category)}
	{@const traitNode = implBlock.impl_trait ? nodeMeta?.(implBlock.impl_trait) : undefined}
	{@const requiredCount = traitNode?.required_trait_methods?.length ?? 0}
	{@const defaultCount = traitNode?.default_trait_methods?.length ?? 0}
	{@const providedDefaultCount = implBlock.provided_trait_methods?.length ?? 0}
	{@const implGenerics = implBlock.generics?.params ?? []}
	{@const implWhere = implBlock.generics?.where_predicates ?? []}
	<div
		class="flex flex-wrap items-center gap-2 text-sm [contain-intrinsic-size:auto_28px] [content-visibility:auto]"
	>
		<span class="badge">impl</span>
		{#if implCategory}
			<span
				class="badge {implBlock.impl_category === 'Negative'
					? 'border-(--danger-border) bg-(--danger-bg) text-(--danger)'
					: implBlock.impl_category === 'Blanket' || implBlock.impl_category === 'Synthetic'
						? 'opacity-80'
						: ''}"
			>
				{implCategory}
			</span>
		{/if}
		{#if implGenerics.length > 0}
			{#each implGenerics as p, i (i)}
				{@render paramBadge(p, true)}
			{/each}
		{/if}
		{#if implBlock.impl_trait}
			{@render traitLink(implBlock.impl_trait)}
			<span class="text-(--muted)">for</span>
			<span class="token-name">{selected?.name}</span>
		{/if}
		{#if implWhere.length > 0}
			<span class="text-xs font-semibold tracking-wider text-(--muted) uppercase">where</span>
			{#each implWhere as pred, i (i)}
				{@render wherePredBadge(pred)}
			{/each}
		{/if}
		{#if implBlock.impl_trait && (requiredCount > 0 || defaultCount > 0)}
			<span class="text-xs text-(--muted)">
				{requiredCount} required, {defaultCount} default
				{#if providedDefaultCount > 0}
					· using {providedDefaultCount} default
				{/if}
			</span>
		{/if}
	</div>
{/snippet}

{#if selected}
	<div class="max-w-3xl">
		<!-- Header — doc-classic title row: kind label + h1 + qualified path -->
		<div class="mb-6">
			<div class="flex items-baseline gap-3 flex-wrap">
				<span
					class="font-mono text-[11px] font-semibold tracking-[0.18em] uppercase"
					style="color: {kindColors[selectedKind]}"
				>
					{kindLabels[selected.kind]}
				</span>
				<h1
					class="font-display text-[34px] font-semibold leading-none tracking-tight text-(--ink) {selected.is_deprecated
						? 'line-through opacity-80'
						: ''}"
				>
					{selected.name}
				</h1>
				<span class="font-mono text-[12px] text-(--muted-soft)">{selected.id}</span>
				{#if !isPublic(selected.visibility)}
					<span class="badge badge-sm">{visibilityLabel(selected.visibility)}</span>
				{/if}
				{#if selected.is_deprecated}
					<span class="badge badge-sm border-(--danger-border) bg-(--danger-bg) text-(--danger)">
						Deprecated
					</span>
				{/if}
				<div class="ml-auto flex items-center gap-1">
					<button
						type="button"
						class="badge badge-sm inline-flex items-center gap-1 transition-colors hover:bg-(--panel-strong) hover:text-(--ink)"
						onclick={expandAll}
					>
						<ChevronsUpDown size={11} />
						Expand
					</button>
					<button
						type="button"
						class="badge badge-sm inline-flex items-center gap-1 transition-colors hover:bg-(--panel-strong) hover:text-(--ink)"
						onclick={collapseAll}
					>
						<ChevronsDownUp size={11} />
						Collapse
					</button>
				</div>
			</div>
			{#if selected.deprecation?.note}
				<p class="mt-2 text-sm text-(--danger)">{selected.deprecation.note}</p>
			{/if}
			{#if selected?.span}
				<div
					class="mt-3 flex items-center gap-3 font-mono text-[11px] text-(--muted-soft)"
				>
					<SourceViewer
						span={selected?.span ?? { file: '', line: 0 }}
						{theme}
						crateName={crateFromId(selected?.id) ?? crateName}
						crateVersion={resolveVersionForCrate(selected?.id)}
					/>
				</div>
			{/if}
			{#if selected.generics?.params && selected.generics.params.length > 0}
				<div class="mt-3 flex flex-wrap items-center gap-2">
					{#each selected.generics.params as p, i (i)}
						{@render paramBadge(p, true)}
					{/each}
				</div>
			{/if}
			{#if selected.generics?.where_predicates && selected.generics.where_predicates.length > 0}
				<div class="mt-2 flex flex-wrap items-center gap-2">
					<span class="text-xs font-semibold tracking-wider text-(--muted) uppercase">where</span>
					{#each selected.generics.where_predicates as pred, i (i)}
						{@render wherePredBadge(pred)}
					{/each}
				</div>
			{/if}
		</div>

		<!-- Below-title slot: doc page hoists the Relationship Graph here so
			 the visual context shows before the prose. -->
		{@render belowTitle?.()}

		<!-- Parent context for associated items -->
		{#if selected.parent_impl}
			<div class="mb-4 flex items-center gap-2 text-sm">
				<span class="text-(--muted)">Defined in</span>
				{#if getNodeUrl && nodeExists?.(selected.parent_impl)}
					<a
						href={resolve(getNodeUrl(selected.parent_impl))}
						data-sveltekit-noscroll
						class="badge badge-strong text-(--accent) underline-offset-2 hover:underline"
					>
						{displayNode(selected.parent_impl)}
					</a>
				{:else}
					<code class="badge badge-strong badge-code">{displayNode(selected.parent_impl)}</code>
				{/if}
			</div>
		{/if}

		<!-- Signature (always open) -->
		{#if selected.signature}
			<CollapsibleSection bind:this={signatureRef} title="Signature" defaultOpen={true}>
				<div>
					<SignatureBlock node={selected} {theme} />
				</div>
				{#if selected.signature.inputs.length > 0}
					<div class="mt-4">
						<h4 class="text-xs font-semibold tracking-wider text-(--muted) uppercase">Arguments</h4>
						<div class="mt-2 space-y-2">
							{#each selected.signature.inputs as arg (arg.name)}
								<div class="flex flex-wrap items-baseline gap-2">
									<code class="badge badge-strong badge-code">{arg.name}</code>
									<span class="text-(--muted)">:</span>
									{@render typeBadge(arg.type, false)}
								</div>
							{/each}
						</div>
					</div>
				{/if}
				{#if selected.signature.output}
					<div class="mt-4">
						<h4 class="text-xs font-semibold tracking-wider text-(--muted) uppercase">Returns</h4>
						<div class="mt-2">
							{@render typeBadge(selected.signature.output, false)}
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
				<table class="w-full text-sm [text-box:trim-both_cap_alphabetic]">
					<thead>
						<tr class="text-left text-[10px] font-semibold tracking-wider text-(--muted) uppercase">
							<th class="pr-3 pb-2 font-semibold">Name</th>
							<th class="pb-2 font-semibold">Type</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-(--panel-border)">
						{#each selected.fields as field (field.name)}
							<tr class="group">
								<td class="py-2 pr-3 align-baseline whitespace-nowrap">
									<span class="inline-flex items-baseline gap-1.5">
										{#if isPublic(field.visibility)}
											<span class="text-[10px] font-medium text-(--accent)">pub</span>
										{:else}
											<span class="text-[10px] font-medium text-(--muted)">prv</span>
										{/if}
										<code class="font-(--font-code) font-medium text-(--ink)">{field.name}</code>
									</span>
								</td>
								<td class="py-2 align-baseline">
									{@render typeBadge(field.type, false)}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
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
				<div class="divide-y divide-(--panel-border) [text-box:trim-both_cap_alphabetic]">
					{#each selected.variants as variant (variant.name)}
						<div
							class="py-2.5 [contain-intrinsic-size:auto_36px] [content-visibility:auto] first:pt-0 last:pb-0"
						>
							<div class="flex items-baseline gap-2">
								<code class="font-(--font-code) font-medium text-(--ink)">{variant.name}</code>
								{#if variant.fields.length === 0}
									<!-- Unit variant — nothing else to show -->
								{:else if isTupleVariant(variant.fields)}
									<!-- Tuple variant — show types inline -->
									<span class="font-(--font-code) text-(--muted)">
										({#each variant.fields as field, i (field.name)}{#if i > 0},
											{/if}{@render typeBadge(field.type, false)}{/each})
									</span>
								{:else}
									<span class="text-xs text-(--muted)">
										{variant.fields.length} field{variant.fields.length === 1 ? '' : 's'}
									</span>
								{/if}
							</div>
							{#if variant.fields.length > 0 && !isTupleVariant(variant.fields)}
								<!-- Named struct fields — show as indented sub-table -->
								<div class="mt-1.5 ml-4 border-l-2 border-(--panel-border) pl-3">
									{#each variant.fields as field (field.name)}
										<div class="flex items-baseline gap-1.5 py-0.5 text-sm">
											<code class="font-(--font-code) text-(--ink)">{field.name}</code>
											<span class="text-(--muted)">:</span>
											<span class="font-(--font-code) text-(--muted)">
												{@render typeBadge(field.type, false)}
											</span>
										</div>
									{/each}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			</CollapsibleSection>
		{/if}

		<!-- Type info for StructField, AssocType, AssocConst -->
		{#if selected.type && (selectedKind === 'StructField' || selectedKind === 'AssocType' || selectedKind === 'AssocConst')}
			<CollapsibleSection bind:this={typeInfoRef} title="Type" defaultOpen={true}>
				<div class="flex flex-wrap items-baseline gap-2">
					{#if selectedKind === 'AssocConst'}
						<span class="text-(--muted)">const</span>
						<code class="badge badge-strong badge-code">{selected.name}</code>
						<span class="text-(--muted)">:</span>
					{:else if selectedKind === 'AssocType'}
						<span class="text-(--muted)">type</span>
						<code class="badge badge-strong badge-code">{selected.name}</code>
						<span class="text-(--muted)">=</span>
					{:else}
						<code class="badge badge-strong badge-code">{selected.name}</code>
						<span class="text-(--muted)">:</span>
					{/if}
					{@render typeBadge(selected.type, false)}
				</div>
				{#if selected.const_value}
					<div class="mt-3">
						<h4 class="text-xs font-semibold tracking-wider text-(--muted) uppercase">Value</h4>
						<code class="mt-1 block text-sm font-(--font-code) text-(--ink)">
							{selected.const_value}
						</code>
					</div>
				{/if}
			</CollapsibleSection>
		{/if}

		<!-- Bounds for AssocType -->
		{#if selected.bounds && selected.bounds.length > 0}
			<CollapsibleSection
				bind:this={boundsRef}
				title="Bounds"
				count={selected.bounds.length}
				defaultOpen={true}
			>
				<div class="flex flex-wrap items-center gap-2">
					{#each selected.bounds as bound, idx (idx)}
						<code class="badge badge-code">{@render boundContent(bound)}</code>
						{#if idx < selected.bounds.length - 1}
							<span class="text-(--muted)">+</span>
						{/if}
					{/each}
				</div>
			</CollapsibleSection>
		{/if}

		<!-- Variant info -->
		{#if selectedKind === 'Variant'}
			<CollapsibleSection bind:this={variantTypeRef} title="Variant Type" defaultOpen={true}>
				<div class="flex items-center gap-2">
					<span class="badge">{selected.variant_kind ?? 'unit'}</span>
					{#if selected.discriminant}
						<span class="text-(--muted)">=</span>
						<code class="badge badge-code">{selected.discriminant}</code>
					{/if}
				</div>
			</CollapsibleSection>
		{/if}

		<!-- Documentation (always open) -->
		{#if selected.docs}
			<DocSection title="Documentation" anchor="documentation">
				<Documentation
					docs={selected.docs}
					defaultLang="rust"
					{theme}
					docLinks={selected.doc_links ?? {}}
					{getNodeUrl}
					{nodeExists}
				/>
			</DocSection>
		{/if}

		<!-- Methods -->
		{#if methodCount > 0}
			<DocSection title="Methods" anchor="methods" count={methodCount}>
				<div class="space-y-6">
					{#each methodGroups as group (group.impl.id)}
						<div
							class="corner-squircle overflow-hidden rounded-(--radius-card) border border-(--panel-border) bg-(--panel) [contain-intrinsic-size:auto_120px] [content-visibility:auto]"
						>
							<div class="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
								<div class="flex items-center gap-2">
									<span class="badge">impl</span>
									{#if getNodeUrl && nodeExists?.(selected?.id)}
										<a
											href={resolve(getNodeUrl(selected?.id))}
											data-sveltekit-noscroll
											class="token-name text-(--accent) underline-offset-2 hover:underline"
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
										<span class="font-(--font-code) text-(--muted)">Location unavailable</span>
									{/if}
								</div>
							</div>
							<div>
								{#each group.methods as method, index (method.id)}
									{@const hasModifiers =
										isPublic(method.visibility) ||
										method.signature?.is_async ||
										method.signature?.is_unsafe ||
										method.signature?.is_const}
									<div
										class={`bg-(--panel-solid) px-3 py-3 [contain-intrinsic-size:auto_80px] [content-visibility:auto] ${index ? 'border-t border-(--panel-border)' : ''}`}
									>
										<!-- Header strip: chips left, source link right. Keeps both
											 out of the signature's flow so the signature can claim
											 the full row width and word-wrap with rustfmt-style
											 breaks without fighting other content for space. -->
										{#if hasModifiers || method.span}
											<div class="mb-2 flex flex-wrap items-baseline justify-between gap-2">
												<div class="flex items-center gap-1">
													{#if isPublic(method.visibility)}
														<span class="badge badge-strong text-(--accent)">pub</span>
													{/if}
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
												{#if method.span}
													<div class="text-xs">
														<SourceViewer
															span={method.span}
															{theme}
															crateName={crateFromId(method.id) ?? crateName}
															crateVersion={resolveVersionForCrate(method.id)}
														/>
													</div>
												{/if}
											</div>
										{/if}
										{#if method.signature}
											<SignatureBlock node={method} {theme} variant="flat" />
										{/if}
										{#if method.docs}
											<div
												class={`mt-3 text-sm text-(--muted) ${method.signature ? 'border-t border-(--panel-border-soft) pt-3' : ''}`}
											>
												<Documentation
													docs={method.docs}
													defaultLang="rust"
													{theme}
													docLinks={method.doc_links ?? {}}
													{getNodeUrl}
													{nodeExists}
												/>
											</div>
										{/if}
									</div>
								{/each}
							</div>
						</div>
					{/each}
				</div>
			</DocSection>
		{/if}

		{#if totalImpls > 0}
			<DocSection title="Trait implementations" anchor="trait-impls" count={totalImpls}>
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
							<summary
								class="cursor-pointer text-xs font-semibold tracking-wider text-(--muted) uppercase transition-colors select-none hover:text-(--ink)"
							>
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
			</DocSection>
		{/if}

		<!-- Relationships — inline section with the full edge layout.
			 Hide entirely when the node has no edges (e.g. crate root) — the
			 default "no outgoing / no incoming" empty state is noise. -->
		{#if selectedEdges.outgoing.length + selectedEdges.incoming.length > 0}
			<DocSection
				title="Relationships"
				anchor="relationships"
				count={selectedEdges.outgoing.length + selectedEdges.incoming.length}
			>
			<div class="grid gap-6 md:grid-cols-2">
				<!-- Outgoing edges -->
				<div>
					<h4 class="mb-2 text-xs font-semibold tracking-wider text-(--muted) uppercase">
						Outgoing ({selectedEdges.outgoing.length})
					</h4>
					<div class="grid grid-cols-[max-content_1fr] gap-2 text-sm">
						{#if selectedEdges.outgoing.length === 0}
							<p class="col-span-2 text-(--muted)">No outgoing edges</p>
						{:else}
							{#each selectedEdges.outgoing as edge (edge.kind + '-' + edge.to)}
								<div class="flex items-center gap-1.5">
									<span
										class="badge"
										{@attach tooltip(edgeKindDescriptions[edge.kind as EdgeKind] ?? edge.kind)}
									>
										{edgeLabels[edge.kind]}
									</span>
									{#if edge.kind === 'ReExports' && edge.is_glob}
										<span class="badge" title="Glob re-export (pub use ...::*)">glob</span>
									{/if}
									{#if edge.confidence !== 'Static'}
										<span
											class="badge {edge.confidence === 'Inferred'
												? 'border-(--panel-border) opacity-80'
												: ''}"
										>
											{edge.confidence}
										</span>
									{/if}
								</div>
								<div>
									{#if getNodeUrl && !isExternalNode(edge.to)}
										<a
											href={resolve(getNodeUrl(edge.to))}
											data-sveltekit-noscroll
											class="text-(--ink) hover:text-(--accent)"
										>
											{displayNode(edge.to)}
										</a>
									{:else if isExternalNode(edge.to) && getNodeUrl}
										<a
											href={resolve(getNodeUrl(edge.to))}
											data-sveltekit-noscroll
											onclick={externalLinkHandler(edge.to)}
											class="text-(--ink) hover:text-(--accent)"
											title="Shift+click for external docs"
										>
											{displayNode(edge.to)}
										</a>
									{:else}
										<span class="text-(--ink)">{displayNode(edge.to)}</span>
									{/if}
								</div>
							{/each}
						{/if}
					</div>
				</div>

				<!-- Incoming edges -->
				<div>
					<h4 class="mb-2 text-xs font-semibold tracking-wider text-(--muted) uppercase">
						Incoming ({selectedEdges.incoming.length})
					</h4>
					<div class="grid grid-cols-[max-content_1fr] gap-2 text-sm">
						{#if selectedEdges.incoming.length === 0}
							<p class="col-span-2 text-(--muted)">No incoming edges</p>
						{:else}
							{#each selectedEdges.incoming as edge (edge.kind + '-' + edge.from)}
								<div class="flex items-center gap-1.5">
									<span
										class="badge"
										{@attach tooltip(edgeKindDescriptions[edge.kind as EdgeKind] ?? edge.kind)}
									>
										{edgeLabels[edge.kind]}
									</span>
									{#if edge.kind === 'ReExports' && edge.is_glob}
										<span class="badge" title="Glob re-export (pub use ...::*)">glob</span>
									{/if}
									{#if edge.confidence !== 'Static'}
										<span
											class="badge {edge.confidence === 'Inferred'
												? 'border-(--panel-border) opacity-80'
												: ''}"
										>
											{edge.confidence}
										</span>
									{/if}
								</div>
								<div>
									{#if getNodeUrl && !isExternalNode(edge.from)}
										<a
											href={resolve(getNodeUrl(edge.from))}
											data-sveltekit-noscroll
											class="text-(--ink) hover:text-(--accent)"
										>
											{displayNode(edge.from)}
										</a>
									{:else if isExternalNode(edge.from) && getNodeUrl}
										<a
											href={resolve(getNodeUrl(edge.from))}
											data-sveltekit-noscroll
											onclick={externalLinkHandler(edge.from)}
											class="text-(--ink) hover:text-(--accent)"
											title="Shift+click for external docs"
										>
											{displayNode(edge.from)}
										</a>
									{:else}
										<span class="text-(--ink)">{displayNode(edge.from)}</span>
									{/if}
								</div>
							{/each}
						{/if}
					</div>
				</div>
			</div>
			</DocSection>
		{/if}

		<!-- Attributes -->
		{#if selected.attrs && selected.attrs.length > 0}
			<DocSection title="Attributes" anchor="attributes" count={selected.attrs.length}>
				<div class="space-y-1">
					{#each selected.attrs as attr (attr)}
						<code class="token-meta block text-sm">{attr}</code>
					{/each}
				</div>
			</DocSection>
		{/if}
	</div>
{:else}
	<p class="text-sm text-(--muted)">Select a node to view details</p>
{/if}
