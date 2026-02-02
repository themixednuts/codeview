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

import { getLogger } from '$lib/log';

const log = getLogger('cache');

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
 * Create a synchronous thenable that calls onFulfilled immediately.
 *
 * Unlike `Promise.resolve(v).then(fn)` which schedules `fn` as a microtask,
 * this invokes `fn` within the `.then()` call itself. Svelte's boundary
 * detects the synchronous callback and skips the pending state entirely.
 */
function syncThenable<T>(value: T) {
	return (onFulfilled?: ((v: T) => unknown) | null, onRejected?: ((e: unknown) => unknown) | null) => {
		try {
			const result = onFulfilled ? onFulfilled(value) : value;
			return Promise.resolve(result);
		} catch (err) {
			if (onRejected) return Promise.resolve(onRejected(err));
			return Promise.reject(err);
		}
	};
}

/**
 * Wrap a SvelteKit query proxy with stale-while-revalidate caching.
 *
 * The returned Proxy intercepts `.current`, `.loading`, and `.then()`:
 *
 *  - `.current`: returns fresh data when resolved; falls back to the last
 *    cached value while the query is still loading.
 *  - `.loading`: suppressed (returns false) when cached data is available.
 *  - `.then()`: resolves synchronously from cache when possible; forwards
 *    to the real thenable (causing boundary suspension) only on first visit.
 *
 * All other properties (.refresh(), .error, etc.) are forwarded via Reflect.get.
 *
 * Uses a plain Map (not SvelteMap) — Svelte's reactivity is driven by the
 * underlying query proxy's signals, not by cache writes.
 */
export function cached<Q extends { current: unknown; loading: boolean }>(
	key: string,
	query: Q
): Q {
	// Readable label for logging (decode URI components)
	const tag = key.split('|').slice(1).map(decodeURIComponent).join('/') || key;

	return new Proxy(query, {
		get(target, prop, receiver) {
			if (prop === 'current') {
				const fresh = target.current;

				// Query has resolved — always use fresh result (never stale)
				if (!target.loading) {
					if (fresh !== undefined) writeCache(key, fresh);
					return fresh;
				}

				// Still loading — serve cached data if we have it
				const cachedValue = readCache(key);
				if (cachedValue !== undefined) return cachedValue as Q['current'];
				return fresh; // undefined (no cache yet — first visit)
			}

			if (prop === 'loading') {
				if (!target.loading) return false;
				// Suppress loading state when cache can fill the gap
				return readCache(key) === undefined;
			}

			if (prop === 'then') {
				const cachedValue = readCache(key);
				const hasCache = cachedValue !== undefined;

				// Resolved + cache exists → serve fresh data synchronously.
				// The cache check guards against SvelteKit query proxies that
				// carry stale .current from a previous parameter set before the
				// new fetch starts — if we've never cached this key, .current
				// belongs to a different query.
				if (!target.loading && target.current !== undefined && hasCache) {
					writeCache(key, target.current);
					log.debug`.then [${tag}] → sync (resolved + cached)`;
					return syncThenable(target.current as Q['current']);
				}

				// Loading + cache exists → serve cached data synchronously so
				// <svelte:boundary pending> is never shown on back-navigation.
				if (hasCache) {
					log.debug`.then [${tag}] → sync (loading, from cache)`;
					return syncThenable(cachedValue as Q['current']);
				}

				// No cache — first visit or stale query proxy. Forward to the
				// real thenable so the boundary suspends until correct data
				// arrives. Wrap resolution to populate cache for subsequent
				// reactive re-evaluations.
				log.debug`.then [${tag}] → suspend (no cache)`;
				const thenFn = Reflect.get(target, prop, target);
				if (typeof thenFn === 'function') {
					const bound = thenFn.bind(target);
					return (onFulfilled?: ((v: Q['current']) => unknown) | null, onRejected?: ((e: unknown) => unknown) | null) =>
						bound(
							(value: Q['current']) => {
								if (value !== undefined) writeCache(key, value);
								log.debug`.then [${tag}] resolved → cached`;
								return onFulfilled ? onFulfilled(value) : value;
							},
							onRejected
						);
				}
				return thenFn;
			}

			// Forward everything else: .refresh(), .error, etc.
			const value = Reflect.get(target, prop, target);
			if (typeof value === 'function') return value.bind(target);
			return value;
		}
	});
}
