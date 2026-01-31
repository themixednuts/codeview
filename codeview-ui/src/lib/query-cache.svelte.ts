/**
 * Stale-while-revalidate wrapper for SvelteKit remote function queries.
 *
 * SvelteKit's query() cache is reference-counted: when a component unmounts,
 * its queries lose subscribers and the cache is evicted. On back navigation
 * the component re-mounts with .loading = true and .current = undefined,
 * causing a flash of loading state.
 *
 * `cached()` returns a Proxy that transparently wraps the query object,
 * serving cached data while the query re-fetches. All underlying properties
 * and methods (.refresh(), .error, thenable, etc.) are forwarded.
 *
 * Usage — drop-in replacement, no API change for consumers:
 *
 *   // before
 *   const q = getTopCrates();
 *
 *   // after
 *   const q = cached('topCrates', getTopCrates());
 *
 *   // consumers unchanged
 *   const data = $derived(q.current ?? []);
 *   const loading = $derived(q.loading);
 *
 * Data is never stale: once the query resolves (.loading = false), the fresh
 * result always wins — even if it's null or an empty array. The cache only
 * kicks in while .loading is true and .current is undefined.
 *
 * @see https://github.com/sveltejs/kit/issues/15039
 * @see https://github.com/sveltejs/kit/discussions/13897
 */

const _cache = new Map<string, unknown>();

/**
 * Wrap a SvelteKit query proxy with stale-while-revalidate caching.
 *
 * The returned Proxy intercepts `.current` and `.loading`:
 *  - `.current`: returns fresh data when the query has resolved; falls back to
 *    the last cached value while the query is still loading.
 *  - `.loading`: suppressed (returns false) when cached data is available.
 *
 * All other properties (.refresh(), .error, Symbol.toPrimitive, then(), etc.)
 * are forwarded to the underlying query via Reflect.get.
 *
 * Uses a plain Map (not SvelteMap) — Svelte's reactivity is driven by the
 * underlying query proxy's signals, not by cache writes.
 */
export function cached<T>(
	key: string,
	query: { current: T | undefined; loading: boolean; [k: string | symbol]: unknown }
): typeof query {
	return new Proxy(query, {
		get(target, prop, receiver) {
			if (prop === 'current') {
				const fresh = target.current;

				// Query has resolved — always use fresh result (never stale)
				if (!target.loading) {
					if (fresh !== undefined) _cache.set(key, fresh);
					return fresh;
				}

				// Still loading — serve cached data if we have it
				if (_cache.has(key)) return _cache.get(key) as T;
				return fresh; // undefined (no cache yet — first visit)
			}

			if (prop === 'loading') {
				// Suppress loading state when cache can fill the gap
				return target.loading && !_cache.has(key);
			}

			// Forward everything else: .refresh(), .error, .then(), etc.
			const value = Reflect.get(target, prop, receiver);
			// Bind functions so they execute on the original target
			if (typeof value === 'function') return value.bind(target);
			return value;
		}
	});
}
