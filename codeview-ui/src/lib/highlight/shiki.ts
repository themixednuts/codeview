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
