import { describe, expect, test } from "vite-plus/test";
import {
  ANONYMOUS_DOC_CACHE_CONTROL,
  cacheControlForResponse,
  isDocExplorerPath,
  isDocExplorerRequest,
  shouldEdgeCacheDocPage,
  withCacheHeaders,
} from "./cache-policy";

describe("cache-policy", () => {
  test("detects crate doc explorer paths", () => {
    expect(isDocExplorerPath("/syn/3.0.3/gen/fold/fold_expr_for_loop")).toBe(true);
    expect(isDocExplorerPath("/admin/queue")).toBe(false);
    expect(isDocExplorerPath("/api/auth/session")).toBe(false);
    expect(isDocExplorerPath("/auth/github")).toBe(false);
    expect(isDocExplorerPath("/go/crate-version")).toBe(false);
    expect(isDocExplorerPath("/")).toBe(false);
  });

  test("excludes SvelteKit data and remote requests that resolve against a doc page", () => {
    expect(
      isDocExplorerRequest(
        new Request("https://codeview.codes/syn/3.0.3/__data.json?x-sveltekit-invalidated=11"),
      ),
    ).toBe(false);
    expect(
      isDocExplorerRequest(
        new Request("https://codeview.codes/_app/remote/query-id", {
          headers: { "x-sveltekit-pathname": "/syn/3.0.3" },
        }),
      ),
    ).toBe(false);
  });

  test("edge-caches anonymous doc GETs without cookies", () => {
    const request = new Request("https://codeview.codes/syn/3.0.3/TypeMacro", { method: "GET" });
    const pathname = new URL(request.url).pathname;
    expect(shouldEdgeCacheDocPage(request, pathname, false)).toBe(true);
    expect(
      cacheControlForResponse(pathname, new Response("ok", { status: 200 }), request, false),
    ).toBe(ANONYMOUS_DOC_CACHE_CONTROL);
  });

  test("does not edge-cache cookie or authorization requests", () => {
    const cookieRequest = new Request("https://codeview.codes/syn/3.0.3/TypeMacro", {
      method: "GET",
      headers: { Cookie: "theme=dark" },
    });
    const authorizationRequest = new Request("https://codeview.codes/syn/3.0.3/TypeMacro", {
      method: "GET",
      headers: { Authorization: "Bearer token" },
    });
    const pathname = new URL(cookieRequest.url).pathname;
    expect(shouldEdgeCacheDocPage(cookieRequest, pathname, false)).toBe(false);
    expect(shouldEdgeCacheDocPage(authorizationRequest, pathname, false)).toBe(false);
    expect(cacheControlForResponse(pathname, new Response("ok"), cookieRequest, false)).toBe(
      "no-store",
    );
  });

  test("does not edge-cache logged-in, internal, or cookie-setting responses", () => {
    const request = new Request("https://codeview.codes/syn/3.0.3/TypeMacro");
    const dataRequest = new Request(
      "https://codeview.codes/syn/3.0.3/TypeMacro/__data.json?x-sveltekit-invalidated=11",
    );
    const pathname = new URL(request.url).pathname;
    expect(shouldEdgeCacheDocPage(request, pathname, true)).toBe(false);
    expect(shouldEdgeCacheDocPage(dataRequest, pathname, false)).toBe(false);
    expect(
      cacheControlForResponse(
        pathname,
        new Response("ok", {
          headers: {
            "Cache-Control": ANONYMOUS_DOC_CACHE_CONTROL,
            "Set-Cookie": "session=secret",
          },
        }),
        request,
        false,
      ),
    ).toBe("no-store");
  });

  test("credentials override an upstream public cache policy", () => {
    const request = new Request("https://codeview.codes/syn/3.0.3/TypeMacro", {
      headers: { Authorization: "Bearer token" },
    });
    const response = new Response("ok", {
      headers: { "Cache-Control": ANONYMOUS_DOC_CACHE_CONTROL },
    });
    expect(cacheControlForResponse(new URL(request.url).pathname, response, request, false)).toBe(
      "no-store",
    );
  });

  test("varies public cache entries across credential-bearing requests", () => {
    const response = withCacheHeaders(
      new Response("ok", { headers: { Vary: "Accept-Encoding" } }),
      ANONYMOUS_DOC_CACHE_CONTROL,
    );
    expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBe(ANONYMOUS_DOC_CACHE_CONTROL);
    expect(response.headers.get("Vary")).toBe("Accept-Encoding, Cookie, Authorization");
  });

  test("removes an upstream Cloudflare cache policy when the response is no-store", () => {
    const response = withCacheHeaders(
      new Response("ok", {
        headers: { "Cloudflare-CDN-Cache-Control": ANONYMOUS_DOC_CACHE_CONTROL },
      }),
      "no-store",
    );
    expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBeNull();
  });
});
