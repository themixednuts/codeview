<script lang="ts">
	import { STEP_ORDER, stepLabels, stepPercents } from '$lib/realtime';
	import { parseToastState } from '$lib/toast/parse-toast.svelte';

	const stepIndex = $derived(parseToastState.step ? STEP_ORDER.indexOf(parseToastState.step) : -1);
	const stepTotal = STEP_ORDER.length;
	const stepLabel = $derived(
		parseToastState.step ? (stepLabels[parseToastState.step] ?? 'Processing...') : 'Starting...',
	);

	const isParsing = $derived(parseToastState.step === 'parsing');
	const hidePercent = $derived(isParsing && parseToastState.totalItems === null);

	const percent = $derived.by(() => {
		if (!parseToastState.step) return 5;
		const base = stepPercents[parseToastState.step] ?? 10;
		const nextIdx = stepIndex + 1;
		const ceil =
			nextIdx < stepTotal ? (stepPercents[STEP_ORDER[nextIdx]] ?? 100) : 100;
		if (isParsing && parseToastState.nodeCount > 0) {
			const denominator =
				parseToastState.totalItems && parseToastState.totalItems > 0
					? parseToastState.totalItems
					: Math.max(10000, parseToastState.nodeCount * 1.2);
			const ratio = Math.min(parseToastState.nodeCount / denominator, 1);
			return Math.round(base + ratio * (ceil - base));
		}
		return base;
	});

	const formattedNodes = $derived(
		parseToastState.nodeCount > 0 ? parseToastState.nodeCount.toLocaleString() : '',
	);
	const formattedEdges = $derived(
		parseToastState.edgeCount > 0 ? parseToastState.edgeCount.toLocaleString() : '',
	);
</script>

<div class="w-72 overflow-hidden rounded-(--radius-card) border border-(--panel-border) bg-(--panel-solid) shadow-lg">
	<div class="h-1 w-full bg-(--panel-strong)">
		<div
			class="h-full bg-(--accent) transition-all duration-500 ease-out"
			style="width: {percent}%"
		></div>
	</div>

	<div class="space-y-1.5 px-3 py-2.5">
		{#if parseToastState.crateName}
			<div class="truncate text-xs font-medium text-(--accent)">
				Parsing {parseToastState.crateName}
			</div>
		{/if}
		<div class="flex items-center justify-between gap-2">
			<div class="truncate text-sm font-medium text-(--ink)">{stepLabel}</div>
			{#if !hidePercent}
				<div class="shrink-0 font-mono text-xs text-(--muted) tabular-nums">
					{percent}%
				</div>
			{/if}
		</div>
		<div class="flex items-center justify-between gap-2">
			{#if formattedNodes}
				<div class="font-mono text-xs text-(--muted) tabular-nums">
					{formattedNodes} nodes · {formattedEdges} edges
				</div>
			{:else}
				<div class="text-xs text-(--muted)">&nbsp;</div>
			{/if}
			{#if stepIndex >= 0}
				<div class="shrink-0 text-[10px] text-(--muted) tabular-nums">
					{stepIndex + 1}/{stepTotal}
				</div>
			{/if}
		</div>
	</div>
</div>
