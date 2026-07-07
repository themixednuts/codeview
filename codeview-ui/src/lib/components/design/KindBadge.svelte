<script lang="ts">
	import type { NodeKind } from '$lib/schema';
	import { kindLabels } from '$lib/display-names';
	import { kindColors } from '$lib/tree';
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

	const kindText = $derived(primitiveText(kind));
	const nodeKind = $derived(designKindToNodeKind(kindText));
	const displayLabel = $derived(nodeKind ? (kindLabels[nodeKind] ?? nodeKind) : kindText);
	const badgeTitle = $derived(title ?? displayLabel);
	const color = $derived(nodeKind ? (kindColors[nodeKind] ?? 'var(--muted)') : 'var(--muted)');
	const glyphSize = $derived(Math.max(9, Math.round(size * 0.56)));
	const glyph = $derived(displayLabel.slice(0, 1).toUpperCase());
	const labelText = $derived(typeof label === 'string' ? label : displayLabel);
	const style = $derived(
		`width: ${size}px; height: ${size}px; background: ${color}; font-size: ${glyphSize}px`,
	);

	function primitiveText(value: unknown): string {
		if (typeof value === 'string') return value;
		if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
			return String(value);
		}
		if (typeof value === 'symbol') return value.description ?? 'unknown';
		return 'unknown';
	}
</script>

<span class="inline-flex items-center gap-1.5 align-middle" title={badgeTitle}>
	<span
		class="kind-glyph mono corner-squircle inline-grid shrink-0 place-items-center font-semibold text-white"
		aria-hidden="true"
		{style}
	>
		{glyph}
	</span>
	{#if label}
		<span class="mono truncate text-[10.5px] font-semibold text-[color:var(--muted)]">
			{labelText}
		</span>
	{/if}
</span>
