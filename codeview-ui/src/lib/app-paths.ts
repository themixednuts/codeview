import type { ResolvedPathname } from "$app/types";

export function resolveAppPath(path: string): ResolvedPathname {
  if (!path.startsWith("/")) {
    throw new TypeError(`Expected an absolute app path, received: ${path}`);
  }
  // SAFETY: ResolvedPathname is SvelteKit's brand on `/${string}`; we already rejected non-absolute paths and Kit cannot recover the brand from a runtime string.
  return path as ResolvedPathname;
}
