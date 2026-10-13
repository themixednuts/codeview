const PARAGRAPH_SPLIT_RE = /\n\s*\n/;
const HEADING_RE = /^#{1,6}\s/;
const FENCE_RE = /^(```|~~~)/;
const HTML_BLOCK_RE = /^<[!a-zA-Z/]/;
const BADGE_LINE_RE = /^(\[?!\[[^\]]*\]\([^)]*\)\]?(\([^)]*\))?\s*)+$/;

/**
 * First prose paragraph of a rustdoc comment, still as Markdown.
 *
 * Crate docs usually open with `# Title`, a badge row or a code fence; a
 * summary built from the first raw paragraph showed those verbatim.
 */
export function firstDocParagraph(docs: string | null | undefined): string | null {
  if (!docs) return null;
  let inFence = false;
  for (const raw of docs.trim().split(PARAGRAPH_SPLIT_RE)) {
    const paragraph = raw.trim();
    if (!paragraph) continue;
    const fences = paragraph.split("\n").filter((line) => FENCE_RE.test(line.trim())).length;
    if (inFence || FENCE_RE.test(paragraph)) {
      if (fences % 2 === 1) inFence = !inFence;
      continue;
    }
    if (HEADING_RE.test(paragraph) || HTML_BLOCK_RE.test(paragraph)) continue;
    if (BADGE_LINE_RE.test(paragraph.replace(/\s+/g, " "))) continue;
    return paragraph;
  }
  return null;
}

/** Markdown inline syntax reduced to its visible text. */
export function stripInlineMarkdown(markdown: string): string {
  return (
    markdown
      // images, then links / reference links
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
      .replace(/\[`?([^\]`]+)`?\]/g, "$1")
      // code spans
      .replace(/`+([^`]+)`+/g, "$1")
      // emphasis
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/(^|[^\w*])\*(?!\s)([^*]+?)\*(?!\w)/g, "$1$2")
      .replace(/(^|[^\w_])_(?!\s)([^_]+?)_(?!\w)/g, "$1$2")
      // inline html
      .replace(/<\/?[a-zA-Z][^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** One-line plain-text summary for compact UI (graph pane, cards, meta tags). */
export function plainDocSummary(docs: string | null | undefined, maxLength = 220): string | null {
  const paragraph = firstDocParagraph(docs);
  if (!paragraph) return null;
  const text = stripInlineMarkdown(paragraph);
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}
