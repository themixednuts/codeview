import { tick } from 'svelte';
import { getPerfLogger } from './log';

/**
 * Measures time from call until Svelte's `tick()` resolves (render commit).
 */
export function perfTick(cat: string, label: string): void {
	const t0 = performance.now();
	tick().then(() => {
		const dt = performance.now() - t0;
		getPerfLogger(cat).debug(`${label} ${dt.toFixed(0)}ms`);
	});
}

/**
 * Deduplicating tick tracker for use inside `$effect`.
 * Only measures a new tick when `key` changes.
 */
export function createTickTracker(cat: string, label: string) {
	let lastKey: unknown = undefined;
	return {
		track(key: unknown) {
			if (key !== lastKey) {
				lastKey = key;
				perfTick(cat, label);
			}
		}
	};
}
