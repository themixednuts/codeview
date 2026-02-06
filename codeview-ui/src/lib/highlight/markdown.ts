import MarkdownIt from 'markdown-it';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';

// Type for resolved intra-doc links: link text -> node ID
export type DocLinks = Record<string, string>;

// Configure markdown-it: disable code blocks (we use Shiki), enable linkify
const md = new MarkdownIt({
  html: true,         // Allow HTML tags in source (common in Rust docs)
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

// Open external links in a new tab
const defaultLinkOpen =
	md.renderer.rules.link_open ||
	((tokens: any, idx: any, options: any, _env: any, self: any) => self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (tokens: any, idx: any, options: any, env: any, self: any) => {
	const token = tokens[idx];
	const classAttr = token.attrGet('class') ?? '';

	if (!classAttr.includes('intra-doc-link')) {
		const href = token.attrGet('href') ?? '';
		const docLinks = (md.options as { docLinks?: DocLinks }).docLinks;

		// Resolve rustdoc-style path links
		if (docLinks && href && href in docLinks) {
			const nodeId = docLinks[href];
			token.attrSet('href', `#${nodeId}`);
			token.attrSet('class', 'intra-doc-link');
			token.attrSet('data-node-id', nodeId);
		} else {
			token.attrSet('target', '_blank');
			token.attrSet('rel', 'noopener noreferrer');
		}
	}
	return defaultLinkOpen(tokens, idx, options, env, self);
};

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
