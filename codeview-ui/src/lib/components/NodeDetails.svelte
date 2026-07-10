<script lang="ts">
	import type { Node, NodeKind, Visibility } from '$lib/graph';
	import { isPublic, visibilityLabel } from '$lib/display-names';
	import type { GenericBound, GenericParam, TypeRef, WherePredicate } from '$lib/schema';

	/** Final segment of a `::`-separated path. `std::vec::Vec` → `Vec`. */
	function pathTail(path: string): string {
		const idx = path.lastIndexOf('::');
		return idx >= 0 ? path.slice(idx + 2) : path;
	}

	import { resolveAppPath } from '$lib/app-paths';
	import { kindColors } from '$lib/tree';
	import { externalDocsUrl } from '$lib/docs';
	import { formatItemDeclaration } from '$lib/signature-format';
	import { renderMarkdown } from '$lib/highlight/markdown';
	import { renderTypeText } from '$lib/type-render';
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
	type DirectItemGroup = {
		kind: NodeKind;
		label: string;
		items: Node[];
	};

	let {
		selected,
		sourceImpls,
		blanketImpls,
		methodGroups,
		traitImplGroups,
		requiredTraitMethods = [],
		providedTraitMethods = [],
		traitAssocItems = [],
		directItems = [],
		kindLabels,
		displayNode,
		implementers = [],
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
		requiredTraitMethods?: Node[];
		providedTraitMethods?: Node[];
		traitAssocItems?: Node[];
		directItems?: Node[];
		kindLabels: Record<NodeKind, string>;
		displayNode: (id: string) => string;
		implementers?: { id: string; name: string }[];
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
	const selectedVisibilityLabel = $derived(
		selectedVisibility.kind === 'Unknown' || selectedVisibility.kind === 'Inherited'
			? 'Private'
			: visibilityLabel(selectedVisibility),
	);
	const traitImplGroupById = $derived(
		new Map<string, MethodGroup>(
			traitImplGroups.map((group: MethodGroup) => [group.impl.id, group] as const),
		),
	);

	/** Canonical rustfmt-style declaration for the selected item.
	 *  Falls back to null for kinds without a meaningful declaration. */
	const itemDeclaration = $derived(selected ? formatItemDeclaration(selected) : null);
	const directItemGroups = $derived.by(() => {
		const groups: DirectItemGroup[] = [];
		for (const item of directItems) {
			let group = groups.find((candidate) => candidate.kind === item.kind);
			if (!group) {
				group = { kind: item.kind, label: crateItemGroupLabel(item.kind), items: [] };
				groups.push(group);
			}
			group.items.push(item);
		}
		return groups;
	});

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
		return (
			!!nodeId &&
			!!getNodeUrl &&
			!!nodeExists?.(nodeId) &&
			isRoutableNode(nodeId) &&
			!isExternalNode(nodeId)
		);
	}

	function hasExternalNode(value: unknown): boolean {
		const nodeId = safeNodeId(value);
		return !!nodeId && !!getNodeUrl && isRoutableNode(nodeId) && isExternalNode(nodeId);
	}

	function isRoutableNode(value: unknown): boolean {
		const nodeId = safeNodeId(value);
		return !!nodeId && nodeMeta?.(nodeId)?.kind !== 'Impl';
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
	let sectionForceToken = $state(0);

	function expandAll() {
		sectionForceOpen = true;
		sectionForceToken += 1;
	}

	function collapseAll() {
		sectionForceOpen = false;
		sectionForceToken += 1;
	}

	// Smart defaults: collapse sections with many items

	function totalImplCount(): number {
		return sourceImpls.length + blanketImpls.length;
	}

	function methodCountValue(): number {
		return methodGroups.reduce(
			(total: number, group: MethodGroup) => total + group.methods.length,
			0,
		);
	}

	function isTupleVariant(fields: { name: string }[]): boolean {
		return fields.length > 0 && fields.every((f) => /^\d+$/.test(f.name));
	}

	function crateItemGroupLabel(kind: NodeKind): string {
		switch (kind) {
			case 'Module':
				return 'Modules';
			case 'Struct':
				return 'Structs';
			case 'Enum':
				return 'Enums';
			case 'Union':
				return 'Unions';
			case 'Trait':
				return 'Traits';
			case 'TraitAlias':
				return 'Trait aliases';
			case 'Function':
				return 'Functions';
			case 'TypeAlias':
				return 'Type aliases';
			case 'Constant':
				return 'Constants';
			case 'Static':
				return 'Statics';
			case 'Macro':
				return 'Macros';
			case 'ProcMacro':
				return 'Procedural macros';
			case 'Primitive':
				return 'Primitive types';
			default:
				return kindLabels[kind] ?? kind;
		}
	}

	function docsSummary(docs: string | null | undefined): string | null {
		if (!docs) return null;
		const paragraph = docs.split(/\n\s*\n/, 1)[0]?.trim();
		return paragraph ? renderMarkdown(paragraph) : null;
	}

	/** Visibility keyword prefix for a field (`pub ` / `pub(crate) ` / ``). */
	function fieldVisPrefix(vis: Visibility | undefined): string {
		const raw = vis as { kind?: string; path?: string } | undefined;
		switch (raw?.kind) {
			case 'Public':
				return 'pub ';
			case 'Crate':
				return 'pub(crate) ';
			case 'Restricted':
				return `pub(in ${raw.path ?? 'crate'}) `;
			default:
				return '';
		}
	}

	/** Render struct/union fields as a clean Rust source block (docs.rs style). */
	function fieldToRust(field: { name: string; type: TypeRef; visibility: Visibility }): string {
		return /^\d+$/.test(field.name)
			? `${fieldVisPrefix(field.visibility)}${renderTypeText(field.type)}`
			: `${fieldVisPrefix(field.visibility)}${field.name}: ${renderTypeText(field.type)}`;
	}

	/** Render one enum variant as Rust source for its documented row. */
	function variantToRust(variant: {
		name: string;
		fields: { name: string; type: TypeRef; visibility: Visibility }[];
	}): string {
		if (variant.fields.length === 0) return variant.name;
		if (isTupleVariant(variant.fields)) {
			const types = variant.fields.map((field) => fieldToRust(field)).join(', ');
			return `${variant.name}(${types})`;
		}
		const body = variant.fields
			.map(
				(field) =>
					`${fieldVisPrefix(field.visibility)}${field.name}: ${renderTypeText(field.type)},`,
			)
			.join('\n    ');
		return `${variant.name} {\n    ${body}\n}`;
	}

	function childNode(name: string): Node | undefined {
		return selected ? nodeMeta?.(`${selected.id}::${name}`) : undefined;
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
		<span class="text-(--muted)">dyn</span>
		{#each t.traits as poly, i (i)}
			{#if i > 0}<span class="text-(--muted)">+</span>{/if}
			{@render typeContent(poly.trait)}
		{/each}
		{#if t.lifetime}<span class="text-(--muted)">+ {t.lifetime}</span>{/if}
	{:else if t.kind === 'Generic'}
		<span class="token-name">{t.name}</span>
	{:else if t.kind === 'Primitive'}
		<span class="token-name">{t.name}</span>
	{:else if t.kind === 'BorrowedRef'}
		<span class="text-(--muted)">
			&{t.lifetime ? `${t.lifetime} ` : ''}{t.mutable ? 'mut ' : ''}
		</span>
		{@render typeContent(t.inner)}
	{:else if t.kind === 'Tuple'}
		<span class="text-(--muted)">(</span>
		{#each t.elements as el, i (i)}
			{#if i > 0}<span class="text-(--muted)">,</span>{/if}
			{@render typeContent(el)}
		{/each}{#if t.elements.length === 1}<span class="text-(--muted)">,</span>{/if}
		<span class="text-(--muted)">)</span>
	{:else if t.kind === 'Slice'}
		<span class="text-(--muted)">[</span>
		{@render typeContent(t.element)}
		<span class="text-(--muted)">]</span>
	{:else if t.kind === 'Array'}
		<span class="text-(--muted)">[</span>
		{@render typeContent(t.element)}
		<span class="text-(--muted)">; {t.len}]</span>
	{:else if t.kind === 'ImplTrait'}
		<span class="text-(--muted)">impl</span>
		{#each t.bounds as b, i (i)}
			{#if i > 0}<span class="text-(--muted)">+</span>{/if}
			{@render boundContent(b)}
		{/each}
	{:else if t.kind === 'RawPointer'}
		<span class="text-(--muted)">*{t.mutable ? 'mut ' : 'const '}</span>
		{@render typeContent(t.inner)}
	{:else if t.kind === 'QualifiedPath'}
		<span class="text-(--muted)">&lt;</span>
		{@render typeContent(t.self_type)}{#if t.trait}<span class="text-(--muted)">as</span>
			{@render typeContent(t.trait)}{/if}
		<span class="text-(--muted)">&gt;::</span>
		<span class="token-name">{t.name}</span>
		{#if t.args}{@render genericArgs(t.args)}{/if}
	{:else if t.kind === 'FunctionPointer'}
		<span class="text-(--muted)">fn(</span>
		{#each t.sig.inputs as inp, i (i)}
			{#if i > 0}<span class="text-(--muted)">,</span>{/if}
			{#if inp.name}<span class="token-name">{inp.name}</span>
				<span class="text-(--muted)">:</span>{/if}
			{@render typeContent(inp.type)}
		{/each}
		<span class="text-(--muted)">)</span>
		{#if t.sig.output}<span class="text-(--muted)">-&gt;</span>
			{@render typeContent(t.sig.output)}{/if}
	{:else if t.kind === 'Infer'}
		<span class="token-name">_</span>
	{:else if t.kind === 'Pat'}
		{@render typeContent(t.base)}
		<span class="text-(--muted)">is {t.pat}</span>
	{/if}
{/snippet}

{#snippet genericArgs(args: import('$lib/schema').GenericArgs)}
	{#if args.kind === 'AngleBracketed'}
		{@const allParts: number = args.args.length + (args.constraints?.length ?? 0)}
		{#if allParts > 0}
			<Icon name="chevron-left" class="generic-bracket" size={14} strokeWidth={2.5} />
			{#each args.args as arg, i (i)}
				{#if i > 0}<span class="generic-sep">,</span>{/if}
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
					{#if args.args.length > 0 || i > 0}<span class="generic-sep">,</span>{/if}
					<span class="token-name">{c.name}</span>
					{#if c.binding.kind === 'Equality'}
						<span class="text-(--muted)">=</span>
						{#if c.binding.value.kind === 'Type'}{@render typeContent(
								c.binding.value.value,
							)}{:else}<span class="token-name">{c.binding.value.expr}</span>{/if}
					{:else}
						<span class="text-(--muted)">:</span>
						{#each c.binding.bounds as b, j (j)}
							{#if j > 0}<span class="text-(--muted)">+</span>{/if}
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
			{#if i > 0}<span class="text-(--muted)">,</span>{/if}
			{@render typeContent(inp)}
		{/each}
		<span class="text-(--muted)">)</span>
		{#if args.output}<span class="text-(--muted)">-&gt;</span>
			{@render typeContent(args.output)}{/if}
	{/if}
{/snippet}

{#snippet boundContent(b: GenericBound)}
	{#if b.kind === 'Trait'}
		{#if b.modifier === 'maybe'}<span class="text-(--muted)">?</span>{/if}
		{#if b.modifier === 'maybe_const'}<span class="text-(--muted)">~const</span>{/if}
		{@render typeContent(b.trait)}
	{:else if b.kind === 'Outlives'}
		<span class="token-name">{b.lifetime}</span>
	{:else if b.kind === 'Use'}
		<span class="text-(--muted)">use&lt;</span>
		{#each b.captures as c, i (i)}{#if i > 0}<span class="text-(--muted)">,</span>{/if}
			<span class="token-name">{c.name}</span>{/each}
		<span class="text-(--muted)">&gt;</span>
	{/if}
{/snippet}

{#snippet genericParamContent(p: GenericParam)}
		{#if p.kind.kind === 'Const'}<span class="text-(--muted)">const</span>{/if}
		<span class="token-name">{p.name}</span>
		{#if p.kind.kind === 'Type' && p.kind.bounds && p.kind.bounds.length > 0}
			<span class="text-(--muted)">:</span>
			{#each p.kind.bounds as b, i (i)}
				{#if i > 0}<span class="text-(--muted)">+</span>{/if}
				{@render boundContent(b)}
			{/each}
		{/if}
		{#if p.kind.kind === 'Lifetime' && p.kind.outlives && p.kind.outlives.length > 0}
			<span class="text-(--muted)">:</span>
			{#each p.kind.outlives as lt, i (i)}{#if i > 0}<span class="text-(--muted)">+</span>{/if}
				<span class="token-name">{lt}</span>{/each}
		{/if}
		{#if p.kind.kind === 'Const'}
			<span class="text-(--muted)">:</span>
			{@render typeContent(p.kind.type)}
			{#if p.kind.default}<span class="text-(--muted)">= {p.kind.default}</span>{/if}
		{/if}
		{#if p.kind.kind === 'Type' && p.kind.default}
			<span class="text-(--muted)">=</span>
			{@render typeContent(p.kind.default)}
		{/if}
{/snippet}

{#snippet wherePredContent(pred: WherePredicate)}
		{#if pred.kind === 'Bound'}
			{@render typeContent(pred.type)}
			<span class="text-(--muted)">:</span>
			{#each pred.bounds as b, i (i)}{#if i > 0}<span class="text-(--muted)">
						+
					</span>{/if}{@render boundContent(b)}{/each}
		{:else if pred.kind === 'Lifetime'}
			<span class="token-name">{pred.lifetime}</span>
			<span class="text-(--muted)">:</span>
			{#each pred.outlives as lt, i (i)}{#if i > 0}<span class="text-(--muted)">+</span>{/if}
				<span class="token-name">{lt}</span>{/each}
		{:else if pred.kind === 'Eq'}
			{@render typeContent(pred.lhs)}
			<span class="text-(--muted)">=</span>
			{#if pred.rhs.kind === 'Type'}{@render typeContent(pred.rhs.value)}{:else}<span
					class="token-name"
				>
					{pred.rhs.expr}
				</span>{/if}
		{/if}
{/snippet}

<!-- Badge wrapping a TypeRef — used by argument types, return types,
	 field types, where any single type expression needs a styled chip. -->
{#snippet typeBadge(t: TypeRef, strong: boolean)}
	<code class="badge {strong ? 'badge-strong' : ''} badge-code">{@render typeContent(t)}</code>
{/snippet}

{#snippet traitLink(traitId: string)}
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
{/snippet}

{#snippet implRow(implBlock: Node)}
	{@const implGenerics = implBlock.generics?.params ?? []}
	{@const implWhere = implBlock.generics?.where_predicates ?? []}
	<div class="min-w-0 [contain-intrinsic-size:auto_28px] [content-visibility:auto]">
		<code class="font-(--font-code) text-[13px] leading-6 text-(--ink)">
			<span class="token-keyword">impl</span>{#if implBlock.impl_category === 'Negative'}<span
					class="text-(--danger)"
				>!</span
			>{/if}{#if implGenerics.length > 0}<span class="text-(--muted)">&lt;</span>{#each implGenerics as p, i (i)}{#if i > 0}<span
						class="text-(--muted)"
						>, </span
					>{/if}{@render genericParamContent(p)}{/each}<span class="text-(--muted)"
					>&gt;</span
				>{/if}{#if implBlock.impl_trait}
				{@render traitLink(implBlock.impl_trait)}
				<span class="token-keyword"> for </span>
				<span class="token-name">{selected?.name}</span>
			{/if}
		</code>
		{#if implWhere.length > 0}
			<div class="pl-4 font-(--font-code) text-[12px] leading-5 text-(--ink-soft)">
				<span class="token-keyword">where</span>
				{#each implWhere as pred, i (i)}
					<span class="ml-2">{@render wherePredContent(pred)}{i + 1 < implWhere.length ? ',' : ''}</span>
				{/each}
			</div>
		{/if}
	</div>
{/snippet}

{#snippet implMemberRow(member: Node, index: number)}
	<div
		class={`bg-(--panel-solid) px-3 py-3 [contain-intrinsic-size:auto_92px] [content-visibility:auto] ${index ? 'border-t border-(--panel-border)' : ''}`}
	>
		{#if !member.signature || member.span}
			<div class="mb-2 flex flex-wrap items-baseline justify-between gap-2">
				<div class="flex min-w-0 items-center gap-2">
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
		{/if}
		{#if member.signature}
			<SignatureBlock node={member} {theme} variant="flat" />
		{:else if member.type}
			<div class="flex flex-wrap items-baseline gap-2 text-sm font-(--font-code)">
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
		{#if member.deprecation}
			<p class="mt-2 text-sm text-(--danger)">
				Deprecated{member.deprecation.since ? ` since ${member.deprecation.since}` : ''}{member
					.deprecation.note
					? `: ${member.deprecation.note}`
					: ''}
			</p>
		{/if}
		{#if member.docs}
			<div class="mt-2 text-sm text-(--muted)">
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
		<!-- Header — kind label + h1 + source link. The qualified path is
		     shown once, in the breadcrumb sub-nav, so we don't repeat it
		     here (the old header listed the path three times). -->
		<div class="doc-title-header mb-5">
			<div class="flex flex-wrap items-baseline gap-3">
				<span
					class="kind-label"
					style="color: {kindColors[selectedKind]}"
					aria-label={kindLabels[selected.kind]}
				>
					<span class="kind-label-bar" style="background: {kindColors[selectedKind]}"></span>
					{kindLabels[selected.kind]}
				</span>
				<h1
					class="doc-item-title font-display min-w-0 text-[28px] leading-tight font-semibold tracking-tight break-words text-(--ink) sm:text-[32px] {selected.is_deprecated
						? 'line-through opacity-80'
						: ''}"
				>
					{selected.name}
				</h1>
				{#if !selectedIsPublic}
					<span class="badge badge-sm">{selectedVisibilityLabel}</span>
				{/if}
				{#if selected.is_deprecated}
					<span class="badge badge-sm border-(--danger-border) bg-(--danger-bg) text-(--danger)">
						Deprecated
					</span>
				{/if}
				<div class="doc-title-actions ml-auto flex items-center gap-1">
					{#if selected?.span?.file}
						<span class="source-pill-wrap" title="View source">
							<Icon name="file-code" size={13} strokeWidth={2} />
							<SourceViewer
								span={selected.span}
								{theme}
								crateName={crateFromId(selected.id) ?? crateName}
								crateVersion={resolveVersionForCrate(selected.id)}
							/>
						</span>
					{/if}
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
		</div>

		<!-- Below-title slot: kept for embedding; the relationship graph
		     no longer renders inline (redundant with the tree sidebar and
		     a major performance cost on cold render). -->
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

		<!-- Attributes are source syntax and belong immediately before the
		     declaration they annotate. -->
		{#if selected.attrs && selected.attrs.length > 0}
			<div class="mb-1 font-(--font-code) text-[13px] leading-5">
				{#each selected.attrs as attr (attr)}
					<code class="token-meta block">{attr}</code>
				{/each}
			</div>
		{/if}

		<!-- Declaration block — single canonical Rust signature. Replaces the
		     old "Signature" collapsible + separate generics/where badge rows,
		     which duplicated the same information. Rendered for every kind
		     that has a meaningful declaration (fn / struct / enum / trait …). -->
		{#if itemDeclaration}
			<div class="declaration-block mb-5">
				{#if selected.signature}
					<SignatureBlock node={selected} {theme} />
				{:else}
					<CodeBlock code={itemDeclaration.multiline} lang="rust" {theme} variant="flat" />
				{/if}
			</div>
		{/if}

		<!-- Fields (collapse if many) — rendered as a clean Rust source block
		     the way docs.rs / cargo doc does, instead of a noisy table. -->
		{#if selected.fields && selected.fields.length > 0}
			<section id="fields" class="doc-section group">
				<div
					class="section-header mt-7 mb-3 flex items-baseline gap-3 border-b border-(--panel-border-soft) pb-2"
				>
					<span class="section-bar" style="background: {kindColors.StructField}"></span>
					<h2
						class="font-display text-[20px] leading-tight font-semibold tracking-tight text-(--ink)"
					>
						Fields
					</h2>
					<span class="font-mono text-[11px] text-(--muted-soft) tabular-nums">
						{selected.fields.length}
					</span>
				</div>
				<div
					class="corner-squircle divide-y divide-(--panel-border) overflow-hidden rounded-(--radius-card) border border-(--panel-border) bg-(--panel-solid)"
				>
					{#each selected.fields as field (field.name)}
						{@const fieldNode = childNode(field.name)}
						<article class="px-3 py-3 [contain-intrinsic-size:auto_72px] [content-visibility:auto]">
							<div
								class="overflow-hidden rounded-(--radius-control) border border-(--panel-border-soft)"
							>
								<CodeBlock code={fieldToRust(field)} lang="rust" {theme} variant="flat" />
							</div>
							{#if fieldNode?.docs}
								<div class="mt-3 text-sm text-(--muted)">
									<Documentation
										docs={fieldNode.docs}
										defaultLang="rust"
										{theme}
										docLinks={fieldNode.doc_links ?? {}}
										{getNodeUrl}
										{nodeExists}
									/>
								</div>
							{/if}
						</article>
					{/each}
				</div>
			</section>
		{/if}

		<!-- Variants (collapse if many) — clean Rust source block. -->
		{#if selected.variants && selected.variants.length > 0}
			<section id="variants" class="doc-section group">
				<div
					class="section-header mt-7 mb-3 flex items-baseline gap-3 border-b border-(--panel-border-soft) pb-2"
				>
					<span class="section-bar" style="background: {kindColors.Variant}"></span>
					<h2
						class="font-display text-[20px] leading-tight font-semibold tracking-tight text-(--ink)"
					>
						Variants
					</h2>
					<span class="font-mono text-[11px] text-(--muted-soft) tabular-nums">
						{selected.variants.length}
					</span>
				</div>
				<div
					class="corner-squircle divide-y divide-(--panel-border) overflow-hidden rounded-(--radius-card) border border-(--panel-border) bg-(--panel-solid)"
				>
					{#each selected.variants as variant (variant.name)}
						{@const variantNode = childNode(variant.name)}
						<article class="px-3 py-3 [contain-intrinsic-size:auto_88px] [content-visibility:auto]">
							<div
								class="overflow-hidden rounded-(--radius-control) border border-(--panel-border-soft)"
							>
								<CodeBlock
									code={`${variantToRust(variant)}${variantNode?.discriminant ? ` = ${variantNode.discriminant}` : ''}`}
									lang="rust"
									{theme}
									variant="flat"
								/>
							</div>
							{#if variantNode?.docs}
								<div class="mt-3 text-sm text-(--muted)">
									<Documentation
										docs={variantNode.docs}
										defaultLang="rust"
										{theme}
										docLinks={variantNode.doc_links ?? {}}
										{getNodeUrl}
										{nodeExists}
									/>
								</div>
							{/if}
						</article>
					{/each}
				</div>
			</section>
		{/if}

		<!-- Type info for StructField only — every other kind now gets a
		     declaration block at the top that already includes the type. -->
		{#if selected.type && selectedKind === 'StructField'}
			<CollapsibleSection
				title="Type"
				defaultOpen={true}
				forceOpen={sectionForceOpen}
				forceToken={sectionForceToken}
			>
				<div class="flex flex-wrap items-baseline gap-2">
					<code class="badge badge-strong badge-code">{selected.name}</code>
					<span class="text-(--muted)">:</span>
					{@render typeBadge(selected.type, false)}
				</div>
			</CollapsibleSection>
		{/if}

		<!-- Bounds are now rendered inside the declaration block; no
		     separate section needed. -->

		<!-- Variant info -->
		{#if selectedKind === 'Variant'}
			<CollapsibleSection
				title="Variant Type"
				defaultOpen={true}
				forceOpen={sectionForceOpen}
				forceToken={sectionForceToken}
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
					class="section-header mt-9 mb-4 flex items-baseline gap-3 border-b border-(--panel-border-soft) pb-2"
				>
					<span class="section-bar section-bar-muted"></span>
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

		{#if (selectedKind === 'Crate' || selectedKind === 'Module') && directItemGroups.length > 0}
			<section id="items" class="doc-section group">
				<div
					class="section-header mt-9 mb-4 flex items-baseline gap-3 border-b border-(--panel-border-soft) pb-2"
				>
					<span class="section-bar" style="background: {kindColors.Module}"></span>
					<h2
						class="font-display text-[22px] leading-tight font-semibold tracking-tight text-(--ink)"
					>
						{selectedKind === 'Crate' ? 'Public API' : 'Items'}
					</h2>
					<span class="font-mono text-[11px] text-(--muted-soft) tabular-nums">
						{directItems.length}
					</span>
				</div>
				<div class="space-y-7">
					{#each directItemGroups as group (group.kind)}
						<section aria-labelledby={`items-${group.kind}`}>
							<div class="mb-2 flex items-center gap-2">
								<span
									class="size-2 shrink-0 rounded-sm"
									style={`background: ${kindColors[group.kind]}`}
								></span>
								<h3 id={`items-${group.kind}`} class="text-sm font-semibold text-(--ink)">
									{group.label}
								</h3>
								<span class="font-mono text-[10px] text-(--muted-soft)">{group.items.length}</span>
							</div>
							<div
								class="divide-y divide-(--panel-border-soft) border-y border-(--panel-border-soft)"
							>
								{#each group.items as item (item.id)}
									{@const summary = docsSummary(item.docs)}
									<div
										class="crate-item-row grid min-w-0 gap-1 py-2.5 sm:grid-cols-[minmax(8rem,0.38fr)_minmax(0,1fr)] sm:gap-4"
									>
										<a
											href={nodeHref(item.id)}
											data-sveltekit-noscroll
											class="min-w-0 self-start font-mono text-[13px] font-semibold text-(--accent) underline-offset-2 hover:underline"
										>
											<span class="break-words">{item.name}</span>
										</a>
										{#if summary}
											<div
												class="crate-item-summary min-w-0 text-[13px] leading-relaxed text-(--muted)"
											>
												<!-- eslint-disable-next-line svelte/no-at-html-tags -- markdown renderer escapes raw HTML -->
												{@html summary}
											</div>
										{:else}
											<span class="text-[12px] text-(--muted-soft)">
												No documentation provided.
											</span>
										{/if}
									</div>
								{/each}
							</div>
						</section>
					{/each}
				</div>
			</section>
		{/if}

		<!-- Trait definition: associated types/consts, required methods, provided methods.
		     Uses the same member-row rendering as trait-impl blocks so signatures + docs
		     show with their own body (docs.rs style). -->
		{#if traitAssocItems.length > 0}
			<section id="associated-items" class="doc-section group">
				<div
					class="section-header mt-9 mb-4 flex items-baseline gap-3 border-b border-(--panel-border-soft) pb-2"
				>
					<span class="section-bar" style="background: {kindColors.AssocType}"></span>
					<h2
						class="font-display text-[22px] leading-tight font-semibold tracking-tight text-(--ink)"
					>
						Associated items
					</h2>
					<span class="font-mono text-[11px] text-(--muted-soft) tabular-nums">
						{traitAssocItems.length}
					</span>
				</div>
				<div
					class="corner-squircle overflow-hidden rounded-(--radius-card) border border-(--panel-border) bg-(--panel)"
				>
					{#each traitAssocItems as member, index (member.id)}
						{@render implMemberRow(member, index)}
					{/each}
				</div>
			</section>
		{/if}

		{#if requiredTraitMethods.length > 0}
			<section id="required-methods" class="doc-section group">
				<div
					class="section-header mt-9 mb-4 flex items-baseline gap-3 border-b border-(--panel-border-soft) pb-2"
				>
					<span class="section-bar" style="background: {kindColors.Function}"></span>
					<h2
						class="font-display text-[22px] leading-tight font-semibold tracking-tight text-(--ink)"
					>
						Required methods
					</h2>
					<span class="font-mono text-[11px] text-(--muted-soft) tabular-nums">
						{requiredTraitMethods.length}
					</span>
				</div>
				<div
					class="corner-squircle overflow-hidden rounded-(--radius-card) border border-(--panel-border) bg-(--panel)"
				>
					{#each requiredTraitMethods as member, index (member.id)}
						{@render implMemberRow(member, index)}
					{/each}
				</div>
			</section>
		{/if}

		{#if providedTraitMethods.length > 0}
			<section id="provided-methods" class="doc-section group">
				<div
					class="section-header mt-9 mb-4 flex items-baseline gap-3 border-b border-(--panel-border-soft) pb-2"
				>
					<span class="section-bar" style="background: {kindColors.Function}"></span>
					<h2
						class="font-display text-[22px] leading-tight font-semibold tracking-tight text-(--ink)"
					>
						Provided methods
					</h2>
					<span class="font-mono text-[11px] text-(--muted-soft) tabular-nums">
						{providedTraitMethods.length}
					</span>
				</div>
				<div
					class="corner-squircle overflow-hidden rounded-(--radius-card) border border-(--panel-border) bg-(--panel)"
				>
					{#each providedTraitMethods as member, index (member.id)}
						{@render implMemberRow(member, index)}
					{/each}
				</div>
			</section>
		{/if}

		<!-- Methods -->
		{#if methodCountValue() > 0}
			<section id="methods" class="doc-section group">
				<div
					class="section-header mt-9 mb-4 flex items-baseline gap-3 border-b border-(--panel-border-soft) pb-2"
				>
					<span class="section-bar" style="background: {kindColors.Function}"></span>
					<h2
						class="font-display text-[22px] leading-tight font-semibold tracking-tight text-(--ink)"
					>
						Methods
					</h2>
					<span class="font-mono text-[11px] text-(--muted-soft) tabular-nums">
						{methodCountValue()}
					</span>
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
					class="section-header mt-9 mb-4 flex items-baseline gap-3 border-b border-(--panel-border-soft) pb-2"
				>
					<span class="section-bar" style="background: {kindColors.Trait}"></span>
					<h2
						class="font-display text-[22px] leading-tight font-semibold tracking-tight text-(--ink)"
					>
						Trait implementations
					</h2>
					<span class="font-mono text-[11px] text-(--muted-soft) tabular-nums">
						{sourceImpls.length}
					</span>
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

		<!-- Implementers — shown only on trait / trait-alias pages. The
		     reviewer's suggestion: replace generic "incoming relationships"
		     with a focused list of types that implement this trait. -->
		{#if (selectedKind === 'Trait' || selectedKind === 'TraitAlias') && implementers.length > 0}
			<section id="implementers" class="doc-section group">
				<div
					class="section-header mt-9 mb-4 flex items-baseline gap-3 border-b border-(--panel-border-soft) pb-2"
				>
					<span class="section-bar" style="background: {kindColors.Struct}"></span>
					<h2
						class="font-display text-[22px] leading-tight font-semibold tracking-tight text-(--ink)"
					>
						Implementers
					</h2>
					<span class="font-mono text-[11px] text-(--muted-soft) tabular-nums">
						{implementers.length}
					</span>
				</div>
				<ul class="flex flex-wrap gap-x-5 gap-y-1.5 font-mono text-sm">
					{#each implementers as impl (impl.id)}
						<li>
							{#if hasInternalNode(impl.id)}
								<a
									href={nodeHref(impl.id)}
									data-sveltekit-noscroll
									class="text-(--accent) underline-offset-2 hover:underline"
									title={impl.id}
								>
									{impl.name}
								</a>
							{:else}
								<span class="text-(--ink-soft)" title={impl.id}>{impl.name}</span>
							{/if}
						</li>
					{/each}
				</ul>
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
			z-index: 10;
			margin-inline: -0.25rem;
			padding: 0.85rem 0.25rem 0.75rem;
			border-bottom: 1px solid var(--panel-border-soft);
			background: var(--bg);
		}
	}

	@media (max-width: 479.98px) {
		.doc-title-actions {
			width: 100%;
			margin-left: 0;
			justify-content: flex-end;
		}
	}

	/* Kind label with a colored leading bar — gives module/type/trait
	   separation at a glance without icon clutter. */
	.kind-label {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		font-family: var(--font-code);
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.16em;
		text-transform: uppercase;
	}
	.kind-label-bar {
		display: inline-block;
		width: 3px;
		height: 13px;
		border-radius: 2px;
		flex-shrink: 0;
	}

	/* Source pill — prominent but quiet link to the source location.
	   Wraps SourceViewer so it gets the real source dialog + docs.rs
	   fallback; we just add an icon + pill chrome around it. */
	.source-pill-wrap {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.12rem 0.5rem;
		border-radius: var(--radius-control, 6px);
		font-size: 11.5px;
		color: var(--ink-soft);
		background: var(--panel);
		border: 1px solid var(--panel-border-soft);
		transition:
			color 0.12s,
			border-color 0.12s,
			background 0.12s;
		min-width: 0;
		max-width: 100%;
		flex: 1 1 7rem;
		overflow: hidden;
	}
	.source-pill-wrap:hover {
		color: var(--accent);
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	.source-pill-wrap :global(.source-link) {
		display: flex;
		width: 100%;
		min-width: 0;
		overflow: hidden;
		color: inherit;
		font-size: inherit;
	}
	.source-pill-wrap :global(.source-link .token-name) {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.source-pill-wrap :global(.source-link .token-meta) {
		flex-shrink: 0;
	}
	.source-pill-wrap :global(.source-link:hover) {
		color: inherit;
	}

	/* Section header colored bar — unifies the "module/type/trait" colour
	   language across the whole detail page. */
	.section-bar {
		display: inline-block;
		width: 3px;
		height: 18px;
		border-radius: 2px;
		background: var(--muted-soft);
		flex-shrink: 0;
	}
	.section-bar-muted {
		background: var(--muted-soft);
	}

	/* Declaration block — sits flush with the header, no card chrome so
	   the rust source reads as source, not as a UI widget. */
	.declaration-block {
		border-radius: var(--radius-card, 10px);
		overflow: hidden;
	}

	.crate-item-summary {
		display: -webkit-box;
		overflow: hidden;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
	}
	.crate-item-summary :global(p) {
		margin: 0;
	}
	.crate-item-summary :global(code) {
		font-family: var(--font-code);
		font-size: 0.9em;
	}
</style>
