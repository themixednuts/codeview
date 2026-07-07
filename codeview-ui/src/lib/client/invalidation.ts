export async function forceRefreshClient(): Promise<void> {
	try {
		if ('serviceWorker' in navigator) {
			const registrations = await navigator.serviceWorker.getRegistrations();
			await Promise.all(
				registrations.map(async (registration) => {
					registration.active?.postMessage({ type: 'codeview:force-refresh' });
					await registration.update().catch(() => {});
				}),
			);
		}

		if ('caches' in window) {
			const keys = await caches.keys();
			await Promise.all(
				keys
					.filter((key) => key.startsWith('cache-'))
					.map((key) => caches.delete(key).catch(() => false)),
			);
		}
	} finally {
		window.location.reload();
	}
}
