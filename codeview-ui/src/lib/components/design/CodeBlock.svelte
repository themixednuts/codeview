<script lang="ts">
	import { normalizeLanguage, type SupportedLanguage } from '#lib/highlight/languages.js';
	import { tick } from 'svelte';

	type CodeBlockProps = {
		code: string;
		lang?: SupportedLanguage | string;
		theme?: 'dark' | 'light';
		label?: string;
		lines?: boolean;
		showLineNumbers?: boolean;
		startLine?: number;
		highlightLines?: number[];
		variant?: 'default' | 'flat';
		revealAfterHighlight?: boolean;
		onHighlightStateChange?: (ready: boolean) => void;
	};

	type PlainCodeOptions = {
		startLine?: number;
		highlightLines?: number[];
		showLineNumbers?: boolean;
	};

	let {
		code,
		lang = 'rust',
		theme = 'light',
		label,
		lines = false,
		showLineNumbers = false,
		startLine,
		highlightLines,
		variant = 'default',
		revealAfterHighlight = false,
		onHighlightStateChange,
	}: CodeBlockProps = $props();

	const normalizedLang = $derived(normalizeLanguage(lang));
	const withLineNumbers = $derived(lines || showLineNumbers);

	function escapeHtml(text: string): string {
		return text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#039;');
	}

	function plainCodeHtml(source: string, options: PlainCodeOptions): string {
		const escaped = escapeHtml(source);
		const firstLine = options.startLine ?? 1;
		if (!options.showLineNumbers && !options.highlightLines?.length) {
			return `<pre class="shiki"><code>${escaped}</code></pre>`;
		}

		const renderedLines = escaped
			.split('\n')
			.map((line, index) => {
				const lineNumber = firstLine + index;
				const classes = [
					'line',
					options.showLineNumbers ? 'has-line-number' : '',
					options.highlightLines?.includes(lineNumber) ? 'highlighted' : '',
				]
					.filter(Boolean)
					.join(' ');
				const dataLine = options.showLineNumbers ? ` data-line="${lineNumber}"` : '';
				return `<span class="${classes}"${dataLine}>${line}</span>`;
			})
			.join('\n');

		return `<pre class="shiki"><code>${renderedLines}</code></pre>`;
	}

	let highlightedHtml = $state('');
	const fallbackHtml = $derived(
		plainCodeHtml(code, {
			startLine,
			highlightLines,
			showLineNumbers: withLineNumbers,
		}),
	);
	const renderedHtml = $derived(highlightedHtml || fallbackHtml);
	const highlightReady = $derived(highlightedHtml.length > 0);

	$effect(() => {
		const nextCode = code;
		const nextLang = normalizedLang;
		const nextTheme = theme;
		const options = {
			startLine,
			highlightLines,
			showLineNumbers: withLineNumbers,
		};
		let cancelled = false;
		highlightedHtml = '';
		onHighlightStateChange?.(false);

		// Shiki is a large highlighter; load it on first paint of a code block.
		void (async () => {
			let html: string;
			try {
				const { highlightCode } = await import('#lib/highlight/shiki.js');
				html = await highlightCode(nextCode, nextLang, nextTheme, options);
			} catch {
				html = plainCodeHtml(nextCode, options);
			}

			if (cancelled) return;
			highlightedHtml = html;
			await tick();
			if (!cancelled) onHighlightStateChange?.(true);
		})();

		return () => {
			cancelled = true;
		};
	});
</script>

<div
	class="design-codeblock codeblock corner-squircle overflow-hidden"
	class:design-codeblock--flat={variant === 'flat'}
	class:design-codeblock--deferred={revealAfterHighlight}
	class:design-codeblock--ready={highlightReady}
	aria-busy={revealAfterHighlight && !highlightReady}
>
	{#if label}
		<div
			class="mono flex items-center justify-between gap-3 border-b border-[color:var(--code-border)] px-3 py-1.5 text-xs"
			style="color: var(--syntax-comment)"
		>
			<span class="truncate">{label}</span>
			<span class="shrink-0 opacity-70">{normalizedLang}</span>
		</div>
	{/if}

	<div class="design-codeblock__body">
		<!-- Shiki output is escaped HTML from highlightCode / plainCodeHtml. -->
		{@html renderedHtml}
	</div>
</div>

<style>
	.design-codeblock {
		background: var(--code-bg);
		color: var(--code-ink);
	}

	.design-codeblock :global(pre) {
		margin: 0;
		padding: 0.75rem 1rem;
		border: 0;
		border-radius: 0;
		background: transparent !important;
		overflow-x: auto;
	}

	.design-codeblock :global(code) {
		font-family: var(--font-code);
		font-size: var(--code-fs, 0.9375rem);
		line-height: 1.65;
	}

	.design-codeblock--flat {
		border: 0;
		border-radius: 0;
		background: transparent;
	}

	:global(html[data-hydrated='true']) .design-codeblock--deferred:not(.design-codeblock--ready) {
		visibility: hidden;
	}

	.design-codeblock :global(.line.has-line-number)::before {
		content: attr(data-line);
		display: inline-block;
		width: 3ch;
		margin-right: 1.5ch;
		text-align: right;
		color: var(--code-ln);
		user-select: none;
	}

	.design-codeblock :global(.line.highlighted) {
		display: inline-block;
		width: 100%;
		background: var(--highlight-bg);
	}
</style>
