import { test as base, expect, type Page } from '@playwright/test';

/**
 * Clear the browser HTTP cache via CDP to avoid stale chunk 404s.
 * See CLAUDE.md for why this is needed.
 */
async function clearBrowserCache(page: Page) {
	const client = await page.context().newCDPSession(page);
	await client.send('Network.clearBrowserCache');
}

/**
 * Extended test fixture that clears browser cache before navigation
 * and provides helper utilities for SSE testing.
 */
export const test = base.extend<{
	/** Navigate to a path, clearing cache first. */
	safeGoto: (path: string) => Promise<void>;
}>({
	safeGoto: async ({ page }, use) => {
		const fn = async (path: string) => {
			await clearBrowserCache(page);
			await page.goto(path);
		};
		await use(fn);
	}
});

export { expect };

/**
 * Wait for the page to settle — no pending network requests for a duration.
 */
export async function waitForIdle(page: Page, timeout = 2000) {
	await page.waitForLoadState('networkidle', { timeout });
}

/**
 * Collect SSE messages from a given endpoint URL by intercepting fetch.
 * Returns a handle that accumulates messages.
 */
export async function collectSSEMessages(page: Page, urlPattern: string) {
	const messages: unknown[] = [];
	await page.route(urlPattern, async (route) => {
		const response = await route.fetch();
		const body = await response.text();
		// Parse SSE events from the response body
		for (const block of body.split('\n\n')) {
			for (const line of block.split('\n')) {
				if (line.startsWith('data: ')) {
					try {
						messages.push(JSON.parse(line.slice(6)));
					} catch {
						// non-JSON data line
					}
				}
			}
		}
		await route.fulfill({ response });
	});
	return messages;
}
