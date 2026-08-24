import type { Cookies } from "@sveltejs/kit";
import type { Handle } from "@sveltejs/kit/hooks";
import { setupLogging } from "#lib/log.server.js";
import { handleWsUpgrade } from "$provider";
import { getAuthState, handleAuthRequest } from "#lib/server/auth.js";
import {
  cacheControlForResponse,
  isDocExplorerPath,
  isDocExplorerRequest,
  readCachedAnonymousDocResponse,
  withCacheHeaders,
  writeCachedAnonymousDocResponse,
} from "#lib/server/cache-policy.js";
import { isHosted } from "#lib/platform.js";
import { canonicalizeExplorerUrl } from "#lib/url-state.js";
import {
  ACCENT_KEY,
  ACCENT_VALUES,
  CODE_DARK_KEY,
  CODE_DARK_VALUES,
  CODE_LIGHT_KEY,
  CODE_LIGHT_VALUES,
  DENSITY_KEY,
  DENSITY_VALUES,
  DOC_LAYOUT_KEY,
  DOC_LAYOUT_VALUES,
  THEME_KEY,
  THEME_VALUES,
  TEXT_SIZE_KEY,
  TEXT_SIZE_VALUES,
  VOICE_KEY,
  VOICE_VALUES,
  readAllowedPreference,
} from "#lib/preferences.js";

await setupLogging();

type HtmlDataAttributes = {
  "data-theme": string;
  "data-accent": string;
  "data-density": string;
  "data-text-size": string;
  "data-voice": string;
  "data-doc-layout": string;
  "data-code-theme": string;
  "data-code-theme-light": string;
  "data-code-theme-dark": string;
};

export const handle: Handle = async ({ event, resolve }) => {
  if (event.url.pathname === "/api/events/ws") {
    if (event.request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    return handleWsUpgrade(event);
  }

  const canonicalRedirect = maybeRedirectCanonicalExplorerUrl(event);
  if (canonicalRedirect) {
    return withSecurityHeaders(canonicalRedirect);
  }

  const crawlDenied = await maybeDenyDocCrawler(event);
  if (crawlDenied) {
    return withSecurityHeaders(crawlDenied);
  }

  const cachedDocResponse = await maybeReadCachedDocResponse(event);
  if (cachedDocResponse) {
    return withResponseHeader(cachedDocResponse, "X-Codeview-Cache", "HIT");
  }

  event.locals.auth = await getAuthState(event);
  event.locals.user = event.locals.auth.user;
  event.locals.session = event.locals.auth.session;

  if (event.url.pathname === "/api/auth" || event.url.pathname.startsWith("/api/auth/")) {
    return withSecurityHeaders(
      withDynamicCachePolicy(
        event.request,
        event.url.pathname,
        event.locals.user !== null,
        await handleAuthRequest(event),
      ),
    );
  }

  const htmlAttributes = getHtmlDataAttributes(event.cookies);
  let appliedHtmlAttributes = false;

  const response = await resolve(event, {
    transformPageChunk: ({ html }) => {
      if (appliedHtmlAttributes) return html;

      const nextHtml = setHtmlDataAttributes(html, htmlAttributes);
      appliedHtmlAttributes = nextHtml !== html;
      return nextHtml;
    },
  });
  const securedResponse = withSecurityHeaders(
    withDynamicCachePolicy(event.request, event.url.pathname, event.locals.user !== null, response),
  );
  const cached = await maybeWriteCachedDocResponse(event, securedResponse);
  return cached ? withResponseHeader(securedResponse, "X-Codeview-Cache", "MISS") : securedResponse;
};

function getDefaultWorkerCache(): Cache | null {
  if (!isHosted || globalThis.caches === undefined) return null;
  // SAFETY: Cloudflare Workers CacheStorage exposes `caches.default`; DOM CacheStorage omits it.
  const workerCaches = globalThis.caches as CacheStorage & { default?: Cache };
  return workerCaches.default ?? null;
}

async function maybeReadCachedDocResponse(
  event: Parameters<Handle>[0]["event"],
): Promise<Response | null> {
  const cache = getDefaultWorkerCache();
  if (!cache) return null;
  try {
    return await readCachedAnonymousDocResponse(cache, event.request, event.url.pathname);
  } catch {
    return null;
  }
}

async function maybeWriteCachedDocResponse(
  event: Parameters<Handle>[0]["event"],
  response: Response,
): Promise<boolean> {
  const cache = getDefaultWorkerCache();
  if (!cache) return false;
  try {
    return await writeCachedAnonymousDocResponse(
      cache,
      event.request,
      event.url.pathname,
      event.locals.user !== null,
      response,
    );
  } catch {
    return false;
  }
}

function maybeRedirectCanonicalExplorerUrl(event: Parameters<Handle>[0]["event"]): Response | null {
  if (!isDocExplorerRequest(event.request) || !isDocExplorerPath(event.url.pathname)) return null;

  const canonical = canonicalizeExplorerUrl(event.url);
  if (canonical.search === event.url.search) return null;

  return new Response(null, {
    status: 308,
    headers: {
      "Cache-Control": "no-store",
      Location: `${canonical.pathname}${canonical.search}`,
    },
  });
}

async function maybeDenyDocCrawler(
  event: Parameters<Handle>[0]["event"],
): Promise<Response | null> {
  if (!isHosted || !isDocExplorerRequest(event.request)) return null;
  if (!isDocExplorerPath(event.url.pathname)) return null;

  const limiter = event.platform?.env?.RATE_LIMIT_CRAWL;
  if (!limiter) return null;

  const ip =
    event.request.headers.get("cf-connecting-ip") ??
    event.request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  const outcome = await limiter.limit({ key: `crawl:${ip}` });
  if (outcome.success) return null;

  return new Response("Too many requests", {
    status: 429,
    headers: {
      "Cache-Control": "no-store",
      "Retry-After": "60",
    },
  });
}

function withDynamicCachePolicy(
  request: Request,
  pathname: string,
  loggedIn: boolean,
  response: Response,
): Response {
  const value = cacheControlForResponse(pathname, response, request, loggedIn);
  return withCacheHeaders(response, value);
}

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  headers.set(
    "Content-Security-Policy",
    "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; worker-src 'self'",
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withResponseHeader(response: Response, name: string, value: string): Response {
  const headers = new Headers(response.headers);
  headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function getHtmlDataAttributes(cookies: Cookies): HtmlDataAttributes {
  const theme = readAllowedPreference(cookies.get(THEME_KEY), THEME_VALUES, "system");
  const codeThemeLight = readAllowedPreference(
    cookies.get(CODE_LIGHT_KEY),
    CODE_LIGHT_VALUES,
    "solarized-light",
  );
  const codeThemeDark = readAllowedPreference(
    cookies.get(CODE_DARK_KEY),
    CODE_DARK_VALUES,
    "solarized-dark",
  );

  return {
    "data-theme": theme,
    "data-accent": readAllowedPreference(cookies.get(ACCENT_KEY), ACCENT_VALUES, "orange"),
    "data-density": readAllowedPreference(cookies.get(DENSITY_KEY), DENSITY_VALUES, "comfortable"),
    "data-text-size": readAllowedPreference(
      cookies.get(TEXT_SIZE_KEY),
      TEXT_SIZE_VALUES,
      "standard",
    ),
    "data-voice": readAllowedPreference(cookies.get(VOICE_KEY), VOICE_VALUES, "editorial"),
    "data-doc-layout": readAllowedPreference(
      cookies.get(DOC_LAYOUT_KEY),
      DOC_LAYOUT_VALUES,
      "classic",
    ),
    "data-code-theme": theme === "dark" ? codeThemeDark : codeThemeLight,
    "data-code-theme-light": codeThemeLight,
    "data-code-theme-dark": codeThemeDark,
  };
}

function setHtmlDataAttributes(html: string, attributes: HtmlDataAttributes): string {
  return html.replace(/<html\b([^>]*)>/i, (_tag, rawAttributes: string) => {
    let nextAttributes = rawAttributes;

    for (const [name, value] of Object.entries(attributes)) {
      const attribute = `${name}="${escapeHtmlAttribute(value)}"`;
      const pattern = htmlAttributePattern(name);
      nextAttributes = pattern.test(nextAttributes)
        ? nextAttributes.replace(pattern, ` ${attribute}`)
        : `${nextAttributes} ${attribute}`;
    }

    return `<html${nextAttributes}>`;
  });
}

function htmlAttributePattern(name: string): RegExp {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\s${escapedName}=(?:"[^"]*"|'[^']*'|[^\\s>]*)`, "i");
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
