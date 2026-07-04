<script lang="ts">
	import { highlightCode, normalizeLanguage, type SupportedLanguage } from '$lib/highlight';

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
	} = $props<{
		code: string;
		lang?: SupportedLanguage | string;
		theme?: 'dark' | 'light';
		label?: string;
		lines?: boolean;
		showLineNumbers?: boolean;
		startLine?: number;
		highlightLines?: number[];
		variant?: 'default' | 'flat';
	}>();

	const normalizedLang = $derived(normalizeLanguage(lang));
	const withLineNumbers = $derived(lines || showLineNumbers);
	const highlightedHtml = $derived(
		await highlightCode(code, normalizedLang, theme, {
			startLine,
			highlightLines,
			showLineNumbers: withLineNumbers,
		}),
	);
</script>

<div
	class="design-codeblock codeblock corner-squircle animate-[fadeIn_.12s_ease] overflow-hidden"
	class:design-codeblock--flat={variant === 'flat'}
>
	{#if label}
		<div
			class="mono flex items-center justify-between gap-3 border-b border-[color:var(--code-border)] px-3 py-1.5 text-[11px]"
			style="color: var(--syntax-comment)"
		>
			<span class="truncate">{label}</span>
			<span class="shrink-0 opacity-70">{normalizedLang}</span>
		</div>
	{/if}

	<div class="design-codeblock__body">
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized Shiki output -->
		{@html highlightedHtml}
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
		font-size: 13.5px;
		line-height: 1.7;
	}

	.design-codeblock--flat {
		border: 0;
		border-radius: 0;
		background: transparent;
	}

	.design-codeblock--flat :global(pre) {
		padding: 0;
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
