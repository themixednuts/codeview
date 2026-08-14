# Agents

SvelteKit 3, Effect v4, Cloudflare via Alchemy, Better Auth, Drizzle, Tailwind v4, shadcn-svelte, Vite+, pnpm. Celld is an optional self-hosted host instead of Cloudflare.

App imports use `#lib`. Kit config lives in `codeview-ui/vite.config.ts`. The host lives in `codeview-ui/alchemy.run.ts`. Auth, sqlite, and bindings share one Effect runtime through Alchemy. Pages are shadcn plus Tailwind, progressive enhancement, remote functions with Effect Schema.

Local `codeview ui` still builds a sidecar with `@jesterkit/exe-sveltekit`. Alchemy injects the Cloudflare adapter for hosted builds.

Follow the effect skill. Follow create-webapp conventions when adding packages or rewriting config.

Anti-slop oxlint rules stay at error. Existing TypeScript still has hundreds of findings (object parameters, type assertions, known-value widening). New code should pass. Do not turn the rules off.
