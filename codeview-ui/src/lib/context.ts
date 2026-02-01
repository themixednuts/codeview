import { getContext, setContext, hasContext } from 'svelte';
import type { Edge, Node } from '$lib/graph';

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
			throw new Error(`Context "${this.#name}" not found`);
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

export type Theme = 'light' | 'dark';
export type ExternalLinkMode = 'codeview' | 'docs';

// --- Root layout contexts ---
export const themeCtx = new ReactiveContext<Theme>('theme');
export const extLinkModeCtx = new ReactiveContext<ExternalLinkMode>('extLinkMode');

// --- Crate layout contexts ---
export const getNodeUrlCtx = new ReactiveContext<(id: string, parent?: string) => string>('getNodeUrl');
export const crateVersionsCtx = new ReactiveContext<Record<string, string>>('crateVersions');
export const graphForDisplayCtx = new ReactiveContext<{ nodes: Node[]; edges: Edge[] } | null>('graphForDisplay');
