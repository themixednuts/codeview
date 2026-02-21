<script lang="ts">
	import type { Node, NodeKind } from '$lib/graph';
	import { kindColors, kindIcons } from '$lib/tree';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { resolve } from '$app/paths';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';

	let {
		node,
		depth,
		hasChildren,
		isExpanded,
		isSelected,
		dimmed,
		selectable,
		href,
		onToggle,
		onSelect,
		itemHeight,
	} = $props<{
		node: Node;
		depth: number;
		hasChildren: boolean;
		isExpanded: boolean;
		isSelected: boolean;
		dimmed: boolean;
		selectable: boolean;
		href: string;
		/** Toggle expand/collapse (chevron click) */
		onToggle: () => void;
		/** Navigate + maybe expand (row click) */
		onSelect: () => void;
		/** Fixed row height in px (used by virtual tree) */
		itemHeight?: number;
	}>();

	const kind = $derived(node.kind as NodeKind);
	const KindIcon = $derived(kindIcons[kind] ?? kindIcons.Crate);
	const heightStyle = $derived(itemHeight ? `height: ${itemHeight}px; ` : '');
	const cvStyle = $derived(
		itemHeight ? '' : 'content-visibility: auto; contain-intrinsic-size: auto 32px; ',
	);
	const paddingStyle = $derived(`padding-left: ${depth * 16 + 8}px`);
	const style = $derived(`${cvStyle}${heightStyle}${paddingStyle}`);

	function handleChevronClick(e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		onToggle();
	}

	function handleRowClick() {
		onSelect();
	}

	function handleRowKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			onSelect();
		}
	}
</script>

{#if selectable}
	<a
		href={resolve(href)}
		data-sveltekit-noscroll
		data-sveltekit-preload-data="off"
		class="corner-squircle box-border flex w-full items-center gap-2 rounded-(--radius-chip) px-2 py-1 text-sm leading-none hover:bg-(--panel-strong) {isSelected
			? 'bg-(--accent)/10 ring-1 ring-(--accent) ring-inset'
			: ''} {dimmed ? 'opacity-50' : ''}"
		{style}
		onclick={handleRowClick}
	>
		{#if hasChildren}
			<button
				type="button"
				class="flex size-4 shrink-0 cursor-pointer items-center justify-center border-none bg-transparent p-0 text-(--muted) hover:text-(--ink)"
				onclick={handleChevronClick}
				aria-label={isExpanded ? 'Collapse node' : 'Expand node'}
			>
				{#if isExpanded}
					<ChevronDown size={14} strokeWidth={2.5} />
				{:else}
					<ChevronRight size={14} strokeWidth={2.5} />
				{/if}
			</button>
		{:else}
			<span class="flex size-4 shrink-0"></span>
		{/if}
		<span
			class="corner-squircle flex size-5 shrink-0 items-center justify-center rounded-(--radius-chip) text-(--on-accent)"
			style="background-color: {kindColors[kind] ?? kindColors.Crate}"
		>
			<KindIcon size={12} strokeWidth={2.5} />
		</span>
		<span class="min-w-0 flex-1 truncate font-medium text-(--ink)">
			{node.name}
		</span>
		{#if node.visibility === 'Public'}
			<span class="ml-auto text-[10px] leading-none font-medium text-(--accent)">pub</span>
		{/if}
	</a>
{:else}
	<div
		class="corner-squircle box-border flex w-full items-center gap-2 rounded-(--radius-chip) px-2 py-1 text-sm leading-none hover:bg-(--panel-strong) {dimmed
			? 'opacity-50'
			: ''} {hasChildren ? 'cursor-pointer' : ''}"
		{style}
		onclick={handleRowClick}
		onkeydown={handleRowKeydown}
		role="button"
		tabindex="0"
	>
		{#if hasChildren}
			<button
				type="button"
				class="flex size-4 shrink-0 cursor-pointer items-center justify-center border-none bg-transparent p-0 text-(--muted) hover:text-(--ink)"
				onclick={handleChevronClick}
				aria-label={isExpanded ? 'Collapse node' : 'Expand node'}
			>
				{#if isExpanded}
					<ChevronDown size={14} strokeWidth={2.5} />
				{:else}
					<ChevronRight size={14} strokeWidth={2.5} />
				{/if}
			</button>
		{:else}
			<span class="flex size-4 shrink-0"></span>
		{/if}
		<span
			class="corner-squircle flex size-5 shrink-0 items-center justify-center rounded-(--radius-chip) text-(--on-accent)"
			style="background-color: {kindColors[kind] ?? kindColors.Crate}"
		>
			<KindIcon size={12} strokeWidth={2.5} />
		</span>
		<span class="min-w-0 flex-1 truncate font-medium text-(--ink)">
			{node.name}
		</span>
		{#if node.visibility === 'Public'}
			<span class="ml-auto text-[10px] leading-none font-medium text-(--accent)">pub</span>
		{/if}
	</div>
{/if}
