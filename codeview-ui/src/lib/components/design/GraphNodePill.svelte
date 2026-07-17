<script lang="ts">
	import type { NodeKind } from '$lib/schema';
	import { kindColors } from '$lib/tree';
	import type { DesignNode } from '$lib/design/live-node';
	import { designKindToNodeKind } from '$lib/design/live-node';
	import KindBadge from './KindBadge.svelte';

	type PillNode = Pick<DesignNode, 'id' | 'kind' | 'path' | 'external'> &
		Partial<Pick<DesignNode, 'label' | 'kindLabel' | 'real' | 'href'>>;

	let {
		node,
		left,
		top,
		width,
		color,
		isFocus = false,
		dim = false,
		active = false,
		href,
		onactivate,
		onenter,
		onleave,
	} = $props<{
		node: PillNode;
		left?: number;
		top?: number;
		width?: number;
		color?: string;
		isFocus?: boolean;
		dim?: boolean;
		active?: boolean;
		href?: string;
		onactivate?: (node: PillNode, event: MouseEvent) => void;
		onenter?: (node: PillNode, event: MouseEvent) => void;
		onleave?: (node: PillNode, event: MouseEvent) => void;
	}>();

	const resolvedKind = $derived(resolveNodeKind(node));
	const pillColor = $derived(
		color ?? (resolvedKind ? (kindColors[resolvedKind] ?? 'var(--accent)') : 'var(--accent)'),
	);
	const pillHref = $derived(href ?? node.href);
	const positioned = $derived(left !== undefined && top !== undefined);
	const label = $derived(node.label ?? node.id);
	const displayWidth = $derived(width ?? measurePill(label, isFocus));
	const style = $derived(buildStyle());

	function resolveNodeKind(value: PillNode): NodeKind | undefined {
		return value.real?.kind ?? designKindToNodeKind(value.kind);
	}

	function measurePill(text: string, focus: boolean): number {
		return focus ? Math.max(160, 96 + text.length * 8.8) : Math.max(98, 52 + text.length * 7.2);
	}

	function buildStyle(): string {
		const height = isFocus ? 48 : 32;
		const padding = isFocus ? '0 18px' : '0 11px';
		const background = isFocus ? 'var(--accent)' : 'var(--panel-solid)';
		const border = isFocus
			? '1px solid var(--accent)'
			: `1px solid ${active ? pillColor : 'var(--panel-border)'}`;
		const shadow = isFocus
			? '0 8px 22px var(--accent-ring)'
			: active
				? `0 4px 14px color-mix(in srgb, ${pillColor} 30%, transparent)`
				: 'var(--shadow-soft)';
		const transform = active && !isFocus ? 'translateY(-1px)' : 'none';
		return [
			`--pill-left: ${left ?? 0}px`,
			`--pill-top: ${top ?? 0}px`,
			`--pill-width: ${displayWidth}px`,
			`--pill-height: ${height}px`,
			`--pill-padding: ${padding}`,
			`--pill-bg: ${background}`,
			`--pill-border: ${border}`,
			`--pill-shadow: ${shadow}`,
			`--pill-opacity: ${dim ? 0.28 : 1}`,
			`--pill-transform: ${transform}`,
			`--pill-z: ${active ? 5 : 1}`,
			`--pill-ink: ${isFocus ? 'var(--on-accent)' : 'var(--ink)'}`,
		].join('; ');
	}

	function handleActivate(event: MouseEvent) {
		onactivate?.(node, event);
	}

	function handleEnter(event: MouseEvent) {
		onenter?.(node, event);
	}

	function handleLeave(event: MouseEvent) {
		onleave?.(node, event);
	}
</script>

{#if pillHref}
	<a
		href={pillHref}
		class="graph-node-pill flex min-w-0 animate-[fadeIn_.12s_ease] items-center gap-2 rounded-lg transition-all"
		class:positioned
		data-focus={isFocus}
		data-active={active}
		aria-current={isFocus ? 'true' : undefined}
		{style}
		onclick={handleActivate}
		onmouseenter={handleEnter}
		onmouseleave={handleLeave}
	>
		<KindBadge kind={node.kind} size={isFocus ? 20 : 16} />
		<span class="graph-node-pill__label truncate text-left leading-none">
			{label}
		</span>
		{#if isFocus}
			<span class="mono ml-auto shrink-0 text-2xs tracking-wider uppercase opacity-70">
				{node.kindLabel ?? node.kind}
			</span>
		{/if}
	</a>
{:else}
	<button
		type="button"
		class="graph-node-pill flex min-w-0 animate-[fadeIn_.12s_ease] items-center gap-2 rounded-lg transition-all"
		class:positioned
		data-focus={isFocus}
		data-active={active}
		{style}
		onclick={handleActivate}
		onmouseenter={handleEnter}
		onmouseleave={handleLeave}
	>
		<KindBadge kind={node.kind} size={isFocus ? 20 : 16} />
		<span class="graph-node-pill__label truncate text-left leading-none">
			{label}
		</span>
		{#if isFocus}
			<span class="mono ml-auto shrink-0 text-2xs tracking-wider uppercase opacity-70">
				{node.kindLabel ?? node.kind}
			</span>
		{/if}
	</button>
{/if}

<style>
	.graph-node-pill {
		width: var(--pill-width);
		height: var(--pill-height);
		padding: var(--pill-padding);
		background: var(--pill-bg);
		border: var(--pill-border);
		box-shadow: var(--pill-shadow);
		opacity: var(--pill-opacity);
		transform: var(--pill-transform);
		z-index: var(--pill-z);
		color: var(--pill-ink);
		cursor: pointer;
		text-decoration: none;
	}

	.graph-node-pill.positioned {
		position: absolute;
		left: var(--pill-left);
		top: var(--pill-top);
	}

	.graph-node-pill[data-focus='true'] {
		cursor: default;
	}

	.graph-node-pill__label {
		font-family: var(--font-code);
		font-size: var(--text-sm);
		font-weight: 600;
		color: var(--pill-ink);
	}

	.graph-node-pill[data-focus='true'] .graph-node-pill__label {
		font-family: var(--font-display);
		font-size: var(--text-md);
		font-weight: 700;
	}
</style>
