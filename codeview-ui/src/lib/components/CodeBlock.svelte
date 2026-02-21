<script lang="ts">
	import { highlightCode, type SupportedLanguage } from '$lib/highlight';

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

	const highlightedHtml = $derived(
		await highlightCode(code, lang, theme, { startLine, highlightLines, showLineNumbers }),
	);
</script>

<div
	class="code-block corner-squircle overflow-x-auto rounded-(--radius-control) text-sm"
	class:code-block--flat={variant === 'flat'}
>
	<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized Shiki output -->
	{@html highlightedHtml}
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
