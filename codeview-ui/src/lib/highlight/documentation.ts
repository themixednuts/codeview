import type { SupportedLanguage } from './shiki';
import { normalizeLanguage, highlightCode } from './shiki';
import { renderMarkdown, type DocLinks } from './markdown';

/**
 * Rustdoc code-fence attributes that imply Rust code.
 *
 * Rustdoc allows fences like ` ```edition2021 `, ` ```no_run `,
 * ` ```rust,ignore,edition2021 `, ` ```compile_fail,E0308 `, etc.
 * These are NOT language names — they're compilation/display directives.
 * We need to recognize them so `processRustDocCode()` strips hidden `# ` lines.
 */
const RUSTDOC_ATTRS = new Set(['no_run', 'ignore', 'compile_fail', 'should_panic', 'test_harness']);

/** Token is a rustdoc edition flag like `edition2021`. */
const EDITION_RE = /^edition\d{4}$/;
/** Token is a rustdoc error code like `E0308`. */
const ERROR_CODE_RE = /^e\d+$/;

/**
 * Known non-Rust languages we can highlight.
 * Tokens not in this set and not a rustdoc attr are ignored
 * (unknown rustdoc attrs, error codes, etc.) rather than
 * incorrectly treated as a language name.
 */
const KNOWN_NON_RUST_LANGS = new Set([
	'typescript',
	'ts',
	'javascript',
	'js',
	'json',
	'toml',
	'bash',
	'sh',
	'shell',
	'zsh',
	'sql',
	'text',
	'plaintext',
	'txt',
	'c',
	'cpp',
	'python',
	'py',
	'html',
	'css',
	'xml',
	'yaml',
	'yml',
	'markdown',
	'md',
]);

function isRustdocAttr(part: string): boolean {
	return RUSTDOC_ATTRS.has(part) || EDITION_RE.test(part) || ERROR_CODE_RE.test(part);
}

/**
 * Parse a rustdoc code-fence info string into a language for highlighting
 * and whether `processRustDocCode` should be applied.
 *
 * Examples:
 *   ""                        → { lang: defaultLang, isRust: true }
 *   "rust"                    → { lang: 'rust',      isRust: true }
 *   "edition2021"             → { lang: 'rust',      isRust: true }
 *   "rust,no_run,edition2021" → { lang: 'rust',      isRust: true }
 *   "compile_fail,E0308"      → { lang: 'rust',      isRust: true }
 *   "json"                    → { lang: 'json',      isRust: false }
 *   "text"                    → { lang: 'text',      isRust: false }
 *   "ignore"                  → { lang: 'rust',      isRust: true }
 */
function parseRustdocFenceInfo(
	infoStr: string,
	defaultLang: SupportedLanguage,
): { lang: SupportedLanguage; isRust: boolean } {
	const raw = infoStr.trim();
	if (!raw) return { lang: defaultLang, isRust: defaultLang === 'rust' };

	// Split on commas — rustdoc uses `rust,no_run,edition2021` style
	const parts = raw.split(',').map((p) => p.trim().toLowerCase());

	let explicitLang: SupportedLanguage | null = null;
	let hasRustdocAttr = false;
	let hasExplicitRust = false;

	for (const part of parts) {
		if (!part) continue;
		if (part === 'rust' || part === 'rs') {
			hasExplicitRust = true;
		} else if (isRustdocAttr(part)) {
			hasRustdocAttr = true;
		} else if (KNOWN_NON_RUST_LANGS.has(part)) {
			explicitLang = normalizeLanguage(part);
		}
		// else: unknown token — silently ignored (not treated as a language)
	}

	// Explicitly "rust" or has rustdoc attrs with no other language → Rust
	if (hasExplicitRust || (hasRustdocAttr && !explicitLang)) {
		return { lang: 'rust', isRust: true };
	}

	// Rustdoc attrs + explicit non-Rust language (unusual, e.g. `json,ignore`)
	if (hasRustdocAttr && explicitLang) {
		return { lang: explicitLang, isRust: false };
	}

	// Recognized non-Rust language
	if (explicitLang) {
		return { lang: explicitLang, isRust: false };
	}

	// Unrecognized single token — in a Rust project, default to Rust
	if (defaultLang === 'rust') {
		return { lang: 'rust', isRust: true };
	}

	const lang = normalizeLanguage(raw);
	return { lang, isRust: lang === 'rust' };
}

/**
 * Process Rust doc code to handle hidden lines according to rustdoc conventions.
 *
 * Rules (matching docs.rs/rustdoc behavior):
 * - Lines starting with `# ` (hash + space) are hidden
 * - Lines that are exactly `#` are hidden
 * - Lines starting with `##` have the first `#` removed (escape to show literal `#`)
 * - Lines starting with `#!` or `#[` are NOT hidden (these are attributes)
 *
 * @param code The raw code from documentation
 * @returns Processed code with hidden lines removed and escapes handled
 */
export function processRustDocCode(code: string): string {
	const lines = code.split('\n');
	const processedLines: string[] = [];

	for (const line of lines) {
		const trimmed = line.trimStart();
		const leadingWhitespace = line.slice(0, line.length - trimmed.length);

		// Check for hidden line patterns
		if (trimmed === '#') {
			// Standalone `#` - hidden
			continue;
		}

		if (trimmed.startsWith('# ')) {
			// `# ` prefix - hidden (but NOT `#!` or `#[`)
			continue;
		}

		// Check for escape sequence `##` -> `#`
		if (trimmed.startsWith('##')) {
			// Remove one `#` to show literal hash
			processedLines.push(leadingWhitespace + trimmed.slice(1));
			continue;
		}

		// Lines starting with `#!` or `#[` are attributes - keep them
		// All other lines are kept as-is
		processedLines.push(line);
	}

	return processedLines.join('\n');
}

// Parsed documentation segment
export type DocSegment =
	| { type: 'text'; content: string; html: string }
	| { type: 'code'; content: string; lang: SupportedLanguage };

const CODE_PLACEHOLDER_PREFIX = '\n<div data-code-placeholder="';
const CODE_PLACEHOLDER_SUFFIX = '"></div>\n';

/**
 * Parse documentation into segments.
 *
 * Renders the full markdown document as one piece so that reference-style
 * link definitions (e.g. `[1]: url`) resolve correctly across the whole doc.
 * Code blocks are replaced with placeholders during markdown rendering, then
 * extracted as separate segments so Shiki can highlight them.
 */
export function parseDocumentation(
	docs: string,
	defaultLang: SupportedLanguage = 'rust',
	docLinks?: DocLinks,
): DocSegment[] {
	// Capture the full info string after ``` (handles commas: `rust,no_run,edition2021`)
	const codeBlockRegex = /```([^\n]*)\n([\s\S]*?)```/g;
	const codeBlocks: { lang: SupportedLanguage; code: string }[] = [];

	// Replace code blocks with placeholders, keeping the rest of the markdown
	// intact so reference link definitions resolve globally.
	const withPlaceholders = docs.replace(
		codeBlockRegex,
		(_match, infoStr: string, rawCode: string) => {
			const { lang, isRust } = parseRustdocFenceInfo(infoStr, defaultLang);
			let code = rawCode.trim();
			if (isRust) code = processRustDocCode(code);
			const idx = codeBlocks.length;
			codeBlocks.push({ lang, code });
			return `${CODE_PLACEHOLDER_PREFIX}${idx}${CODE_PLACEHOLDER_SUFFIX}`;
		},
	);

	// Render the full document with markdown-it (references resolve globally)
	const fullHtml = renderMarkdown(withPlaceholders, docLinks);

	// Split the rendered HTML at placeholder boundaries
	const segments: DocSegment[] = [];
	const placeholderRegex = /<div data-code-placeholder="(\d+)"><\/div>/g;
	let lastIndex = 0;
	let match;

	while ((match = placeholderRegex.exec(fullHtml)) !== null) {
		// Text segment before this code block
		if (match.index > lastIndex) {
			const html = fullHtml.slice(lastIndex, match.index).trim();
			if (html) {
				segments.push({ type: 'text', content: '', html });
			}
		}

		// Code segment
		const block = codeBlocks[parseInt(match[1])];
		if (block && block.code) {
			segments.push({ type: 'code', content: block.code, lang: block.lang });
		}

		lastIndex = match.index + match[0].length;
	}

	// Remaining text after the last code block
	if (lastIndex < fullHtml.length) {
		const html = fullHtml.slice(lastIndex).trim();
		if (html) {
			segments.push({ type: 'text', content: '', html });
		}
	}

	// No code blocks — treat the whole thing as text
	if (segments.length === 0 && docs.trim()) {
		segments.push({ type: 'text', content: '', html: fullHtml });
	}

	return segments;
}

// Highlight all code blocks in parsed documentation
export async function highlightDocumentation(
	segments: DocSegment[],
	theme: 'dark' | 'light' = 'dark',
): Promise<Array<{ type: 'text' | 'code'; content: string; html: string }>> {
	return Promise.all(
		segments.map(async (segment) => {
			if (segment.type === 'code') {
				const html = await highlightCode(segment.content, segment.lang, theme);
				return { type: 'code' as const, content: segment.content, html };
			}
			// Text segments already have HTML from markdown-it
			return { type: 'text' as const, content: segment.content, html: segment.html };
		}),
	);
}
