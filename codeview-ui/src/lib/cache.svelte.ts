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

type CacheEntry = {
	value: unknown;
	storedAt: number;
};

const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 200;

const _cache = new Map<string, CacheEntry>();

export type CacheKeyPart = string | number | boolean | null | undefined;

export function cacheKey(...parts: CacheKeyPart[]): string {
	return parts.map((part) => encodeURIComponent(String(part ?? ''))).join('|');
}

function isExpired(entry: CacheEntry, now: number) {
	return now - entry.storedAt > CACHE_TTL_MS;
}

function readCache(key: string): unknown | undefined {
	const entry = _cache.get(key);
	if (!entry) return undefined;
	const now = Date.now();
	if (isExpired(entry, now)) {
		_cache.delete(key);
		return undefined;
	}
	// Touch for LRU.
	_cache.delete(key);
	_cache.set(key, entry);
	return entry.value;
}

function writeCache(key: string, value: unknown) {
	_cache.set(key, { value, storedAt: Date.now() });
	pruneCache();
}

function pruneCache() {
	const now = Date.now();
	for (const [key, entry] of _cache) {
		if (isExpired(entry, now)) _cache.delete(key);
	}
	while (_cache.size > CACHE_MAX_ENTRIES) {
		const oldestKey = _cache.keys().next().value as string | undefined;
		if (!oldestKey) break;
		_cache.delete(oldestKey);
	}
}

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
				const cachedValue = readCache(key);
				const hasCache = cachedValue !== undefined;

				// Query has resolved — always use fresh result (never stale)
				if (!target.loading) {
					if (fresh !== undefined) writeCache(key, fresh);
					return fresh;
				}

				// Still loading — serve cached data if we have it
				if (hasCache) return cachedValue as Q['current'];
				return fresh; // undefined (no cache yet — first visit)
			}

			if (prop === 'loading') {
				// Suppress loading state when cache can fill the gap
				const cachedValue = readCache(key);
				return target.loading && cachedValue === undefined;
			}

			if (prop === 'then') {
				// When the query has already resolved, resolve immediately with
				// fresh data. This prevents $derived re-evaluation (triggered by
				// the query's reactive signals) from creating a new thenable that
				// causes <svelte:boundary> to re-suspend and flash stale content.
				if (!target.loading && target.current !== undefined) {
					return (onFulfilled?: (v: Q['current']) => unknown, onRejected?: (e: unknown) => unknown) =>
						Promise.resolve(target.current as Q['current']).then(onFulfilled, onRejected);
				}

				// Still loading but have cache — resolve immediately so `await`
				// doesn't block and <svelte:boundary pending> is never shown on
				// back-navigation.
				const cachedValue = readCache(key);
				if (cachedValue !== undefined) {
					return (onFulfilled?: (v: Q['current']) => unknown, onRejected?: (e: unknown) => unknown) =>
						Promise.resolve(cachedValue as Q['current']).then(onFulfilled, onRejected);
				}

				// First visit, no cache — forward to real .then() (will suspend)
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
