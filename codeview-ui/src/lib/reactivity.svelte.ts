export type MemoOptions<T> = {
	equals?: (a: T, b: T) => boolean;
};

export type KeyedMemoOptions<K, T = unknown> = {
	equalsKey?: (a: K, b: K) => boolean;
	/** Optional output equality check. When the key changes but compute produces
	 *  an equivalent result, the cached reference is returned to prevent
	 *  downstream re-renders. */
	equalsValue?: (a: T, b: T) => boolean;
};

export function arrayEqual<T>(
	a: readonly T[],
	b: readonly T[],
	equals: (a: T, b: T) => boolean = Object.is
): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (!equals(a[i], b[i])) return false;
	}
	return true;
}

export function setEqual<T>(a: Set<T>, b: Set<T>): boolean {
	if (a.size !== b.size) return false;
	for (const v of a) {
		if (!b.has(v)) return false;
	}
	return true;
}

export function mapEqual<K, V>(a: Map<K, V>, b: Map<K, V>): boolean {
	if (a.size !== b.size) return false;
	for (const [k, v] of a) {
		if (!b.has(k) || !Object.is(b.get(k), v)) return false;
	}
	return true;
}

/** Shallow comparison for arrays, objects, Sets, and Maps (1 level deep).
 *  For plain objects, array-valued properties are compared element-wise. */
export function shallowEqual<T>(a: T, b: T): boolean {
	if (Object.is(a, b)) return true;
	if (a == null || b == null) return false;
	if (typeof a !== 'object' || typeof b !== 'object') return false;

	if (Array.isArray(a) && Array.isArray(b)) {
		return arrayEqual(a, b);
	}

	if (a instanceof Set && b instanceof Set) {
		return setEqual(a, b);
	}

	if (a instanceof Map && b instanceof Map) {
		return mapEqual(a, b);
	}

	// Plain object — values compared by Object.is, arrays compared element-wise
	const ka = Object.keys(a as object);
	const kb = Object.keys(b as object);
	if (ka.length !== kb.length) return false;
	for (const k of ka) {
		const va = (a as any)[k];
		const vb = (b as any)[k];
		if (Array.isArray(va) && Array.isArray(vb)) {
			if (!arrayEqual(va, vb)) return false;
		} else if (!Object.is(va, vb)) return false;
	}
	return true;
}

export function keyOf(...parts: readonly unknown[]): readonly unknown[] {
	return parts;
}

export function keyEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (Array.isArray(a) && Array.isArray(b)) {
		return arrayEqual(a, b, keyEqual);
	}
	if (a instanceof Set && b instanceof Set) {
		return setEqual(a, b);
	}
	if (a instanceof Map && b instanceof Map) {
		return mapEqual(a, b);
	}
	return false;
}

/** Memoized derived value with output-equality stabilization.
 *  Returns the cached reference when `equals()` says the result hasn't changed. */
export class Memo<T> {
	#compute: () => T;
	#equals: (a: T, b: T) => boolean;
	#hasCached = false;
	#cachedValue: T = undefined as T;

	readonly current: T = $derived.by(() => {
		const next = this.#compute();
		if (this.#hasCached && this.#equals(this.#cachedValue, next)) {
			return this.#cachedValue;
		}
		this.#hasCached = true;
		this.#cachedValue = next;
		return next;
	});

	constructor(
		compute: () => T,
		equalsOrOptions: ((a: T, b: T) => boolean) | MemoOptions<T> = shallowEqual
	) {
		this.#compute = compute;
		if (typeof equalsOrOptions === 'function') {
			this.#equals = equalsOrOptions;
		} else {
			this.#equals = equalsOrOptions.equals ?? shallowEqual;
		}
	}
}

/** Memoized derived value with input-key stabilization.
 *  Skips `compute()` entirely when the key hasn't changed.
 *  Optionally also stabilizes output (like Memo) when `equalsValue` is provided. */
export class KeyedMemo<T, K = unknown> {
	#key: () => K;
	#compute: () => T;
	#equalsKey: (a: K, b: K) => boolean;
	#equalsValue: ((a: T, b: T) => boolean) | null;
	#hasCached = false;
	#cachedKey: K = undefined as K;
	#cachedValue: T = undefined as T;

	readonly current: T = $derived.by(() => {
		const k = this.#key();
		if (this.#hasCached && this.#equalsKey(this.#cachedKey, k)) {
			return this.#cachedValue;
		}
		this.#cachedKey = k;
		const next = this.#compute();
		if (this.#hasCached && this.#equalsValue?.(this.#cachedValue, next)) {
			return this.#cachedValue;
		}
		this.#hasCached = true;
		this.#cachedValue = next;
		return next;
	});

	constructor(
		key: () => K,
		compute: () => T,
		equalsKeyOrOptions: ((a: K, b: K) => boolean) | KeyedMemoOptions<K, T> = Object.is
	) {
		this.#key = key;
		this.#compute = compute;
		if (typeof equalsKeyOrOptions === 'function') {
			this.#equalsKey = equalsKeyOrOptions;
			this.#equalsValue = null;
		} else {
			this.#equalsKey = equalsKeyOrOptions.equalsKey ?? Object.is;
			this.#equalsValue = equalsKeyOrOptions.equalsValue ?? null;
		}
	}
}
