// ESLint runs only the @shadcn/lint design-system rules (`pnpm lint:shadcn`).
// Everything else is linted by Oxlint through `vp lint`. Oxlint's JS
// plugins only see Svelte <script> blocks, so markup classes need
// svelte-eslint-parser.
import { plugin as shadcn } from "@shadcn/lint";
import tsParser from "@typescript-eslint/parser";
import { defineConfig, globalIgnores } from "eslint/config";
import svelteParser from "svelte-eslint-parser";

// Plain CSS hooks styled in app.css or component <style> blocks (and the
// shadcn-svelte `cn-*` style markers). They are not Tailwind utilities.
const SEMANTIC_CLASSES = [
  "cn-*",
  "doc-*",
  "documentation",
  "documentation-*",
  "design-*",
  "relationship-edge__*",
  "token-*",
  "section-header",
  "sub-nav",
  "reading-toc",
  "tree-row-guide",
  "modal-source-actions",
  "split-source-actions",
  "no-scrollbar",
  "toaster",
];

const rules = {
  "shadcn/no-unknown-classes": ["error", { allow: SEMANTIC_CLASSES }],
  "shadcn/no-raw-colors": "error",
  "shadcn/require-static-classes": "error",
  // Warnings, not errors: the remaining hits are deliberate design choices
  // (chart geometry from data, intentional component restyling, off-scale
  // sizes). Treat them as design debt to burn down, and keep new code clean.
  "shadcn/no-arbitrary-values": "warn",
  "shadcn/no-inline-styles": "warn",
  "shadcn/no-restyle": ["warn", { allow: ["layout"] }],
};

export default defineConfig([
  globalIgnores([
    ".svelte-kit/**",
    ".wrangler/**",
    ".alchemy/**",
    "build/**",
    "dist/**",
    "node_modules/**",
    "src/lib/generated/**",
    "**/*.d.ts",
  ]),
  {
    // Disable comments in this repo target Oxlint and svelte-check.
    linterOptions: { reportUnusedDisableDirectives: "off" },
  },
  {
    files: ["src/**/*.svelte"],
    languageOptions: {
      parser: svelteParser,
      parserOptions: { parser: tsParser },
    },
    plugins: { shadcn },
    rules,
  },
  {
    files: ["src/**/*.{js,ts}"],
    languageOptions: { parser: tsParser },
    plugins: { shadcn },
    rules,
  },
  {
    // The design system's own components define the styling others reuse.
    files: ["src/lib/components/ui/**"],
    rules: {
      "shadcn/no-restyle": "off",
      "shadcn/require-static-classes": "off",
    },
  },
]);
