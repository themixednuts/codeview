<script lang="ts">
	import type { SupportedLanguage } from '$lib/highlight/languages';
	import { tick } from 'svelte';

	let {
		code,
		lang = 'rust',
		theme = 'light',
		variant = 'default',
		startLine,
		highlightLines,
		showLineNumbers = false,
		revealAfterHighlight = false,
		onHighlightStateChange,
	} = $props<{
		code: string;
		lang?: SupportedLanguage;
		theme?: 'dark' | 'light';
		variant?: 'default' | 'flat';
		startLine?: number;
		highlightLines?: number[];
		showLineNumbers?: boolean;
		revealAfterHighlight?: boolean;
		onHighlightStateChange?: (ready: boolean) => void;
	}>();

	function escapeHtml(text: string): string {
		return text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#039;');
	}

	function plainCodeHtml(
		source: string,
		options: {
			startLine?: number;
			highlightLines?: number[];
			showLineNumbers?: boolean;
		} = {},
	): string {
		const escaped = escapeHtml(source);
		const firstLine = options.startLine ?? 1;
		if (!options.showLineNumbers && !options.highlightLines?.length) {
			return `<pre class="shiki"><code>${escaped}</code></pre>`;
		}

		const lines = escaped
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

		return `<pre class="shiki"><code>${lines}</code></pre>`;
	}

	let highlightedHtml = $state('');
	const fallbackHtml = $derived(
		plainCodeHtml(code, { startLine, highlightLines, showLineNumbers }),
	);
	const renderedHtml = $derived(highlightedHtml || fallbackHtml);
	const highlightReady = $derived(highlightedHtml.length > 0);

	$effect(() => {
		const nextCode = code;
		const nextLang = lang;
		const nextTheme = theme;
		const options = { startLine, highlightLines, showLineNumbers };
		let cancelled = false;
		highlightedHtml = '';
		onHighlightStateChange?.(false);

		void (async () => {
			let html: string;
			try {
				const { highlightCode } = await import('$lib/highlight/shiki');
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
	class="code-block corner-squircle overflow-x-auto rounded-(--radius-control)"
	class:code-block--flat={variant === 'flat'}
	class:code-block--deferred={revealAfterHighlight}
	class:code-block--ready={highlightReady}
	aria-busy={revealAfterHighlight && !highlightReady}
>
	<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized Shiki output -->
	{@html renderedHtml}
</div>

<style>
	.code-block :global(code) {
		font-family: var(--font-code);
		font-size: var(--code-fs, 0.9375rem);
		line-height: 1.65;
	}

	.code-block--flat :global(pre) {
		margin: 0;
		padding: 0;
		border-radius: 0;
		background: transparent !important;
		border: none;
	}

	:global(html[data-hydrated='true']) .code-block--deferred:not(.code-block--ready) {
		visibility: hidden;
	}

	.code-block :global(.line.has-line-number)::before {
		content: attr(data-line);
		display: inline-block;
		width: 3ch;
		margin-right: 1.5ch;
		text-align: right;
		color: var(--muted);
		opacity: 0.5;
		user-select: none;
	}

	.code-block :global(.line.highlighted) {
		background: var(--highlight-bg);
		display: inline-block;
		width: 100%;
	}
</style>
