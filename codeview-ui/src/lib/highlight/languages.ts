export type SupportedLanguage =
  | "rust"
  | "typescript"
  | "javascript"
  | "json"
  | "toml"
  | "bash"
  | "sql"
  | "text";

export type ProjectType = "rust" | "typescript" | "javascript";

function languageAlias(lang: string): SupportedLanguage | undefined {
  switch (lang) {
    case "rs":
      return "rust";
    case "ts":
      return "typescript";
    case "js":
      return "javascript";
    case "sh":
    case "shell":
    case "zsh":
      return "bash";
    case "plaintext":
    case "txt":
    case "":
      return "text";
    default:
      return undefined;
  }
}

const defaultLanguages = {
  rust: "rust",
  typescript: "typescript",
  javascript: "javascript",
} as const satisfies { [K in ProjectType]: SupportedLanguage };

function isSupportedLanguage(lang: string): lang is SupportedLanguage {
  switch (lang) {
    case "rust":
    case "typescript":
    case "javascript":
    case "json":
    case "toml":
    case "bash":
    case "sql":
    case "text":
      return true;
    default:
      return false;
  }
}

export function normalizeLanguage(lang: string): SupportedLanguage {
  const lower = lang.toLowerCase().trim();
  return languageAlias(lower) ?? (isSupportedLanguage(lower) ? lower : "text");
}

export function getDefaultLanguage(projectType: ProjectType = "rust"): SupportedLanguage {
  return defaultLanguages[projectType];
}
