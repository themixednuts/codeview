<script lang="ts">
	import type { Node, NodeKind, Visibility } from '$lib/graph';
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

	import { resolveAppPath } from '$lib/app-paths';
	import { kindColors } from '$lib/tree';
	import { externalDocsUrl } from '$lib/docs';
	import Documentation from './Documentation.svelte';
	import CodeBlock from './CodeBlock.svelte';
	import CollapsibleSection from './CollapsibleSection.svelte';
	import SignatureBlock from './SignatureBlock.svelte';
	import SourceViewer from './SourceViewer.svelte';
	import Icon from '$lib/components/design/Icon.svelte';
	import { hyphenateCrateName, normalizeCrateName } from '$lib/crate-names';
	import { extLinkModeCtx } from '$lib/context';

	const extLinkMode = $derived(extLinkModeCtx.get());

	type MethodGroup = {
		impl: Node;
		methods: Node[];
	};

	let {
		selected,
		sourceImpls,
		blanketImpls,
		methodGroups,
		traitImplGroups,
		kindLabels,
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
		sourceImpls: Node[];
		blanketImpls: Node[];
		methodGroups: MethodGroup[];
		traitImplGroups: MethodGroup[];
		kindLabels: Record<NodeKind, string>;
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

	const selectedKind = $derived(selected?.kind as NodeKind);
	const unknownVisibility: Visibility = { kind: 'Unknown' };
	const selectedVisibility = $derived(safeVisibility(selected));
	const selectedIsPublic = $derived(isPublic(selectedVisibility));
	const selectedVisibilityLabel = $derived(visibilityLabel(selectedVisibility));
	const traitImplGroupById = $derived(
		new Map<string, MethodGroup>(
			traitImplGroups.map((group: MethodGroup) => [group.impl.id, group] as const),
		),
	);

	function safeVisibility(node: Node | null): Visibility {
		const raw = node as unknown;
		if (!raw || typeof raw !== 'object') return unknownVisibility;
		return ((raw as { visibility?: Visibility }).visibility ?? unknownVisibility) as Visibility;
	}

	function safeNodeId(value: unknown): string | null {
		return typeof value === 'string' && value.length > 0 ? value : null;
	}

	function crateFromId(id?: unknown) {
		return safeNodeId(id)?.split('::')[0];
	}

	function resolveVersionForCrate(id?: unknown) {
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

	function displayNodeSafe(value: unknown): string {
		const nodeId = safeNodeId(value);
		if (!nodeId) return '';
		try {
			return displayNode(nodeId);
		} catch {
			return nodeId;
		}
	}

	function hasInternalNode(value: unknown): boolean {
		const nodeId = safeNodeId(value);
		return !!nodeId && !!getNodeUrl && !!nodeExists?.(nodeId) && !isExternalNode(nodeId);
	}

	function hasExternalNode(value: unknown): boolean {
		const nodeId = safeNodeId(value);
		return !!nodeId && !!getNodeUrl && isExternalNode(nodeId);
	}

	function nodeHref(value: unknown): string {
		const nodeId = safeNodeId(value);
		if (!nodeId || !getNodeUrl) return '#';
		const href = getNodeUrl(nodeId);
		return typeof href === 'string' && href.length > 0 ? resolveAppPath(href) : '#';
	}

	function isExternalNode(value: unknown): boolean {
		const nodeId = safeNodeId(value);
		return nodeId ? (nodeMeta?.(nodeId)?.is_external ?? false) : false;
	}

	function externalNodeKind(value: unknown): NodeKind | undefined {
		const nodeId = safeNodeId(value);
		return nodeId ? nodeMeta?.(nodeId)?.kind : undefined;
	}

	function externalLinkHandler(value: unknown): (e: MouseEvent) => void {
		const nodeId = safeNodeId(value);
		const kind = externalNodeKind(nodeId);
		const crate = crateFromId(nodeId);
		const version = crate ? crateVersions?.[crate] : undefined;
		return (e: MouseEvent) => {
			if (!nodeId) {
				e.preventDefault();
				return;
			}
			if (extLinkMode === 'docs') {
				e.preventDefault();
				e.stopPropagation();
				window.open(externalDocsUrl(nodeId, kind, version), '_blank', 'noopener,noreferrer');
			}
		};
	}

	let sectionForceOpen = $state<boolean | null>(null);
	let sectionForceVersion = $state(0);

	function expandAll() {
		sectionForceOpen = true;
		sectionForceVersion += 1;
	}

	function collapseAll() {
		sectionForceOpen = false;
		sectionForceVersion += 1;
	}

	// Smart defaults: collapse sections with many items
	const FIELDS_COLLAPSE_THRESHOLD = 5;
	const VARIANTS_COLLAPSE_THRESHOLD = 5;
	const METHODS_COLLAPSE_THRESHOLD = 8;
	const IMPLS_COLLAPSE_THRESHOLD = 6;

	function totalImplCount(): number {
		return sourceImpls.length + blanketImpls.length;
	}

	function methodCountValue(): number {
		return methodGroups.reduce(
			(total: number, group: MethodGroup) => total + group.methods.length,
			0,
		);
	}

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

	function parentPathFor(node: Node): string {
		const suffix = `::${node.name}`;
		if (node.id.endsWith(suffix)) return node.id.slice(0, -suffix.length);
		const parts = node.id.split('::');
		return parts.length > 1 ? parts.slice(0, -1).join('::') : node.id;
	}

	function memberKindLabel(kind: NodeKind): string {
		switch (kind) {
			case 'Function':
				return 'fn';
			case 'AssocType':
				return 'type';
			case 'AssocConst':
			case 'Constant':
				return 'const';
			default:
				return kindLabels[kind] ?? kind;
		}
	}

	function traitImplGroup(implId: string): MethodGroup | undefined {
		return traitImplGroupById.get(implId);
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
	{#if hasInternalNode(id)}
		<a
			href={nodeHref(id)}
			data-sveltekit-noscroll
			class="text-(--accent) underline-offset-2 hover:underline"
		>
			{display}
		</a>
	{:else if hasExternalNode(id)}
		<a
			href={nodeHref(id)}
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
			<Icon name="chevron-left" class="generic-bracket" size={14} strokeWidth={2.5} />
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
			<Icon name="chevron-right" class="generic-bracket" size={14} strokeWidth={2.5} />
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
		{#if hasInternalNode(traitId)}
			<a
				href={nodeHref(traitId)}
				data-sveltekit-noscroll
				class="text-(--accent) underline-offset-2 hover:underline"
			>
				{displayNode(traitId)}
			</a>
		{:else if hasExternalNode(traitId)}
			<a
				href={nodeHref(traitId)}
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

{#snippet attributesPanel(attrs: string[])}
	<details
		class="mt-3 rounded-md border border-(--panel-border-soft) bg-(--panel) px-3 py-2"
	>
		<summary
			class="cursor-pointer text-xs font-semibold tracking-wider text-(--muted) uppercase select-none"
		>
			Attributes <span class="font-mono text-(--muted-soft)">({attrs.length})</span>
		</summary>
		<div class="mt-2 space-y-1 border-t border-(--panel-border-soft) pt-2">
			{#each attrs as attr (attr)}
				<code class="token-meta block text-sm">{attr}</code>
			{/each}
		</div>
	</details>
{/snippet}

{#snippet implMemberRow(member: Node, index: number)}
	<div
		class={`bg-(--panel-solid) px-3 py-3 [contain-intrinsic-size:auto_92px] [content-visibility:auto] ${index ? 'border-t border-(--panel-border)' : ''}`}
	>
		<div class="mb-2 flex flex-wrap items-baseline justify-between gap-2">
			<div class="flex min-w-0 items-center gap-2">
				<span
					class="badge badge-sm font-mono uppercase"
					style={`color: ${kindColors[member.kind]}`}
				>
					{memberKindLabel(member.kind)}
				</span>
				{#if !member.signature}
					<code class="font-(--font-code) font-medium text-(--ink)">{member.name}</code>
				{/if}
			</div>
			{#if member.span}
				<div class="text-xs">
					<SourceViewer
						span={member.span}
						{theme}
						crateName={crateFromId(member.id) ?? crateName}
						crateVersion={resolveVersionForCrate(member.id)}
					/>
				</div>
			{/if}
		</div>
		{#if member.signature}
			<SignatureBlock node={member} {theme} variant="flat" />
		{:else if member.type}
			<div class="flex flex-wrap items-baseline gap-2 font-(--font-code) text-sm">
				{#if member.kind === 'AssocConst' || member.kind === 'Constant'}
					<span class="text-(--muted)">const</span>
					<code class="text-(--ink)">{member.name}</code>
					<span class="text-(--muted)">:</span>
					{@render typeBadge(member.type, false)}
					{#if member.const_value}
						<span class="text-(--muted)">=</span>
						<code class="text-(--ink)">{member.const_value}</code>
					{/if}
				{:else}
					<span class="text-(--muted)">type</span>
					<code class="text-(--ink)">{member.name}</code>
					<span class="text-(--muted)">=</span>
					{@render typeBadge(member.type, false)}
				{/if}
			</div>
		{/if}
		{#if member.docs}
			<div
				class={`mt-3 text-sm text-(--muted) ${member.signature || member.type ? 'border-t border-(--panel-border-soft) pt-3' : ''}`}
			>
				<Documentation
					docs={member.docs}
					defaultLang="rust"
					{theme}
					docLinks={member.doc_links ?? {}}
					{getNodeUrl}
					{nodeExists}
				/>
			</div>
		{/if}
	</div>
{/snippet}

{#snippet traitImplBlock(implBlock: Node)}
	{@const group = traitImplGroup(implBlock.id)}
	<article
		class="corner-squircle overflow-hidden rounded-(--radius-card) border border-(--panel-border) bg-(--panel)"
	>
		<div class="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
			{@render implRow(implBlock)}
			{#if implBlock.span}
				<div class="text-xs">
					<SourceViewer
						span={implBlock.span}
						{theme}
						crateName={crateFromId(implBlock.id) ?? crateName}
						crateVersion={resolveVersionForCrate(implBlock.id)}
					/>
				</div>
			{/if}
		</div>
		{#if group && group.methods.length > 0}
			<div>
				{#each group.methods as member, index (member.id)}
					{@render implMemberRow(member, index)}
				{/each}
			</div>
		{/if}
	</article>
{/snippet}

{#if selected}
	<div class="max-w-3xl">
		<!-- Header — doc-classic title row: kind label + h1 + qualified path -->
		<div class="doc-title-header mb-6">
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
				<span class="font-mono text-[12px] text-(--muted-soft)">{parentPathFor(selected)}</span>
				{#if !selectedIsPublic}
					<span class="badge badge-sm">{selectedVisibilityLabel}</span>
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
						<Icon name="chevrons-up-down" size={11} strokeWidth={2} />
						Expand
					</button>
					<button
						type="button"
						class="badge badge-sm inline-flex items-center gap-1 transition-colors hover:bg-(--panel-strong) hover:text-(--ink)"
						onclick={collapseAll}
					>
						<Icon name="chevrons-down-up" size={11} strokeWidth={2} />
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
			{#if selected.attrs && selected.attrs.length > 0}
				{@render attributesPanel(selected.attrs)}
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
				{#if hasInternalNode(selected.parent_impl)}
					<a
						href={nodeHref(selected.parent_impl)}
						data-sveltekit-noscroll
						class="badge badge-strong text-(--accent) underline-offset-2 hover:underline"
					>
						{displayNodeSafe(selected.parent_impl)}
					</a>
				{:else}
					<code class="badge badge-strong badge-code">{displayNodeSafe(selected.parent_impl)}</code>
				{/if}
			</div>
		{/if}

		<!-- Signature (always open) -->
		{#if selected.signature}
			<CollapsibleSection
				title="Signature"
				defaultOpen={true}
				forceOpen={sectionForceOpen}
				forceVersion={sectionForceVersion}
			>
				<div>
					<SignatureBlock node={selected} {theme} />
				</div>
			</CollapsibleSection>
		{/if}

		<!-- Fields (collapse if many) -->
		{#if selected.fields && selected.fields.length > 0}
			<CollapsibleSection
				title="Fields"
				count={selected.fields.length}
				defaultOpen={selected.fields.length <= FIELDS_COLLAPSE_THRESHOLD}
				forceOpen={sectionForceOpen}
				forceVersion={sectionForceVersion}
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
				title="Variants"
				count={selected.variants.length}
				defaultOpen={selected.variants.length <= VARIANTS_COLLAPSE_THRESHOLD}
				forceOpen={sectionForceOpen}
				forceVersion={sectionForceVersion}
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
			<CollapsibleSection
				title="Type"
				defaultOpen={true}
				forceOpen={sectionForceOpen}
				forceVersion={sectionForceVersion}
			>
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
				title="Bounds"
				count={selected.bounds.length}
				defaultOpen={true}
				forceOpen={sectionForceOpen}
				forceVersion={sectionForceVersion}
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
			<CollapsibleSection
				title="Variant Type"
				defaultOpen={true}
				forceOpen={sectionForceOpen}
				forceVersion={sectionForceVersion}
			>
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
			<section id="documentation" class="doc-section group">
				<div
					class="mt-9 mb-4 flex items-baseline gap-3 border-b border-(--panel-border-soft) pb-2"
				>
					<h2
						class="font-display text-[22px] leading-tight font-semibold tracking-tight text-(--ink)"
					>
						Documentation
					</h2>
				</div>
				<Documentation
					docs={selected.docs}
					defaultLang="rust"
					{theme}
					docLinks={selected.doc_links ?? {}}
					{getNodeUrl}
					{nodeExists}
				/>
			</section>
		{/if}

		<!-- Methods -->
		{#if methodCountValue() > 0}
			<section id="methods" class="doc-section group">
				<div
					class="mt-9 mb-4 flex items-baseline gap-3 border-b border-(--panel-border-soft) pb-2"
				>
					<h2
						class="font-display text-[22px] leading-tight font-semibold tracking-tight text-(--ink)"
					>
						Methods
					</h2>
				</div>
				<div class="space-y-6">
					{#each methodGroups as group (group.impl.id)}
						<div
							class="corner-squircle overflow-hidden rounded-(--radius-card) border border-(--panel-border) bg-(--panel) [contain-intrinsic-size:auto_120px] [content-visibility:auto]"
						>
							<div class="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
								<div class="flex items-center gap-2">
									<span class="badge">impl</span>
									{#if hasInternalNode(selected?.id)}
										<a
											href={nodeHref(selected?.id)}
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
			</section>
		{/if}

		{#if totalImplCount() > 0}
			<section id="trait-impls" class="doc-section group">
				<div
					class="mt-9 mb-4 flex items-baseline gap-3 border-b border-(--panel-border-soft) pb-2"
				>
					<h2
						class="font-display text-[22px] leading-tight font-semibold tracking-tight text-(--ink)"
					>
						Trait implementations
					</h2>
				</div>
				<div class="space-y-4">
					<!-- Source (user-written) implementations -->
					{#if sourceImpls.length > 0}
						<div class="space-y-3">
							{#each sourceImpls as implBlock (implBlock.id)}
								{@render traitImplBlock(implBlock)}
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
			</section>
		{/if}

	</div>
{:else}
	<p class="text-sm text-(--muted)">Select a node to view details</p>
{/if}

<style>
	@media (max-width: 1279.98px) {
		.doc-title-header {
			position: sticky;
			top: 0;
			z-index: 20;
			margin-inline: -0.25rem;
			padding: 0.85rem 0.25rem 0.75rem;
			border-bottom: 1px solid var(--panel-border-soft);
			background: color-mix(in srgb, var(--bg) 94%, transparent);
			backdrop-filter: blur(12px);
			-webkit-backdrop-filter: blur(12px);
		}
	}
</style>
