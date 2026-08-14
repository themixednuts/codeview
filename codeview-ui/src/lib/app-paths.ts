import type { ResolvedPathname } from "$app/types";

export function resolveAppPath(path: string): ResolvedPathname {
  if (!path.startsWith("/")) {
    throw new TypeError(`Expected an absolute app path, received: ${path}`);
  }
  return path as ResolvedPathname;
}
