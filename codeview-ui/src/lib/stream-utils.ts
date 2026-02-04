export async function* mapAsync<T, U>(
	source: AsyncIterable<T>,
	mapper: (value: T) => U | Promise<U>
): AsyncIterable<U> {
	for await (const value of source) {
		yield await mapper(value);
	}
}

export async function* filterAsync<T>(
	source: AsyncIterable<T>,
	predicate: (value: T) => boolean | Promise<boolean>
): AsyncIterable<T> {
	for await (const value of source) {
		if (await predicate(value)) yield value;
	}
}

export async function* takeAsync<T>(
	source: AsyncIterable<T>,
	count: number
): AsyncIterable<T> {
	if (count <= 0) return;
	let remaining = count;
	for await (const value of source) {
		yield value;
		remaining -= 1;
		if (remaining <= 0) return;
	}
}

export async function forEachAsync<T>(
	source: AsyncIterable<T>,
	consumer: (value: T) => void | Promise<void>
): Promise<void> {
	for await (const value of source) {
		await consumer(value);
	}
}

