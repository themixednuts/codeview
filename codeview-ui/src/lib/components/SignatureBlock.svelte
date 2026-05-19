<script lang="ts">
	import type { Node } from '$lib/graph';
	import { formatSignature } from '$lib/signature-format';
	import CodeBlock from './CodeBlock.svelte';

	let {
		node,
		theme = 'light',
		variant = 'flat',
	} = $props<{
		node: Node;
		theme?: 'dark' | 'light';
		variant?: 'flat' | 'card';
	}>();

	// Pure rustfmt formatter (see $lib/signature-format). Returns both forms
	// so the dynamic-width logic below can swap between them without re-
	// computing on every threshold flip.
	const formatted = $derived(formatSignature(node));

	// ── Dynamic width measurement ────────────────────────────────────
	// We render `formatted.inline` into a hidden, shrink-to-fit <div> with
	// the same font/size as the real codeblock. Its `scrollWidth` is the
	// natural pixel width the inline form would need. A single
	// ResizeObserver watches that div — it fires both when the container
	// resizes (no change to the inline text) AND when the inline text
	// changes (because the absolute-positioned div re-flows to its new
	// intrinsic width). That's the only mechanism that writes
	// `inlineMeasuredWidth`; no $effect needed.
	let containerWidth = $state(0);
	let inlineMeasuredWidth = $state(0);

	function attachContainer(el: HTMLDivElement) {
		const ro = new ResizeObserver(([entry]) => {
			containerWidth = entry.contentRect.width;
		});
		ro.observe(el);
		// Seed first paint so we have a value before the first RO callback.
		containerWidth = el.getBoundingClientRect().width;
		return () => ro.disconnect();
	}

	function attachMeasure(el: HTMLDivElement) {
		// scrollWidth gives the *unwrapped* layout width — exactly what
		// we'd see if we forced the inline form to render without breaking.
		inlineMeasuredWidth = el.scrollWidth;
		let disposed = false;
		const ro = new ResizeObserver(() => {
			if (!disposed) inlineMeasuredWidth = el.scrollWidth;
		});
		ro.observe(el);
		// Fonts lazy-load on cold visit — re-read once they're ready so the
		// first measurement reflects real JetBrains Mono metrics rather
		// than the fallback font's narrower glyphs.
		if (typeof document !== 'undefined' && document.fonts) {
			void document.fonts.ready.then(() => {
				if (!disposed) inlineMeasuredWidth = el.scrollWidth;
			});
		}
		return () => {
			disposed = true;
			ro.disconnect();
		};
	}

	// `variant="flat"` strips CodeBlock's internal padding, so we measure
	// against the raw container width with a small safety buffer for sub-
	// pixel rounding and monospace metric variance across themes.
	const SAFETY_PX = 4;
	const fitsInline = $derived(
		containerWidth > 0 &&
			inlineMeasuredWidth > 0 &&
			inlineMeasuredWidth + SAFETY_PX <= containerWidth,
	);
	const code = $derived(fitsInline ? formatted.inline : formatted.multiline);
</script>

<div {@attach attachContainer} class="signature-block">
	<!-- Hidden measurement node: same font as the real codeblock so its
		 scrollWidth tells us the natural width the inline form would need.
		 `aria-hidden` + visibility:hidden keep it out of a11y / focus. A <div>
		 (not <pre>) sidesteps Svelte's a11y_no_noninteractive_tabindex rule;
		 white-space:pre in CSS still preserves the layout for measurement. -->
	<div {@attach attachMeasure} class="signature-measure" aria-hidden="true">{formatted.inline}</div>

	<CodeBlock {code} lang="rust" {variant} {theme} />
</div>

<style>
	.signature-block {
		position: relative;
		min-width: 0;
	}

	.signature-measure {
		/* Off-screen but laid out so scrollWidth reflects real font metrics. */
		position: absolute;
		left: -99999px;
		top: 0;
		visibility: hidden;
		white-space: pre;
		font-family: var(--font-code);
		font-size: 0.8125rem;
		line-height: 1.6;
		margin: 0;
		padding: 0;
		pointer-events: none;
	}
</style>
