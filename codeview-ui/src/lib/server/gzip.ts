export function decodeGzipStream(
  input: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const ds = new DecompressionStream("gzip") as unknown as ReadableWritablePair<
    Uint8Array,
    Uint8Array
  >;
  return input.pipeThrough(ds);
}
