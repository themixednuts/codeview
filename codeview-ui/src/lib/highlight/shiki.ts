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

const solarizedLightContrastMap: Record<string, string> = {
	'#268bd2': '#1f6fa5',
	'#2aa198': '#176d68',
	'#657b83': '#4f656d',
	'#6c71c4': '#5359a8',
	'#859900': '#596800',
	'#93a1a1': '#556a72',
	'#b58900': '#856500',
	'#cb4b16': '#a93b0c',
	'#d33682': '#9f2861',
	'#dc322f': '#ad2422',
};

const solarizedDarkContrastMap: Record<string, string> = {
	'#268bd2': '#5fb3eb',
	'#2aa198': '#55bfb5',
	'#586e75': '#7f9296',
	'#6c71c4': '#a294de',
	'#859900': '#a3b900',
	'#b58900': '#d8ad32',
	'#cb4b16': '#ff9d66',
	'#d33682': '#e66aa6',
	'#dc322f': '#ff7b72',
};

// Solarized targets equal perceived lightness, but several accents fall below
// 4.5:1 against their editor background. Preserve the hue relationships while
// moving only the low-contrast token colors.
const readableSolarizedLight = {
	...solarizedLight,
	colors: {
		...solarizedLight.colors,
		'editor.background': '#f2ebd7',
	},
	tokenColors: solarizedLight.tokenColors?.map((token) => {
		const foreground = token.settings.foreground?.toLowerCase();
		return {
			...token,
			settings: {
				...token.settings,
				foreground: foreground
					? (solarizedLightContrastMap[foreground] ?? token.settings.foreground)
					: undefined,
			},
		};
	}),
};

const readableSolarizedDark = {
	...solarizedDark,
	colors: {
		...solarizedDark.colors,
		'editor.background': '#001f27',
	},
	tokenColors: solarizedDark.tokenColors?.map((token) => {
		const foreground = token.settings.foreground?.toLowerCase();
		return {
			...token,
			settings: {
				...token.settings,
				foreground: foreground
					? (solarizedDarkContrastMap[foreground] ?? token.settings.foreground)
					: undefined,
			},
		};
	}),
};

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

const CODE_THEME_BACKGROUNDS: Record<(typeof CODE_THEMES)[number], string> = {
	'solarized-light': '#f2ebd7',
	'solarized-dark': '#001f27',
	'catppuccin-latte': '#eff1f5',
	'catppuccin-mocha': '#1e1e2e',
	'one-light': '#fafafa',
	'one-dark': '#282c34',
	'github-light': '#ffffff',
	'github-dark': '#0d1117',
};

const MINIMUM_CODE_CONTRAST = 4.5;

let highlighterPromise: Promise<HighlighterCore> | null = null;

// Keep the browser bundle limited to the languages Codeview actually renders.
// Importing Shiki's umbrella entry emits every bundled grammar as an asset.
async function getHighlighter(): Promise<HighlighterCore> {
	if (!highlighterPromise) {
		highlighterPromise = createHighlighterCore({
			themes: [
				readableSolarizedLight,
				readableSolarizedDark,
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
		return enforceThemeContrast(html);
	} catch {
		return buildPlainHtml(escapeHtml(code), startLine, highlightLines, showLineNumbers);
	}
}

function enforceThemeContrast(html: string): string {
	let readableHtml = html;
	for (const theme of CODE_THEMES) {
		const token = theme.replaceAll('-', '\\-');
		const pattern = new RegExp(`(--shiki-${token}:)(#[\\da-f]{6})`, 'gi');
		const background = CODE_THEME_BACKGROUNDS[theme];
		readableHtml = readableHtml.replace(pattern, (_match, prefix: string, color: string) => {
			return `${prefix}${ensureContrast(color, background)}`;
		});
	}
	return readableHtml;
}

function ensureContrast(foreground: string, background: string): string {
	if (contrastRatio(foreground, background) >= MINIMUM_CODE_CONTRAST) {
		return foreground.toLowerCase();
	}

	const black = '#000000';
	const white = '#ffffff';
	const target =
		contrastRatio(black, background) > contrastRatio(white, background) ? black : white;
	let low = 0;
	let high = 1;
	for (let iteration = 0; iteration < 20; iteration += 1) {
		const midpoint = (low + high) / 2;
		const candidate = mixHex(foreground, target, midpoint);
		if (contrastRatio(candidate, background) >= MINIMUM_CODE_CONTRAST) high = midpoint;
		else low = midpoint;
	}

	const adjusted = mixHex(foreground, target, high);
	return contrastRatio(adjusted, background) >= MINIMUM_CODE_CONTRAST ? adjusted : target;
}

function mixHex(from: string, to: string, amount: number): string {
	const fromChannels = hexChannels(from);
	const toChannels = hexChannels(to);
	return `#${fromChannels
		.map((channel, index) =>
			Math.round(channel + (toChannels[index] - channel) * amount)
				.toString(16)
				.padStart(2, '0'),
		)
		.join('')}`;
}

function contrastRatio(foreground: string, background: string): number {
	const foregroundLuminance = relativeLuminance(foreground);
	const backgroundLuminance = relativeLuminance(background);
	return (
		(Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
		(Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
	);
}

function relativeLuminance(hex: string): number {
	const channels = hexChannels(hex).map((channel) => {
		const normalized = channel / 255;
		return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function hexChannels(hex: string): [number, number, number] {
	return [
		Number.parseInt(hex.slice(1, 3), 16),
		Number.parseInt(hex.slice(3, 5), 16),
		Number.parseInt(hex.slice(5, 7), 16),
	];
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
