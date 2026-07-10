import MarkdownIt from 'markdown-it';
import markdownItGithubAlerts from 'markdown-it-github-alerts';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';

// Type for resolved intra-doc links: link text -> node ID
export type DocLinks = Record<string, string>;
export type MarkdownCodeBlock = { info: string; content: string };
type RenderEnvironment = { docLinks?: DocLinks; codeBlocks?: MarkdownCodeBlock[] };

// Configure markdown-it with raw HTML disabled. Fenced/indented code is
// captured through renderer rules below when documentation is segmented.
const md = new MarkdownIt({
	html: false, // Rustdoc content is untrusted; render raw HTML as text.
	linkify: true, // Auto-convert URLs to links
	typographer: true, // Smart quotes, dashes, etc.
}).use(markdownItGithubAlerts); // GitHub-style alert blocks (> [!NOTE], etc.)

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
 * Inline rule to match shortcut links (`[path::Item]`, [`path::Item`]) and
 * rustdoc reference links (`[label][path::Item]`). The latter are not normal
 * Markdown references because rustdoc carries their targets in `Item.links`
 * instead of emitting reference definitions in the documentation string.
 */
function intraDocLinkRule(state: StateInline, silent: boolean): boolean {
	const start = state.pos;
	const max = state.posMax;

	// Must start with [
	if (state.src.charCodeAt(start) !== 0x5b /* [ */) {
		return false;
	}

	// Find the closing ]
	let pos = start + 1;
	let depth = 1;
	while (pos < max && depth > 0) {
		const ch = state.src.charCodeAt(pos);
		if (ch === 0x5b /* [ */) depth++;
		else if (ch === 0x5d /* ] */) depth--;
		pos++;
	}

	if (depth !== 0) return false;

	const closeBracket = pos - 1;
	const content = state.src.slice(start + 1, closeBracket);

	const docLinks = (state.env as RenderEnvironment | undefined)?.docLinks;
	if (!docLinks) return false;

	let lookupContent = content;
	let end = pos;
	// A normal inline Markdown destination is handled by markdown-it and then
	// resolved through the renderer hook below.
	if (pos < max) {
		const nextChar = state.src.charCodeAt(pos);
		if (nextChar === 0x28 /* ( */) return false;
		if (nextChar === 0x5b /* [ */) {
			const referenceEnd = state.src.indexOf(']', pos + 1);
			if (referenceEnd < 0) return false;
			lookupContent = state.src.slice(pos + 1, referenceEnd) || content;
			end = referenceEnd + 1;
		}
	}

	// Check for backticks: [`Foo`] -> display as code
	const hasBackticks = content.startsWith('`') && content.endsWith('`');
	// Display content (without backticks)
	const displayContent = hasBackticks ? content.slice(1, -1) : content;

	// Try the explicit reference target first, then shortcut-label variants.
	let nodeId: string | undefined;
	if (lookupContent in docLinks) {
		nodeId = docLinks[lookupContent];
	} else if (content in docLinks) {
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
			['data-node-id', nodeId],
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

	state.pos = end;
	return true;
}

// Apply the intra-doc links plugin
md.use(intraDocLinksPlugin);

const defaultFence = md.renderer.rules.fence;
const defaultCodeBlock = md.renderer.rules.code_block;

function captureCodeBlock(
	tokens: any[],
	idx: number,
	options: any,
	env: RenderEnvironment,
	self: any,
	fallback: NonNullable<typeof defaultFence>,
): string {
	if (!env.codeBlocks) return fallback(tokens, idx, options, env, self);

	const token = tokens[idx];
	const index =
		env.codeBlocks.push({
			info: token.info ?? '',
			content: token.content ?? '',
		}) - 1;
	return `<div data-codeview-code-block="${index}"></div>\n`;
}

md.renderer.rules.fence = (tokens, idx, options, env, self) =>
	captureCodeBlock(
		tokens,
		idx,
		options,
		env as RenderEnvironment,
		self,
		defaultFence ?? self.renderToken.bind(self),
	);

md.renderer.rules.code_block = (tokens, idx, options, env, self) =>
	captureCodeBlock(
		tokens,
		idx,
		options,
		env as RenderEnvironment,
		self,
		defaultCodeBlock ?? self.renderToken.bind(self),
	);

// Open external links in a new tab
const defaultLinkOpen =
	md.renderer.rules.link_open ||
	((tokens: any, idx: any, options: any, _env: any, self: any) =>
		self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (tokens: any, idx: any, options: any, env: any, self: any) => {
	const token = tokens[idx];
	const classAttr = token.attrGet('class') ?? '';

	if (!classAttr.includes('intra-doc-link')) {
		const href = token.attrGet('href') ?? '';
		const docLinks = (env as RenderEnvironment | undefined)?.docLinks;

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
	return md.render(text, { docLinks } satisfies RenderEnvironment);
}

export function renderMarkdownDocument(
	text: string,
	docLinks?: DocLinks,
): { html: string; codeBlocks: MarkdownCodeBlock[] } {
	const codeBlocks: MarkdownCodeBlock[] = [];
	const html = md.render(text, { docLinks, codeBlocks } satisfies RenderEnvironment);
	return { html, codeBlocks };
}
