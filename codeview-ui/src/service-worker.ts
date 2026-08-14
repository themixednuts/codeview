/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

import { version } from "$app/env";
import { assets, immutable } from "$app/manifest";
import { resolve } from "$app/paths";
import { self } from "$app/service-worker";

const CACHE_NAME = `cache-${version}`;
const PRECACHE_ASSETS = [
  ...immutable.map((asset) => resolveAssetPath(asset.path)),
  ...assets.map((asset) => resolveAssetPath(asset.path)),
];
const PRECACHE_ASSET_PATHS = new Set(PRECACHE_ASSETS);

function resolveAssetPath(path: string): string {
  return resolve(path.startsWith("/") ? path : `/${path}`);
}

async function precacheAssets(): Promise<void> {
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(
    PRECACHE_ASSETS.map(async (asset) => {
      try {
        const request = new Request(asset, { cache: "reload" });
        const response = await fetch(request);
        if (!response.ok) return;
        await cache.put(request, response);
      } catch {
        // A missing deploy artifact should not strand users on an old worker.
      }
    }),
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
  void precacheAssets();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  // SAFETY: service-worker postMessage payloads are untyped; this app only posts `{ type: "codeview:force-refresh" }`.
  const data = event.data as { type?: string } | null;
  if (data?.type !== "codeview:force-refresh") return;
  event.waitUntil(self.skipWaiting().then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !PRECACHE_ASSET_PATHS.has(url.pathname)) return;

  // Only immutable build and static assets are intercepted. Dynamic pages,
  // remote functions, APIs, and streams always use the browser network path.
  event.respondWith(caches.match(event.request).then((cached) => cached ?? fetch(event.request)));
});
