export function decodeGzipStream(input: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  // SAFETY: the DOM DecompressionStream("gzip") constructor is a TransformStream<Uint8Array, Uint8Array>; TypeScript's lib types do not relate that instance to ReadableWritablePair, which pipeThrough requires.
  const ds = new DecompressionStream("gzip") as ReadableWritablePair<Uint8Array, Uint8Array>;
  return input.pipeThrough(ds);
}
