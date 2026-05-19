/**
 * Compatibility entry point for `vp run static:std`.
 *
 * The static artifact schema is owned by publish-static-batch.ts. Keep std
 * publishing on that path so hosted R2 never drifts back to legacy graph/tree
 * artifacts.
 */

process.env.INCLUDE_STD ??= '1';
process.env.INCLUDE_TOP ??= '0';

await import('./publish-static-batch.ts');
