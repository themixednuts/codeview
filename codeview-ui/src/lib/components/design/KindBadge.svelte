<script lang="ts">
	import type { NodeKind } from '#lib/schema.js';
	import { kindLabels } from '#lib/display-names.js';
	import { kindColors } from '#lib/tree.js';
	import { designKindToNodeKind } from '#lib/design/live-node.js';
	import * as Predicate from 'effect/Predicate';

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
	const labelText = $derived(Predicate.isString(label) ? label : displayLabel);
	const style = $derived(
		`width: ${size / 16}rem; height: ${size / 16}rem; background: ${color}; font-size: ${glyphSize / 16}rem`,
	);

	type PrimitiveTextInput = string | number | boolean | bigint | symbol | null | undefined;

	function primitiveText(value: PrimitiveTextInput): string {
		if (Predicate.isString(value)) return value;
		if (Predicate.isNumber(value) || Predicate.isBoolean(value) || Predicate.isBigInt(value)) {
			return String(value);
		}
		if (Predicate.isSymbol(value)) return value.description ?? 'unknown';
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
		<span class="mono truncate text-xs font-semibold text-[color:var(--muted)]">
			{labelText}
		</span>
	{/if}
</span>
