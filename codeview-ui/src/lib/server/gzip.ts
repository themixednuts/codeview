export function decodeGzipStream(input: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	const gzipDecoder = new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
	return input.pipeThrough(gzipDecoder);
}
