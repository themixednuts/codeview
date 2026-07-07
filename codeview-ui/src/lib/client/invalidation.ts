export async function forceRefreshClient(): Promise<void> {
	try {
		if ('serviceWorker' in navigator) {
			const registrations = await navigator.serviceWorker.getRegistrations();
			await Promise.all(
				registrations.map(async (registration) => {
					const workers = [
						registration.waiting,
						registration.installing,
						registration.active,
					].filter((worker): worker is ServiceWorker => Boolean(worker));
					for (const worker of workers) {
						worker.postMessage({ type: 'codeview:force-refresh' });
					}
					await registration.update().catch(() => {});
					registration.waiting?.postMessage({ type: 'codeview:force-refresh' });
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
