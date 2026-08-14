function waitForControllerChange(timeoutMs: number): Promise<void> {
  if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const finish = () => {
      window.clearTimeout(timer);
      navigator.serviceWorker.removeEventListener("controllerchange", onChange);
      resolve();
    };
    const onChange = () => finish();
    const timer = window.setTimeout(finish, timeoutMs);
    navigator.serviceWorker.addEventListener("controllerchange", onChange);
  });
}

async function clearCodeviewCaches(): Promise<void> {
  if (!("caches" in window)) return;
  const keys = await caches.keys();
  await Promise.all(
    keys.filter((key) => key.startsWith("cache-")).map((key) => caches.delete(key).catch(() => false)),
  );
}

export async function forceRefreshClient(): Promise<void> {
  try {
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.update().catch(() => {})));

      const waitingForNewWorker = registrations.some(
        (registration) => Boolean(registration.installing) || Boolean(registration.waiting),
      );
      const controllerSwap = waitingForNewWorker
        ? waitForControllerChange(8_000)
        : Promise.resolve();

      for (const registration of registrations) {
        const workers = [registration.waiting, registration.installing, registration.active].filter(
          (worker): worker is ServiceWorker => Boolean(worker),
        );
        for (const worker of workers) {
          worker.postMessage({ type: "codeview:force-refresh" });
        }
      }

      await controllerSwap;
    }

    await clearCodeviewCaches();
  } finally {
    window.location.reload();
  }
}
