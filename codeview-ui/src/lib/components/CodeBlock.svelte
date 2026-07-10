<script lang="ts">
	import type { SupportedLanguage } from '$lib/highlight/languages';

	let {
		code,
		lang = 'rust',
		theme = 'light',
		variant = 'default',
		startLine,
		highlightLines,
		showLineNumbers = false,
	} = $props<{
		code: string;
		lang?: SupportedLanguage;
		theme?: 'dark' | 'light';
		variant?: 'default' | 'flat';
		startLine?: number;
		highlightLines?: number[];
		showLineNumbers?: boolean;
	}>();

	function escapeHtml(text: string): string {
		return text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#039;');
	}

	function plainCodeHtml(source: string): string {
		return `<pre class="shiki"><code>${escapeHtml(source)}</code></pre>`;
	}

	let highlightedHtml = $state('');
	const fallbackHtml = $derived(plainCodeHtml(code));
	const renderedHtml = $derived(highlightedHtml || fallbackHtml);

	$effect(() => {
		const nextCode = code;
		const nextLang = lang;
		const nextTheme = theme;
		const options = { startLine, highlightLines, showLineNumbers };
		let cancelled = false;
		highlightedHtml = '';

		void import('$lib/highlight/shiki')
			.then(({ highlightCode }) => highlightCode(nextCode, nextLang, nextTheme, options))
			.then((html) => {
				if (!cancelled) highlightedHtml = html;
			})
			.catch(() => {
				if (!cancelled) highlightedHtml = plainCodeHtml(nextCode);
			});

		return () => {
			cancelled = true;
		};
	});
</script>

<div
	class="code-block corner-squircle overflow-x-auto rounded-(--radius-control) text-sm"
	class:code-block--flat={variant === 'flat'}
>
	<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized Shiki output -->
	{@html renderedHtml}
</div>

<style>
	.code-block--flat :global(pre) {
		margin: 0;
		padding: 0;
		border-radius: 0;
		background: transparent !important;
		border: none;
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
