export type { SupportedLanguage, ProjectType } from './languages';
export { normalizeLanguage, getDefaultLanguage } from './languages';
export { highlightCode } from './shiki';
export type { DocLinks } from './markdown';
export { renderMarkdown } from './markdown';
export type { DocSegment } from './documentation';
export { processRustDocCode, parseDocumentation, highlightDocumentation } from './documentation';
