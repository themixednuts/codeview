/**
 * SSE $realtime entry point — used when $realtime resolves to sse/client.ts
 * (e.g. a future Vercel provider).
 *
 * Re-exports the shared SSE connection with the same interface as ws/client.ts.
 */
export { connect } from './shared.client';
export type { RealtimeCallback } from '$lib/ws/client';
