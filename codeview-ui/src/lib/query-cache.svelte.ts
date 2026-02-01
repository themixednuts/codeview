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
 * Works with both the `.current`/`.loading` pattern and the `await` pattern:
 *
 *   // .current/.loading (alternative)
 *   const q = cached('topCrates', getTopCrates());
 *   const data = $derived(q.current ?? []);
 *
 *   // await + <svelte:boundary> (recommended)
 *   const data = $derived(await cached('topCrates', getTopCrates()));
 *
 * The proxy intercepts `.then()` so that `await` resolves immediately from
 * cache on back-navigation instead of showing the boundary's pending snippet.
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
export function cached<Q extends { current: unknown; loading: boolean }>(
	key: string,
	query: Q
): Q {
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
				if (_cache.has(key)) return _cache.get(key) as Q['current'];
				return fresh; // undefined (no cache yet — first visit)
			}

			if (prop === 'loading') {
				// Suppress loading state when cache can fill the gap
				return target.loading && !_cache.has(key);
			}

			if (prop === 'then') {
				// When cached data is available and the raw query is still loading,
				// resolve the thenable immediately so `await` doesn't block and
				// <svelte:boundary pending> is never shown on back-navigation.
				if (target.loading && _cache.has(key)) {
					return (onFulfilled?: (v: Q['current']) => unknown, onRejected?: (e: unknown) => unknown) =>
						Promise.resolve(_cache.get(key) as Q['current']).then(onFulfilled, onRejected);
				}
				// Otherwise forward to the real .then() (first visit or already resolved)
				const thenFn = Reflect.get(target, prop, target);
				if (typeof thenFn === 'function') return thenFn.bind(target);
				return thenFn;
			}

			// Forward everything else: .refresh(), .error, etc.
			const value = Reflect.get(target, prop, target);
			// Bind functions so they execute on the original target
			if (typeof value === 'function') return value.bind(target);
			return value;
		}
	});
}
