import { createHighlighter, type Highlighter, type BundledLanguage } from 'shiki';

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
  theme: 'dark' | 'light' = 'dark'
): Promise<string> {
  const highlighter = await getHighlighter();
  const themeName = theme === 'dark' ? 'github-dark' : 'github-light';

  // For unsupported or 'text' language, return plain text
  if (lang === 'text') {
    return `<pre class="shiki" style="background-color: ${theme === 'dark' ? '#24292e' : '#fff'}"><code>${escapeHtml(code)}</code></pre>`;
  }

  try {
    return highlighter.codeToHtml(code, {
      lang: lang as BundledLanguage,
      theme: themeName
    });
  } catch {
    // Fallback to plain text if language not supported
    return `<pre class="shiki" style="background-color: ${theme === 'dark' ? '#24292e' : '#fff'}"><code>${escapeHtml(code)}</code></pre>`;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Parsed documentation segment
export type DocSegment =
  | { type: 'text'; content: string }
  | { type: 'code'; content: string; lang: SupportedLanguage };

// Parse documentation string into segments (text and code blocks)
export function parseDocumentation(
  docs: string,
  defaultLang: SupportedLanguage = 'rust'
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
        segments.push({ type: 'text', content: text });
      }
    }

    // Add code block
    const lang = match[1] ? normalizeLanguage(match[1]) : defaultLang;
    const code = match[2].trim();
    if (code) {
      segments.push({ type: 'code', content: code, lang });
    }

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text after last code block
  if (lastIndex < docs.length) {
    const text = docs.slice(lastIndex).trim();
    if (text) {
      segments.push({ type: 'text', content: text });
    }
  }

  // If no segments were created, treat the whole thing as text
  if (segments.length === 0 && docs.trim()) {
    segments.push({ type: 'text', content: docs.trim() });
  }

  return segments;
}

// Highlight all code blocks in parsed documentation
export async function highlightDocumentation(
  segments: DocSegment[],
  theme: 'dark' | 'light' = 'dark'
): Promise<Array<{ type: 'text' | 'code'; content: string; html?: string }>> {
  return Promise.all(
    segments.map(async (segment) => {
      if (segment.type === 'code') {
        const html = await highlightCode(segment.content, segment.lang, theme);
        return { type: 'code' as const, content: segment.content, html };
      }
      return { type: 'text' as const, content: segment.content };
    })
  );
}
