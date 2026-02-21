import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import svelteParser from 'svelte-eslint-parser';
import tailwindcss from 'eslint-plugin-better-tailwindcss';
import globals from 'globals';

export default ts.config(
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs.recommended,
  tailwindcss.configs['recommended-warn'],
  {
    rules: {
      // We keep classes on single lines — disable line wrapping enforcement
      'better-tailwindcss/enforce-consistent-line-wrapping': 'off',
      // Class ordering is handled by prettier-plugin-tailwindcss if added later
      'better-tailwindcss/enforce-consistent-class-order': 'off',
      // We use custom @utility classes (badge, corner-squircle, etc.)
      'better-tailwindcss/no-unknown-classes': 'off',
      // Shorten arbitrary values: max-w-[150px] → max-w-37.5
      'better-tailwindcss/enforce-shorthand-classes': 'warn',
      // Shorten var() syntax: text-[var(--x)] → text-(--x)
      'better-tailwindcss/enforce-consistent-variable-syntax': 'warn',
    },
    settings: {
      'better-tailwindcss': {
        entryPoint: 'src/app.css',
      },
    },
  },
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        parser: ts.parser,
      },
    },
  },
  {
    rules: {
      // Allow unused vars prefixed with _
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Too noisy for Svelte $props() destructuring and quick prototyping
      '@typescript-eslint/no-explicit-any': 'off',
      // Allow empty functions (event handlers, stubs)
      '@typescript-eslint/no-empty-function': 'off',
      // Tagged template literals (log.debug`...`) and Svelte runes trigger false positives
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },
  {
    ignores: [
      '.svelte-kit/',
      '.wrangler/',
      'build/',
      'node_modules/',
      'src/lib/server/cloudflare/workers/dist/',
      'src/lib/server/db/migrations/',
    ],
  },
);
