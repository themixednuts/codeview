import { TaggedError } from 'better-result';

/** SSE message parse failure. */
export class SseParseError extends TaggedError('SseParseError')<{
	message: string;
	cause?: unknown;
}>() {}

/** WASM module load failure. */
export class WasmLoadError extends TaggedError('WasmLoadError')<{
	message: string;
	cause?: unknown;
}>() {}

/** Svelte context not found. */
export class ContextNotFoundError extends TaggedError('ContextNotFoundError')<{
	contextName: string;
}>() {}
