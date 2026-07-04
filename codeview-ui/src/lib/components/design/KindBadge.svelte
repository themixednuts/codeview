<script lang="ts">
	import type { NodeKind } from '$lib/schema';
	import { kindLabels } from '$lib/display-names';
	import { kindColors, kindIcons } from '$lib/tree';
	import { designKindToNodeKind } from '$lib/design/live-node';

	let {
		kind,
		size = 16,
		label = false,
		title,
	} = $props<{
		kind: NodeKind | string;
		size?: number;
		label?: boolean | string;
		title?: string;
	}>();

	const nodeKind = $derived(designKindToNodeKind(kind));
	const displayLabel = $derived(nodeKind ? (kindLabels[nodeKind] ?? nodeKind) : kind);
	const badgeTitle = $derived(title ?? displayLabel);
	const color = $derived(nodeKind ? (kindColors[nodeKind] ?? 'var(--muted)') : 'var(--muted)');
	const KindIcon = $derived(nodeKind ? (kindIcons[nodeKind] ?? kindIcons.Crate) : undefined);
	const iconSize = $derived(Math.max(10, Math.round(size * 0.64)));
	const glyphSize = $derived(Math.max(9, Math.round(size * 0.56)));
	const labelText = $derived(typeof label === 'string' ? label : displayLabel);
	const style = $derived(
		`width: ${size}px; height: ${size}px; background: ${color}; font-size: ${glyphSize}px`,
	);
</script>

<span class="inline-flex items-center gap-1.5 align-middle" title={badgeTitle}>
	<span
		class="kind-glyph mono corner-squircle inline-grid shrink-0 place-items-center font-semibold text-white"
		aria-hidden="true"
		{style}
	>
		{#if KindIcon}
			<KindIcon size={iconSize} strokeWidth={2.25} />
		{:else}
			<span aria-hidden="true">·</span>
		{/if}
	</span>
	{#if label}
		<span class="mono truncate text-[10.5px] font-semibold text-[color:var(--muted)]">
			{labelText}
		</span>
	{/if}
</span>
