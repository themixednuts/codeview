import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import rust from '@shikijs/langs/rust';
import typescript from '@shikijs/langs/typescript';
import javascript from '@shikijs/langs/javascript';
import json from '@shikijs/langs/json';
import toml from '@shikijs/langs/toml';
import bash from '@shikijs/langs/bash';
import sql from '@shikijs/langs/sql';
import type { SupportedLanguage } from './languages';
export { getDefaultLanguage, normalizeLanguage } from './languages';
export type { ProjectType, SupportedLanguage } from './languages';
// Eager imports force Vite/rolldown to bundle each theme — `themes: ['name']`
// alone leaves them dynamic and they fall out of the build. We re-alias
// `one-dark-pro` (the only "One Dark" shiki ships) as `one-dark` so the
// Tweaks-panel-facing key matches.
import solarizedLight from '@shikijs/themes/solarized-light';
import solarizedDark from '@shikijs/themes/solarized-dark';
import catppuccinLatte from '@shikijs/themes/catppuccin-latte';
import catppuccinMocha from '@shikijs/themes/catppuccin-mocha';
import oneLight from '@shikijs/themes/one-light';
import oneDarkPro from '@shikijs/themes/one-dark-pro';
import githubLight from '@shikijs/themes/github-light';
import githubDark from '@shikijs/themes/github-dark';

const oneDark = { ...oneDarkPro, name: 'one-dark' };

/**
 * All shiki themes the Tweaks panel can pick. Output is generated with
 * --shiki-{theme} CSS variables for each so the active theme switches
 * via `[data-code-theme="..."]` in app.css — no re-render needed.
 */
const CODE_THEMES = [
	'solarized-light',
	'solarized-dark',
	'catppuccin-latte',
	'catppuccin-mocha',
	'one-light',
	'one-dark',
	'github-light',
	'github-dark',
] as const;

let highlighterPromise: Promise<HighlighterCore> | null = null;

// Keep the browser bundle limited to the languages Codeview actually renders.
// Importing Shiki's umbrella entry emits every bundled grammar as an asset.
async function getHighlighter(): Promise<HighlighterCore> {
	if (!highlighterPromise) {
		highlighterPromise = createHighlighterCore({
			themes: [
				solarizedLight,
				solarizedDark,
				catppuccinLatte,
				catppuccinMocha,
				oneLight,
				oneDark,
				githubLight,
				githubDark,
			],
			langs: [rust, typescript, javascript, json, toml, bash, sql],
			engine: createJavaScriptRegexEngine(),
		});
	}
	return highlighterPromise;
}

// Highlight code with the given language. The `theme` argument is kept
// for backwards-compatibility but is ignored — all 8 themes are emitted
// as CSS variables and the active one is picked by `[data-code-theme]`.
export async function highlightCode(
	code: string,
	lang: SupportedLanguage = 'rust',
	_theme: 'dark' | 'light' = 'dark',
	options?: {
		startLine?: number;
		highlightLines?: number[];
		showLineNumbers?: boolean;
	},
): Promise<string> {
	const highlighter = await getHighlighter();

	const { startLine = 1, highlightLines, showLineNumbers } = options ?? {};
	const needsTransformer = showLineNumbers || highlightLines?.length;

	// For unsupported or 'text' language, return plain text with optional line info
	if (lang === 'text') {
		return buildPlainHtml(escapeHtml(code), startLine, highlightLines, showLineNumbers);
	}

	const themesMap: Record<string, string> = {};
	for (const t of CODE_THEMES) themesMap[t] = t;

	try {
		const html = highlighter.codeToHtml(code, {
			lang,
			themes: themesMap,
			// defaultColor: false → no top-level color attr; everything goes
			// through --shiki-{theme} CSS vars + the [data-code-theme] selectors
			// in app.css.
			defaultColor: false,
			cssVariablePrefix: '--shiki-',
			transformers: needsTransformer
				? [
						{
							line(node: any, line: number) {
								const lineNum = line + startLine - 1;
								const classes: string[] = ['line'];
								if (showLineNumbers) {
									node.properties['data-line'] = lineNum;
									classes.push('has-line-number');
								}
								if (highlightLines?.includes(lineNum)) {
									classes.push('highlighted');
								}
								node.properties['class'] = classes.join(' ');
							},
						},
					]
				: undefined,
		});
		return html;
	} catch {
		return buildPlainHtml(escapeHtml(code), startLine, highlightLines, showLineNumbers);
	}
}

function buildPlainHtml(
	escapedCode: string,
	startLine: number,
	highlightLines?: number[],
	showLineNumbers?: boolean,
): string {
	if (!showLineNumbers && !highlightLines?.length) {
		return `<pre class="shiki"><code>${escapedCode}</code></pre>`;
	}
	const lines = escapedCode.split('\n');
	const html = lines
		.map((line, i) => {
			const lineNum = startLine + i;
			const classes = [
				'line',
				showLineNumbers ? 'has-line-number' : '',
				highlightLines?.includes(lineNum) ? 'highlighted' : '',
			]
				.filter(Boolean)
				.join(' ');
			const dataAttr = showLineNumbers ? ` data-line="${lineNum}"` : '';
			return `<span class="${classes}"${dataAttr}>${line}</span>`;
		})
		.join('\n');
	return `<pre class="shiki"><code>${html}</code></pre>`;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}
