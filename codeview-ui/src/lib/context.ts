import { panic } from 'better-result';
import { getContext, setContext, hasContext } from 'svelte';
import type { ParseProgressConnection } from '$lib/realtime';
import type { NodeSummary } from '$lib/schema';

/**
 * Type-safe reactive context. Stores a getter function internally so
 * primitive $state values stay reactive, but consumers just call `.get()`
 * to read the current value — no double-call needed.
 *
 *   // provider
 *   let theme = $state<Theme>('light');
 *   themeCtx.set(() => theme);
 *
 *   // consumer
 *   const theme = $derived(themeCtx.get());
 */
class ReactiveContext<T> {
	#key: symbol;
	#name: string;

	constructor(name: string) {
		this.#name = name;
		this.#key = Symbol(name);
	}

	/** Set a getter that will be called when consumers read this context. */
	set(getter: () => T): void {
		setContext(this.#key, getter);
	}

	/** Read the current value. Must be called during component init. */
	get(): T {
		const getter = getContext<(() => T) | undefined>(this.#key);
		if (getter === undefined) {
			panic(`Context "${this.#name}" not found`);
		}
		return getter();
	}

	/** Read the current value, or return fallback if not set. */
	getOr(fallback: T): T {
		if (!hasContext(this.#key)) return fallback;
		const getter = getContext<(() => T) | undefined>(this.#key);
		return getter ? getter() : fallback;
	}
}

export type Theme = 'light' | 'dark' | 'system';
/** The effective theme after resolving 'system' to the OS preference. */
export type ResolvedTheme = 'light' | 'dark';
export type ExternalLinkMode = 'codeview' | 'docs';
export type SourceProviderMode = 'auto' | 'crates-io' | 'github';
export type CrateStatusValue = 'unknown' | 'processing' | 'ready' | 'failed';
export type VcsMode = 'git' | 'jj';

/** Solarized-based accent family — swaps `--accent`, `--accent-strong`, etc. */
export type AccentMode = 'orange' | 'cobalt' | 'forest' | 'plum' | 'char';

/** Spacing/density scale — drives `--density` + `--base-fs`. */
export type DensityMode = 'compact' | 'comfortable' | 'spacious';

/**
 * Typographic register.
 * - editorial: Fraunces display + Inter body (default)
 * - technical: IBM Plex Sans (tight weights), no serif display
 * - geometric: Space Grotesk everywhere
 */
export type VoiceMode = 'editorial' | 'technical' | 'geometric';

/** Documentation center-pane layout. */
export type DocLayoutMode = 'classic' | 'reading' | 'split';

/** Code theme — fully specified in app.css via [data-code-theme="..."]. */
export type CodeTheme =
	| 'solarized-light'
	| 'solarized-dark'
	| 'catppuccin-latte'
	| 'catppuccin-mocha'
	| 'one-light'
	| 'one-dark'
	| 'github-light'
	| 'github-dark';

// --- Root layout contexts ---
export const themeCtx = new ReactiveContext<Theme>('theme');
export const resolvedThemeCtx = new ReactiveContext<ResolvedTheme>('resolvedTheme');
export const accentModeCtx = new ReactiveContext<AccentMode>('accentMode');
export const densityModeCtx = new ReactiveContext<DensityMode>('densityMode');
export const voiceModeCtx = new ReactiveContext<VoiceMode>('voiceMode');
export const docLayoutCtx = new ReactiveContext<DocLayoutMode>('docLayout');
export const codeThemeLightCtx = new ReactiveContext<CodeTheme>('codeThemeLight');
export const codeThemeDarkCtx = new ReactiveContext<CodeTheme>('codeThemeDark');
export const extLinkModeCtx = new ReactiveContext<ExternalLinkMode>('extLinkMode');
export const sourceProviderModeCtx = new ReactiveContext<SourceProviderMode>('sourceProviderMode');
export const vcsModeCtx = new ReactiveContext<VcsMode>('vcsMode');
export const editorSchemeCtx = new ReactiveContext<string>('editorScheme');

// --- Crate layout contexts ---
export const getNodeUrlCtx = new ReactiveContext<(id: string) => string>('getNodeUrl');
export const crateVersionsCtx = new ReactiveContext<Record<string, string>>('crateVersions');
export const crateStatusCtx = new ReactiveContext<CrateStatusValue>('crateStatus');
/** Parse progress connection - properties are reactive via $state */
export const parseProgressCtx = new ReactiveContext<ParseProgressConnection | null>(
	'parseProgress',
);

/** Ancestor IDs from nodeView — tells GraphTree which nodes to expand. */
export type ExpandPath = {
	ancestors: NodeSummary[];
} | null;
export const expandPathCtx = new ReactiveContext<ExpandPath>('expandPath');
export const setExpandPathCtx = new ReactiveContext<(path: ExpandPath) => void>('setExpandPath');

/** Reactive URL search params singleton for tree state (shared layout ↔ GraphTree). */
export const treeParamsCtx = new ReactiveContext<
	import('svelte/reactivity').SvelteURLSearchParams | null
>('treeParams');
