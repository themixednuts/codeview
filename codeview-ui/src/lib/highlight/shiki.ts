import { createHighlighter, type Highlighter, type BundledLanguage } from 'shiki';
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

// Supported languages - extend this as needed
export type SupportedLanguage =
	| 'rust'
	| 'typescript'
	| 'javascript'
	| 'json'
	| 'toml'
	| 'bash'
	| 'sql'
	| 'text';

// Map of language aliases to canonical names
const languageAliases: Record<string, SupportedLanguage> = {
	rs: 'rust',
	ts: 'typescript',
	js: 'javascript',
	sh: 'bash',
	shell: 'bash',
	zsh: 'bash',
	plaintext: 'text',
	txt: 'text',
	'': 'text',
};

// Default language per project type (extensible)
export type ProjectType = 'rust' | 'typescript' | 'javascript';

const defaultLanguages: Record<ProjectType, SupportedLanguage> = {
	rust: 'rust',
	typescript: 'typescript',
	javascript: 'javascript',
};

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

let highlighterPromise: Promise<Highlighter> | null = null;

// Lazy-load the highlighter with the 8 themes the user can switch between.
async function getHighlighter(): Promise<Highlighter> {
	if (!highlighterPromise) {
		highlighterPromise = createHighlighter({
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
			langs: ['rust', 'typescript', 'javascript', 'json', 'toml', 'bash', 'sql'],
		});
	}
	return highlighterPromise;
}

// Normalize language identifier
export function normalizeLanguage(lang: string): SupportedLanguage {
	const lower = lang.toLowerCase().trim();
	return languageAliases[lower] ?? (lower as SupportedLanguage) ?? 'text';
}

// Get default language for a project type
export function getDefaultLanguage(projectType: ProjectType = 'rust'): SupportedLanguage {
	return defaultLanguages[projectType];
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
			lang: lang as BundledLanguage,
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
