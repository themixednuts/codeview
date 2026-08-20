import { describe, expect, test } from "vite-plus/test";
import {
  ANONYMOUS_DOC_CACHE_CONTROL,
  cacheControlForResponse,
  isAggressiveCrawlPath,
  isDocExplorerPath,
  shouldEdgeCacheDocPage,
} from "./cache-policy";

describe("cache-policy", () => {
  test("detects crate doc explorer paths", () => {
    expect(isDocExplorerPath("/syn/3.0.3/gen/fold/fold_expr_for_loop")).toBe(true);
    expect(isDocExplorerPath("/admin/queue")).toBe(false);
    expect(isDocExplorerPath("/api/auth/session")).toBe(false);
    expect(isDocExplorerPath("/")).toBe(false);
  });

  test("detects aggressive crawl paths", () => {
    expect(isAggressiveCrawlPath("/core/1.99.0-nightly/core_arch/aarch64/prefetch/_prefetch")).toBe(
      true,
    );
    expect(isAggressiveCrawlPath("/syn/3.0.3/gen/visit/visit_use_group")).toBe(true);
    expect(isAggressiveCrawlPath("/serde/1.0.228/Serialize")).toBe(false);
  });

  test("edge-caches anonymous doc GETs without cookies", () => {
    const request = new Request("https://codeview.codes/syn/3.0.3/TypeMacro", { method: "GET" });
    const pathname = new URL(request.url).pathname;
    expect(shouldEdgeCacheDocPage(request, pathname, false)).toBe(true);
    expect(
      cacheControlForResponse(pathname, new Response("ok", { status: 200 }), request, false),
    ).toBe(ANONYMOUS_DOC_CACHE_CONTROL);
  });

  test("does not edge-cache logged-in or cookie requests", () => {
    const request = new Request("https://codeview.codes/syn/3.0.3/TypeMacro", {
      method: "GET",
      headers: { Cookie: "theme=dark" },
    });
    const pathname = new URL(request.url).pathname;
    expect(shouldEdgeCacheDocPage(request, pathname, false)).toBe(false);
    expect(
      cacheControlForResponse(pathname, new Response("ok", { status: 200 }), request, true),
    ).toBe("no-store");
  });
});
