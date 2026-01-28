import { createHighlighter, type Highlighter, type BundledLanguage } from 'shiki';
import MarkdownIt from 'markdown-it';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';

// Type for resolved intra-doc links: link text -> node ID
export type DocLinks = Record<string, string>;

// Configure markdown-it: disable code blocks (we use Shiki), enable linkify
const md = new MarkdownIt({
  html: false,        // Disable HTML tags in source
  linkify: true,      // Auto-convert URLs to links
  typographer: true   // Smart quotes, dashes, etc.
}).disable(['code', 'fence']);  // We handle code blocks separately with Shiki

/**
 * Markdown-it plugin for Rust intra-doc links.
 *
 * Matches rustdoc's bracket syntax:
 * - [path::To::Item] - simple reference (resolved via doc_links)
 * - [`path::To::Item`] - with backticks (code formatting)
 *
 * The plugin stores doc_links in md.options for access during rendering.
 */
function intraDocLinksPlugin(md: MarkdownIt): void {
  // Add inline rule for intra-doc links BEFORE backticks are processed
  // This ensures [`path::Item`] is matched before backticks convert the inner content
  md.inline.ruler.before('backticks', 'intra_doc_link', intraDocLinkRule);
}

/**
 * Inline rule to match [path::Item] or [`path::Item`] patterns
 * that are intra-doc links (not standard markdown links).
 */
function intraDocLinkRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  const max = state.posMax;

  // Must start with [
  if (state.src.charCodeAt(start) !== 0x5B /* [ */) {
    return false;
  }

  // Find the closing ]
  let pos = start + 1;
  let depth = 1;
  while (pos < max && depth > 0) {
    const ch = state.src.charCodeAt(pos);
    if (ch === 0x5B /* [ */) depth++;
    else if (ch === 0x5D /* ] */) depth--;
    pos++;
  }

  if (depth !== 0) return false;

  const closeBracket = pos - 1;
  let content = state.src.slice(start + 1, closeBracket);

  // Check it's not followed by ( or [ (that would be a standard link)
  if (pos < max) {
    const nextChar = state.src.charCodeAt(pos);
    if (nextChar === 0x28 /* ( */ || nextChar === 0x5B /* [ */) {
      return false;
    }
  }

  // Check for backticks: [`Foo`] -> display as code
  const hasBackticks = content.startsWith('`') && content.endsWith('`');
  // Display content (without backticks)
  const displayContent = hasBackticks ? content.slice(1, -1) : content;

  // Must contain valid identifier characters
  if (!/^[a-zA-Z_][\w:]*$/.test(displayContent)) {
    return false;
  }

  // Check if this is a known intra-doc link
  // doc_links keys may have backticks (e.g., "`postgres::Client`") or not
  const docLinks = (state.md.options as { docLinks?: DocLinks }).docLinks;

  if (!docLinks) {
    return false;
  }

  // Try lookup with original content first (may have backticks), then without
  let nodeId: string | undefined;
  if (content in docLinks) {
    nodeId = docLinks[content];
  } else if (displayContent in docLinks) {
    nodeId = docLinks[displayContent];
  }

  if (!nodeId) {
    return false;
  }

  if (!silent) {

    // Create link_open token
    let token = state.push('link_open', 'a', 1);
    token.attrs = [
      ['href', `#${nodeId}`],
      ['class', 'intra-doc-link'],
      ['data-node-id', nodeId]
    ];

    // Create code or text token for display content
    if (hasBackticks) {
      token = state.push('code_inline', 'code', 0);
      token.content = displayContent;
    } else {
      token = state.push('text', '', 0);
      token.content = displayContent;
    }

    // Create link_close token
    state.push('link_close', 'a', -1);
  }

  state.pos = pos;
  return true;
}

// Apply the intra-doc links plugin
md.use(intraDocLinksPlugin);

// Supported languages - extend this as needed
export type SupportedLanguage = 'rust' | 'typescript' | 'javascript' | 'json' | 'toml' | 'bash' | 'sql' | 'text';

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
  '': 'text'
};

// Default language per project type (extensible)
export type ProjectType = 'rust' | 'typescript' | 'javascript';

const defaultLanguages: Record<ProjectType, SupportedLanguage> = {
  rust: 'rust',
  typescript: 'typescript',
  javascript: 'javascript'
};

let highlighterPromise: Promise<Highlighter> | null = null;

// Lazy-load the highlighter with only the languages we need
async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ['github-dark', 'github-light'],
      langs: ['rust', 'typescript', 'javascript', 'json', 'toml', 'bash', 'sql']
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

// Highlight code with the given language
export async function highlightCode(
  code: string,
  lang: SupportedLanguage = 'rust',
  theme: 'dark' | 'light' = 'dark',
  options?: {
    startLine?: number;
    highlightLines?: number[];
    showLineNumbers?: boolean;
  }
): Promise<string> {
  const highlighter = await getHighlighter();
  const themeName = theme === 'dark' ? 'github-dark' : 'github-light';

  const { startLine = 1, highlightLines, showLineNumbers } = options ?? {};
  const needsTransformer = showLineNumbers || highlightLines?.length;

  // For unsupported or 'text' language, return plain text with optional line info
  if (lang === 'text') {
    return buildPlainHtml(escapeHtml(code), startLine, highlightLines, showLineNumbers);
  }

  try {
    const html = highlighter.codeToHtml(code, {
      lang: lang as BundledLanguage,
      theme: themeName,
      transformers: needsTransformer ? [{
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
        }
      }] : undefined
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
  showLineNumbers?: boolean
): string {
  if (!showLineNumbers && !highlightLines?.length) {
    return `<pre class="shiki"><code>${escapedCode}</code></pre>`;
  }
  const lines = escapedCode.split('\n');
  const html = lines.map((line, i) => {
    const lineNum = startLine + i;
    const classes = [
      'line',
      showLineNumbers ? 'has-line-number' : '',
      highlightLines?.includes(lineNum) ? 'highlighted' : ''
    ].filter(Boolean).join(' ');
    const dataAttr = showLineNumbers ? ` data-line="${lineNum}"` : '';
    return `<span class="${classes}"${dataAttr}>${line}</span>`;
  }).join('\n');
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

/**
 * Render markdown text to HTML using markdown-it.
 * Code blocks are disabled since we handle them separately with Shiki.
 *
 * @param text The markdown text to render
 * @param docLinks Optional map of intra-doc link text to node IDs
 */
export function renderMarkdown(text: string, docLinks?: DocLinks): string {
  // Store doc_links in options for the intra-doc-link plugin to access
  (md.options as { docLinks?: DocLinks }).docLinks = docLinks;
  return md.render(text);
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
