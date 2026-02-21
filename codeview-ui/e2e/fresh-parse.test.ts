import { test, expect } from './fixtures';

/**
 * Regression test: navigating directly to a deep node URL on a crate
 * that hasn't been parsed yet should show the detail view + relationship
 * graph automatically once parsing completes — no manual browser refresh.
 *
 * Requires cf:dev:clear (wipes all persisted state).
 */
test.describe('Fresh Parse on Deep Node URL', () => {
	test('detail view appears after fresh crate parse without manual refresh', async ({
		page,
		safeGoto,
	}) => {
		// Fresh parse: download from docs.rs + parse + store can take 30-60s
		test.setTimeout(120_000);

		// Navigate directly to a deep node URL for a crate not yet parsed.
		// `either` is chosen for its small size (~500 lines, one enum).
		await safeGoto('/either/latest/Either');

		// SvelteKit resolves "latest" → concrete semver and redirects
		await page.waitForURL(/\/either\/\d+\.\d+\.\d+\/Either/, { timeout: 30_000 });

		// ── Key regression assertion ──
		// After the crate finishes parsing, the detail view MUST appear
		// automatically — no manual browser refresh should be needed.
		//
		// The LayoutSwitcher ("Ego" button) only renders inside the
		// `{#if selected && detail}` branch of DetailView.svelte.
		// Its presence proves that:
		//   1. crateStatus transitioned to 'ready'
		//   2. nodeViewQuery.refresh() returned data
		//   3. The reactive chain updated the template
		const egoButton = page.getByRole('button', { name: 'Ego' });
		await expect(egoButton).toBeVisible({ timeout: 90_000 });

		// Verify no error states remain visible
		await expect(page.getByText('Something went wrong')).not.toBeVisible();
		await expect(page.getByText('Node not found')).not.toBeVisible();

		// Relationship graph should render (Either has edges to Left/Right variants)
		const graphSvg = page.locator('svg').first();
		await expect(graphSvg).toBeVisible({ timeout: 10_000 });
	});

	test('crate view recovers after websocket reconnect', async ({ page, safeGoto }) => {
		test.setTimeout(120_000);

		await page.addInitScript(() => {
			const NativeWebSocket = window.WebSocket;
			let forcedClose = false;

			class FlakySocket extends NativeWebSocket {
				constructor(url: string | URL, protocols?: string | string[]) {
					super(url, protocols);
					if (forcedClose) return;
					forcedClose = true;
					this.addEventListener(
						'open',
						() => {
							setTimeout(() => {
								try {
									this.close(1012, 'test-reconnect');
								} catch {}
							}, 250);
						},
						{ once: true },
					);
				}
			}

			Object.defineProperty(FlakySocket, 'CONNECTING', { value: NativeWebSocket.CONNECTING });
			Object.defineProperty(FlakySocket, 'OPEN', { value: NativeWebSocket.OPEN });
			Object.defineProperty(FlakySocket, 'CLOSING', { value: NativeWebSocket.CLOSING });
			Object.defineProperty(FlakySocket, 'CLOSED', { value: NativeWebSocket.CLOSED });

			// @ts-expect-error test override
			window.WebSocket = FlakySocket;
		});

		await safeGoto('/itoa/latest');
		await page.waitForURL(/\/itoa\/\d+\.\d+\.\d+/, { timeout: 30_000 });

		const sidebar = page.locator('.w-80');
		await expect(sidebar.locator('.overflow-auto a').first()).toBeVisible({ timeout: 90_000 });
		await expect(page.getByRole('button', { name: 'Ego' })).toBeVisible({ timeout: 30_000 });
	});
});
