<script lang="ts">
	import type { Node } from '#lib/schema.js';
	import { formatSignature } from '#lib/signature-format.js';
	import CodeBlock from './CodeBlock.svelte';

	type SignatureProps = {
		node: Pick<Node, 'name' | 'signature'>;
		form?: 'inline' | 'multiline' | 'auto';
		theme?: 'dark' | 'light';
		variant?: 'default' | 'flat';
		label?: string;
	};

	let {
		node,
		form = 'auto',
		theme = 'light',
		variant = 'flat',
		label,
	}: SignatureProps = $props();

	const formatted = $derived(formatSignature(node));
	let containerWidth = $state(0);
	let inlineMeasuredWidth = $state(0);

	function attachContainer(el: HTMLDivElement) {
		let disposed = false;
		let frame = 0;
		const measure = () => {
			if (!disposed) containerWidth = el.getBoundingClientRect().width;
		};
		const ro = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (!disposed && entry) containerWidth = entry.contentRect.width;
		});
		ro.observe(el);
		frame = requestAnimationFrame(measure);
		return () => {
			disposed = true;
			cancelAnimationFrame(frame);
			ro.disconnect();
		};
	}

	function attachMeasure(el: HTMLDivElement) {
		let disposed = false;
		let frame = 0;
		const measure = () => {
			if (!disposed) inlineMeasuredWidth = el.scrollWidth;
		};
		const ro = new ResizeObserver(() => {
			measure();
		});
		ro.observe(el);
		frame = requestAnimationFrame(measure);
		void document.fonts.ready.then(() => {
			if (!disposed) inlineMeasuredWidth = el.scrollWidth;
		});
		return () => {
			disposed = true;
			cancelAnimationFrame(frame);
			ro.disconnect();
		};
	}

	const SAFETY_PX = 4;
	const fitsInline = $derived(
		containerWidth > 0 &&
			inlineMeasuredWidth > 0 &&
			inlineMeasuredWidth + SAFETY_PX <= containerWidth,
	);
	const code = $derived(
		form === 'inline'
			? formatted.inline
			: form === 'multiline'
				? formatted.multiline
				: fitsInline
					? formatted.inline
					: formatted.multiline,
	);
</script>

<div {@attach attachContainer} class="signature-block">
	{#if form === 'auto'}
		<div {@attach attachMeasure} class="signature-measure" aria-hidden="true">{formatted.inline}</div>
	{/if}
	<CodeBlock {code} lang="rust" {theme} {variant} {label} />
</div>

<style>
	.signature-block {
		position: relative;
		min-width: 0;
	}

	.signature-measure {
		position: absolute;
		left: -99999px;
		top: 0;
		visibility: hidden;
		white-space: pre;
		font-family: var(--font-code);
		font-size: var(--code-fs, 0.9375rem);
		line-height: 1.65;
		margin: 0;
		padding: 0;
		pointer-events: none;
	}
</style>
