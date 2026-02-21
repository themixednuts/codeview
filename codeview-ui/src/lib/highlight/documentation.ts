import type { SupportedLanguage } from './shiki';
import { normalizeLanguage, highlightCode } from './shiki';
import { renderMarkdown, type DocLinks } from './markdown';

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
	const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
	const codeBlocks: { lang: SupportedLanguage; code: string }[] = [];

	// Replace code blocks with placeholders, keeping the rest of the markdown
	// intact so reference link definitions resolve globally.
	const withPlaceholders = docs.replace(
		codeBlockRegex,
		(_match, langStr: string, rawCode: string) => {
			const lang = langStr ? normalizeLanguage(langStr) : defaultLang;
			let code = rawCode.trim();
			if (lang === 'rust') code = processRustDocCode(code);
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
