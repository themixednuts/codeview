/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

import { build, files, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE_NAME = `cache-${version}`;
const PRECACHE_ASSETS = [...build, ...files];

async function clearCodeviewCaches(): Promise<void> {
	const keys = await caches.keys();
	await Promise.all(keys.filter((key) => key.startsWith('cache-')).map((key) => caches.delete(key)));
}

sw.addEventListener('install', (event) => {
	event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_ASSETS)));
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
	const accept = event.request.headers.get('accept') ?? '';
	const isSSE = accept.includes('text/event-stream') || url.pathname.endsWith('/sse');
	const isRemoteRpc = url.pathname.startsWith('/_app/remote/');
	const isApi = url.pathname.startsWith('/api/');

	// Never cache/handle stream and API/RPC requests in SW.
	// Let the browser hit the network directly to avoid stream reconnection churn.
	if (isSSE || isRemoteRpc || isApi) return;

	// Serve precached build/static assets directly from cache
	if (PRECACHE_ASSETS.includes(url.pathname)) {
		event.respondWith(
			caches.match(event.request).then((r) => {
				if (r) return r;
				return fetch(event.request).catch(
					() => new Response('Offline', { status: 503, statusText: 'Service Unavailable' }),
				);
			}),
		);
		return;
	}

	// Network-first for all other GET requests (pages, API data)
	event.respondWith(
		fetch(event.request)
			.then((response) => {
				const cacheControl = response.headers.get('cache-control') ?? '';
				const canCache =
					response.ok &&
					url.origin === sw.location.origin &&
					response.type === 'basic' &&
					!cacheControl.includes('no-store') &&
					!cacheControl.includes('private') &&
					response.status !== 206;

				if (canCache) {
					const clone = response.clone();
					caches
						.open(CACHE_NAME)
						.then((cache) => cache.put(event.request, clone))
						.catch(() => {});
				}
				return response;
			})
			.catch(() =>
				caches
					.match(event.request)
					.then(
						(r) => r ?? new Response('Offline', { status: 503, statusText: 'Service Unavailable' }),
					),
			),
	);
});
