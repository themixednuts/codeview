const RESERVED_FIRST_SEGMENTS = new Set([
  "_app",
  "admin",
  "api",
  "auth",
  "go",
  "queue",
  "settings",
]);

export const ANONYMOUS_DOC_CACHE_CONTROL = "public, s-maxage=3600, stale-while-revalidate=86400";

export interface DocResponseCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

const DOC_RESPONSE_CACHE_ORIGIN = "https://codeview.internal";
const DOC_RESPONSE_CACHE_NAMESPACE = "doc-pages-v1";

export function isDocExplorerPath(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  const firstSegment = segments[0];
  if (!firstSegment || segments.length < 2) return false;
  return !RESERVED_FIRST_SEGMENTS.has(firstSegment.toLowerCase());
}

export function isDocExplorerRequest(request: Request): boolean {
  if (request.method !== "GET") return false;
  const pathname = new URL(request.url).pathname;
  if (pathname.endsWith("/__data.json") || pathname.endsWith(".html__data.json")) return false;
  return isDocExplorerPath(pathname);
}

export function hasCredentialHeaders(request: Request): boolean {
  return request.headers.has("Cookie") || request.headers.has("Authorization");
}

export function shouldEdgeCacheDocPage(
  request: Request,
  pathname: string,
  loggedIn: boolean,
): boolean {
  if (!isDocExplorerRequest(request)) return false;
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
  if (loggedIn || hasCredentialHeaders(request) || response.headers.has("Set-Cookie")) {
    return "no-store";
  }
  if (response.headers.has("Cache-Control")) {
    return response.headers.get("Cache-Control")!;
  }
  if (response.ok && shouldEdgeCacheDocPage(request, pathname, loggedIn)) {
    return ANONYMOUS_DOC_CACHE_CONTROL;
  }
  return "no-store";
}

export function withCacheHeaders(response: Response, value: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", value);
  if (value.includes("s-maxage")) {
    headers.set("Cloudflare-CDN-Cache-Control", value);
    appendVary(headers, "Cookie");
    appendVary(headers, "Authorization");
  } else {
    headers.delete("Cloudflare-CDN-Cache-Control");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function readCachedAnonymousDocResponse(
  cache: DocResponseCache,
  request: Request,
  pathname: string,
): Promise<Response | null> {
  if (!shouldEdgeCacheDocPage(request, pathname, false)) return null;
  return (await cache.match(docResponseCacheRequest(request))) ?? null;
}

export async function writeCachedAnonymousDocResponse(
  cache: DocResponseCache,
  request: Request,
  pathname: string,
  loggedIn: boolean,
  response: Response,
): Promise<boolean> {
  if (!response.ok || response.headers.has("Set-Cookie")) return false;
  if (!shouldEdgeCacheDocPage(request, pathname, loggedIn)) return false;
  await cache.put(docResponseCacheRequest(request), response.clone());
  return true;
}

function docResponseCacheRequest(request: Request): Request {
  const source = new URL(request.url);
  const key = new URL(DOC_RESPONSE_CACHE_ORIGIN);
  key.pathname = `/${DOC_RESPONSE_CACHE_NAMESPACE}${source.pathname}`;
  key.search = source.search;
  return new Request(key, { method: "GET" });
}

function appendVary(headers: Headers, name: string): void {
  const values = (headers.get("Vary") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!values.some((value) => value.toLowerCase() === name.toLowerCase())) values.push(name);
  headers.set("Vary", values.join(", "));
}
