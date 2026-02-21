<script lang="ts">
	import type { Edge, EdgeKind, Node, NodeKind, Visibility } from '$lib/graph';

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
	import SourceViewer from './SourceViewer.svelte';
	import { tooltip } from '$lib/tooltip';
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
		visibilityLabels,
		edgeLabels,
		displayNode,
		theme = 'light',
		getNodeUrl,
		nodeExists,
		nodeMeta,
		crateName,
		crateVersion,
		crateVersions,
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
	function splitBoundSegments(
		text: string,
		links: Record<string, string> | undefined,
	): BoundSegment[] {
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

	type TypeToken =
		| { kind: 'text'; text: string }
		| { kind: 'open'; depth: number }
		| { kind: 'close'; depth: number }
		| { kind: 'comma' };

	/**
	 * Tokenize a type string into segments: bare text, angle-bracket openers/closers, and commas.
	 * e.g. "HashMap<String, Vec<u8>>" →
	 *   [{kind:'text',text:'HashMap'}, {kind:'open',depth:0}, {kind:'text',text:'String'},
	 *    {kind:'comma'}, {kind:'text',text:' Vec'}, {kind:'open',depth:1}, {kind:'text',text:'u8'},
	 *    {kind:'close',depth:1}, {kind:'close',depth:0}]
	 */
	function tokenizeType(text: string): TypeToken[] {
		const tokens: TypeToken[] = [];
		let depth = 0;
		let buf = '';
		for (let i = 0; i < text.length; i++) {
			const ch = text[i];
			if (ch === '<') {
				if (buf) {
					tokens.push({ kind: 'text', text: buf });
					buf = '';
				}
				tokens.push({ kind: 'open', depth });
				depth++;
			} else if (ch === '>') {
				if (buf) {
					tokens.push({ kind: 'text', text: buf });
					buf = '';
				}
				depth = Math.max(0, depth - 1);
				tokens.push({ kind: 'close', depth });
			} else if (ch === ',' && depth > 0) {
				if (buf) {
					tokens.push({ kind: 'text', text: buf });
					buf = '';
				}
				tokens.push({ kind: 'comma' });
			} else {
				buf += ch;
			}
		}
		if (buf) tokens.push({ kind: 'text', text: buf });
		return tokens;
	}

	function hasGenerics(text: string): boolean {
		return text.includes('<') && text.includes('>');
	}

	type AnnotatedToken = {
		text: string;
		/** Right border shaped as < (opens a generic) */
		openerDepth: number | null;
		/** Right borders shaped as > (closes generics — multiple for nested types like `Vec<Self>>`) */
		closerDepths: number[];
	};

	function annotateGenericTokens(tokens: TypeToken[]): (AnnotatedToken | { kind: 'comma' })[] {
		const result: (AnnotatedToken | { kind: 'comma' })[] = [];
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			if (token.kind === 'comma') {
				result.push({ kind: 'comma' });
				continue;
			}
			if (token.kind !== 'text' || !token.text.trim()) continue;

			const next = tokens[i + 1];

			// Collect ALL consecutive close brackets after this text token
			const closerDepths: number[] = [];
			if (next?.kind === 'close') {
				let j = i + 1;
				while (j < tokens.length && tokens[j].kind === 'close') {
					closerDepths.push((tokens[j] as { kind: 'close'; depth: number }).depth);
					j++;
				}
			}

			result.push({
				text: token.text.trim(),
				openerDepth: next?.kind === 'open' ? next.depth : null,
				closerDepths,
			});
		}
		return result;
	}

	// Track collapsible section refs for expand/collapse all
	let signatureRef = $state<CollapsibleSection | null>(null);
	let fieldsRef = $state<CollapsibleSection | null>(null);
	let variantsRef = $state<CollapsibleSection | null>(null);
	let typeInfoRef = $state<CollapsibleSection | null>(null);
	let boundsRef = $state<CollapsibleSection | null>(null);
	let variantTypeRef = $state<CollapsibleSection | null>(null);
	let docsRef = $state<CollapsibleSection | null>(null);
	let methodsRef = $state<CollapsibleSection | null>(null);
	let implsRef = $state<CollapsibleSection | null>(null);
	let relationshipsRef = $state<CollapsibleSection | null>(null);
	let attrsRef = $state<CollapsibleSection | null>(null);

	let allRefs = $derived(
		[
			signatureRef,
			fieldsRef,
			variantsRef,
			typeInfoRef,
			boundsRef,
			variantTypeRef,
			docsRef,
			methodsRef,
			implsRef,
			relationshipsRef,
			attrsRef,
		].filter(Boolean) as CollapsibleSection[],
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

	function isTupleVariant(fields: { name: string }[]): boolean {
		return fields.length > 0 && fields.every((f) => /^\d+$/.test(f.name));
	}

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

{#snippet segmentLinks(segs: BoundSegment[])}
	{#each segs as seg, index (index)}
		{#if seg.nodeId && getNodeUrl}
			{#if isExternalNode(seg.nodeId)}
				<a
					href={resolve(getNodeUrl(seg.nodeId))}
					data-sveltekit-noscroll
					onclick={externalLinkHandler(seg.nodeId)}
					class="text-(--accent) underline-offset-2 hover:underline"
					title="External dependency"
				>
					{seg.text}
				</a>
			{:else}
				<a
					href={resolve(getNodeUrl(seg.nodeId))}
					data-sveltekit-noscroll
					class="text-(--accent) underline-offset-2 hover:underline"
				>
					{seg.text}
				</a>
			{/if}
		{:else}
			{seg.text}
		{/if}
	{/each}
{/snippet}

{#snippet linkedBadge(text: string, links: Record<string, string> | undefined, strong: boolean)}
	{#if hasGenerics(text)}
		<span class="generic-group">
			{#each annotateGenericTokens(tokenizeType(text)) as token, i (i)}
				{#if 'kind' in token}
					<span class="generic-sep">,</span>
				{:else}
					<code class="badge {strong ? 'badge-strong' : ''} badge-code">
						{@render segmentLinks(splitBoundSegments(token.text, links))}
					</code>
					{#if token.openerDepth !== null}
						<ChevronLeftIcon
							class="generic-bracket"
							size={14}
							strokeWidth={2.5}
							color="var(--bracket-depth-{token.openerDepth % 3})"
						/>
					{/if}
					{#each token.closerDepths as depth}
						<ChevronRightIcon
							class="generic-bracket"
							size={14}
							strokeWidth={2.5}
							color="var(--bracket-depth-{depth % 3})"
						/>
					{/each}
				{/if}
			{/each}
		</span>
	{:else}
		<code class="badge {strong ? 'badge-strong' : ''} badge-code">
			{@render segmentLinks(splitBoundSegments(text, links))}
		</code>
	{/if}
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
	<div
		class="flex flex-wrap items-center gap-2 text-sm [contain-intrinsic-size:auto_28px] [content-visibility:auto]"
	>
		<span class="badge">impl</span>
		{#if implBlock.generics && implBlock.generics.length > 0}
			{#each implBlock.generics as generic (generic)}
				{@render linkedBadge(generic, implBlock.bound_links, true)}
			{/each}
		{/if}
		{#if implBlock.impl_trait}
			{@render traitLink(implBlock.impl_trait)}
			<span class="text-(--muted)">for</span>
			<span class="token-name">{selected?.name}</span>
		{:else}
			{@const stripped = implBlock.name.replace(/^impl\s+/, '')}
			{#if stripped.includes(' for ')}
				{@const traitPart = stripped.slice(0, stripped.lastIndexOf(' for '))}
				{@render linkedBadge(traitPart, implBlock.bound_links, true)}
				<span class="text-(--muted)">for</span>
				<span class="token-name">{selected?.name}</span>
			{:else}
				{@render linkedBadge(stripped, implBlock.bound_links, true)}
			{/if}
		{/if}
		{#if implBlock.where_clause && implBlock.where_clause.length > 0}
			<span class="text-xs font-semibold tracking-wider text-(--muted) uppercase">where</span>
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
						class="badge badge-sm inline-flex items-center gap-1 transition-colors hover:bg-(--panel-strong) hover:text-(--ink)"
						onclick={expandAll}
					>
						<ChevronsUpDown size={12} />
						Expand all
					</button>
					<span class="text-(--muted)">|</span>
					<button
						type="button"
						class="badge badge-sm inline-flex items-center gap-1 transition-colors hover:bg-(--panel-strong) hover:text-(--ink)"
						onclick={collapseAll}
					>
						<ChevronsDownUp size={12} />
						Collapse all
					</button>
				</div>
			</div>
			<h2 class="mt-3 text-2xl font-bold text-(--ink)">{selected.name}</h2>
			<p class="mt-1 text-sm font-(--font-code) text-(--muted)">{selected.id}</p>
			{#if selected?.span}
				<div class="mt-2 text-xs">
					<SourceViewer
						span={selected?.span ?? { file: '', line: 0 }}
						{theme}
						crateName={crateFromId(selected?.id) ?? crateName}
						crateVersion={resolveVersionForCrate(selected?.id)}
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
					<span class="text-xs font-semibold tracking-wider text-(--muted) uppercase">where</span>
					{#each selected.where_clause as predicate (predicate)}
						{@render linkedBadge(predicate, selected.bound_links, false)}
					{/each}
				</div>
			{/if}
		</div>

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
					<CodeBlock code={formatSignature(selected) ?? ''} lang="rust" {theme} />
				</div>
				{#if selected.signature.inputs.length > 0}
					<div class="mt-4">
						<h4 class="text-xs font-semibold tracking-wider text-(--muted) uppercase">Arguments</h4>
						<div class="mt-2 space-y-2">
							{#each selected.signature.inputs as arg (arg.name)}
								<div class="flex flex-wrap items-baseline gap-2">
									<code class="badge badge-strong badge-code">{arg.name}</code>
									<span class="text-(--muted)">:</span>
									{@render linkedBadge(arg.type_name, selected.bound_links, false)}
								</div>
							{/each}
						</div>
					</div>
				{/if}
				{#if selected.signature.output}
					<div class="mt-4">
						<h4 class="text-xs font-semibold tracking-wider text-(--muted) uppercase">Returns</h4>
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
										{#if field.visibility === 'Public'}
											<span class="text-[10px] font-medium text-(--accent)">pub</span>
										{:else}
											<span class="text-[10px] font-medium text-(--muted)">prv</span>
										{/if}
										<code class="font-(--font-code) font-medium text-(--ink)">{field.name}</code>
									</span>
								</td>
								<td class="py-2 align-baseline">
									{@render linkedBadge(field.type_name, selected.bound_links, false)}
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
											{/if}{@render linkedBadge(
												field.type_name,
												selected.bound_links,
												false,
											)}{/each})
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
												{@render linkedBadge(field.type_name, selected.bound_links, false)}
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
		{#if selected.type_name && (selectedKind === 'StructField' || selectedKind === 'AssocType' || selectedKind === 'AssocConst')}
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
					{@render linkedBadge(selected.type_name, selected.bound_links, false)}
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
					{#each selected.bounds as bound (bound)}
						{@render linkedBadge(bound, selected.bound_links, false)}
						{#if selected.bounds && selected.bounds.indexOf(bound) < selected.bounds.length - 1}
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
			<CollapsibleSection bind:this={docsRef} title="Documentation" defaultOpen={true}>
				<Documentation
					docs={selected.docs}
					defaultLang="rust"
					{theme}
					docLinks={selected.doc_links ?? {}}
					{getNodeUrl}
					{nodeExists}
				/>
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
									<div
										class={`bg-(--panel-solid) p-3 [contain-intrinsic-size:auto_80px] [content-visibility:auto] ${index ? 'border-t border-(--panel-border)' : ''}`}
									>
										<div class="flex flex-wrap items-center gap-2">
											{#if method.visibility === 'Public'}
												<span class="badge badge-strong text-(--accent)">pub</span>
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
										<div class="mt-1 flex flex-wrap items-center gap-3">
											{#if method.signature}
												<div class="min-w-0 flex-1">
													<CodeBlock
														code={formatSignature(method) ?? ''}
														lang="rust"
														variant="flat"
														{theme}
													/>
												</div>
											{/if}
											{#if method.span}
												<div class="shrink-0 text-xs">
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
											<div
												class={`mt-3 text-sm text-(--muted) ${method.signature ? 'border-t border-(--panel-border) pt-3' : ''}`}
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
			</CollapsibleSection>
		{/if}

		<!-- Relationships (collapse if many edges) -->
		<CollapsibleSection
			bind:this={relationshipsRef}
			title="Relationships"
			count={selectedEdges.outgoing.length + selectedEdges.incoming.length}
			defaultOpen={selectedEdges.outgoing.length + selectedEdges.incoming.length <=
				EDGES_COLLAPSE_THRESHOLD}
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
								<div>
									<span
										class="badge"
										{@attach tooltip(edgeKindDescriptions[edge.kind as EdgeKind] ?? edge.kind)}
									>
										{edgeLabels[edge.kind]}
									</span>
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
								<div>
									<span
										class="badge"
										{@attach tooltip(edgeKindDescriptions[edge.kind as EdgeKind] ?? edge.kind)}
									>
										{edgeLabels[edge.kind]}
									</span>
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
	<p class="text-sm text-(--muted)">Select a node to view details</p>
{/if}
