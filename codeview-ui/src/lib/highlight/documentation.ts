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

// Parse documentation string into segments (text and code blocks)
export function parseDocumentation(
  docs: string,
  defaultLang: SupportedLanguage = 'rust',
  docLinks?: DocLinks
): DocSegment[] {
  const segments: DocSegment[] = [];
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;

  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(docs)) !== null) {
    // Add text before this code block
    if (match.index > lastIndex) {
      const text = docs.slice(lastIndex, match.index).trim();
      if (text) {
        segments.push({ type: 'text', content: text, html: renderMarkdown(text, docLinks) });
      }
    }

    // Add code block
    const lang = match[1] ? normalizeLanguage(match[1]) : defaultLang;
    let code = match[2].trim();

    // Process Rust doc code to handle hidden lines (# prefix)
    if (lang === 'rust') {
      code = processRustDocCode(code);
    }

    if (code) {
      segments.push({ type: 'code', content: code, lang });
    }

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text after last code block
  if (lastIndex < docs.length) {
    const text = docs.slice(lastIndex).trim();
    if (text) {
      segments.push({ type: 'text', content: text, html: renderMarkdown(text, docLinks) });
    }
  }

  // If no segments were created, treat the whole thing as text
  if (segments.length === 0 && docs.trim()) {
    const text = docs.trim();
    segments.push({ type: 'text', content: text, html: renderMarkdown(text, docLinks) });
  }

  return segments;
}

// Highlight all code blocks in parsed documentation
export async function highlightDocumentation(
  segments: DocSegment[],
  theme: 'dark' | 'light' = 'dark'
): Promise<Array<{ type: 'text' | 'code'; content: string; html: string }>> {
  return Promise.all(
    segments.map(async (segment) => {
      if (segment.type === 'code') {
        const html = await highlightCode(segment.content, segment.lang, theme);
        return { type: 'code' as const, content: segment.content, html };
      }
      // Text segments already have HTML from markdown-it
      return { type: 'text' as const, content: segment.content, html: segment.html };
    })
  );
}
