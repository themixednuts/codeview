/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

import { build, files, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE_NAME = `cache-${version}`;
const PRECACHE_ASSETS = [...build, ...files];
const PRECACHE_ASSET_PATHS = new Set(PRECACHE_ASSETS);

async function clearCodeviewCaches(): Promise<void> {
	const keys = await caches.keys();
	await Promise.all(
		keys.filter((key) => key.startsWith('cache-')).map((key) => caches.delete(key)),
	);
}

async function precacheAssets(): Promise<void> {
	const cache = await caches.open(CACHE_NAME);
	await Promise.all(
		PRECACHE_ASSETS.map(async (asset) => {
			try {
				const request = new Request(asset, { cache: 'reload' });
				const response = await fetch(request);
				if (!response.ok) return;
				await cache.put(request, response);
			} catch {
				// A missing deploy artifact should not strand users on an old worker.
			}
		}),
	);
}

sw.addEventListener('install', (event) => {
	event.waitUntil(precacheAssets().then(() => sw.skipWaiting()));
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
			)
			.then(() => sw.clients.claim()),
	);
});

sw.addEventListener('message', (event) => {
	const data = event.data as { type?: string } | null;
	if (data?.type !== 'codeview:force-refresh') return;
	void clearCodeviewCaches().then(() => sw.skipWaiting());
});

sw.addEventListener('fetch', (event) => {
	if (event.request.method !== 'GET') return;

	const url = new URL(event.request.url);
	if (url.origin !== sw.location.origin || !PRECACHE_ASSET_PATHS.has(url.pathname)) return;

	// Only immutable build and static assets are intercepted. Dynamic pages,
	// remote functions, APIs, and streams always use the browser network path.
	event.respondWith(caches.match(event.request).then((cached) => cached ?? fetch(event.request)));
});
