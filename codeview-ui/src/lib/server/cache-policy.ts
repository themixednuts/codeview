const DOC_PAGE_PREFIXES = ["/admin", "/api/", "/queue", "/settings", "/_app/"] as const;

/** Aggressive bot crawl paths that drove most CPU-limit 503s in prod observability. */
const AGGRESSIVE_CRAWL_PATTERNS = [
  /\/prefetch(?:\/|$)/i,
  /\/gen\/(?:visit_mut|visit|fold)(?:\/|$)/i,
] as const;

export const ANONYMOUS_DOC_CACHE_CONTROL =
  "public, s-maxage=3600, stale-while-revalidate=86400";

export function isDocExplorerPath(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2) return false;
  return !DOC_PAGE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function isAggressiveCrawlPath(pathname: string): boolean {
  return AGGRESSIVE_CRAWL_PATTERNS.some((pattern) => pattern.test(pathname));
}

export function hasCredentialHeaders(request: Request): boolean {
  return request.headers.has("Cookie") || request.headers.has("Authorization");
}

export function shouldEdgeCacheDocPage(request: Request, pathname: string, loggedIn: boolean): boolean {
  if (request.method !== "GET") return false;
  if (loggedIn) return false;
  if (hasCredentialHeaders(request)) return false;
  return isDocExplorerPath(pathname);
}

export function cacheControlForResponse(
  pathname: string,
  response: Response,
  request: Request,
  loggedIn: boolean,
): string {
  if (pathname.startsWith("/_app/immutable/") && !response.ok) return "no-store";
  if (pathname.startsWith("/_app/immutable/") || pathname.startsWith("/favicon")) {
    return response.headers.get("Cache-Control") ?? "public, max-age=31536000, immutable";
  }
  if (response.headers.has("Cache-Control")) {
    return response.headers.get("Cache-Control")!;
  }
  if (
    response.ok &&
    !response.headers.has("Set-Cookie") &&
    shouldEdgeCacheDocPage(request, pathname, loggedIn)
  ) {
    return ANONYMOUS_DOC_CACHE_CONTROL;
  }
  return "no-store";
}
