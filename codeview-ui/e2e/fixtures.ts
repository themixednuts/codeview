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
			for (let attempt = 0; attempt < 3; attempt += 1) {
				try {
					await clearBrowserCache(page);
					await page.goto(path);
					return;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					const transient =
						message.includes('ERR_CONNECTION_REFUSED') || message.includes('ERR_FAILED');
					if (!transient || attempt === 2) {
						throw error;
					}
					await page.waitForTimeout(1_000);
				}
			}
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

/**
 * Check whether workspace crates are available (local mode only).
 */
export async function hasWorkspaceCrates(page: Page): Promise<boolean> {
	const section = page.locator('#workspace-crates');
	return section.isVisible({ timeout: 3_000 }).catch(() => false);
}

/**
 * Navigate to a crate and wait for the sidebar tree to load.
 * Works in both local mode (workspace crates) and CF mode (explore crates).
 *
 * Strategy:
 * 1. Local mode: click first workspace crate (pre-parsed, fast)
 * 2. CF mode: click first explore crate from landing page
 * 3. Fallback: navigate directly to a known small crate
 */
export async function setupCrateView(
	page: Page,
	safeGoto: (path: string) => Promise<void>,
	options?: { timeout?: number }
) {
	const treeTimeout = options?.timeout ?? 60_000;

	await safeGoto('/');

	// Try workspace crates first (local mode — pre-parsed, instant)
	const workspaceSection = page.locator('#workspace-crates');
	const hasWorkspace = await workspaceSection.isVisible({ timeout: 3_000 }).catch(() => false);

	const cards = hasWorkspace
		? workspaceSection.locator('a')
		: page.locator('.crate-card');

	const hasCards = await cards.first().isVisible({ timeout: 15_000 }).catch(() => false);

	if (hasCards) {
		const cardCount = await cards.count();
		for (let i = 0; i < Math.min(cardCount, 5); i++) {
			await cards.nth(i).click();
			await expect.poll(() => page.url(), { timeout: 10_000 }).toMatch(/\/[\w_-]+\/[\d.]+/);

			const sidebar = page.locator('.w-80');
			const treeLinks = sidebar.locator('.overflow-auto a');
			const loaded = await treeLinks.first().isVisible({ timeout: treeTimeout }).catch(() => false);
			if (loaded) return sidebar;

			// This crate didn't load in time — go back and try the next
			await safeGoto('/');
			await expect(cards.first()).toBeVisible({ timeout: 10_000 });
		}
	}

	// Last resort: navigate directly to a known small crate
	await safeGoto('/either/latest');
	await expect.poll(() => page.url(), { timeout: 60_000 }).toMatch(/\/either\/\d+\.\d+\.\d+/);

	const sidebar = page.locator('.w-80');
	await expect(sidebar.locator('.overflow-auto a').first()).toBeVisible({ timeout: treeTimeout });
	return sidebar;
}

/**
 * Get the first crate link from the landing page (workspace or explore).
 * Returns the href string.
 */
export async function getFirstCrateHref(page: Page): Promise<string> {
	const workspaceSection = page.locator('#workspace-crates');
	const hasWorkspace = await workspaceSection.isVisible({ timeout: 3_000 }).catch(() => false);

	const cards = hasWorkspace
		? workspaceSection.locator('a')
		: page.locator('.crate-card');

	await expect(cards.first()).toBeVisible({ timeout: 15_000 });
	return (await cards.first().getAttribute('href'))!;
}
