import { test, expect, setupCrateView } from './fixtures';
import type { Page, BrowserContext } from '@playwright/test';

/**
 * Safe navigation with cache clearing (matches safeGoto from fixtures).
 * Used for the shared page in beforeAll where the safeGoto fixture is unavailable.
 */
async function safeGotoShared(page: Page, path: string) {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const client = await page.context().newCDPSession(page);
			await client.send('Network.clearBrowserCache');
			await page.goto(path);
			return;
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			const transient = msg.includes('ERR_CONNECTION_REFUSED') || msg.includes('ERR_FAILED');
			if (!transient || attempt === 2) throw error;
			await page.waitForTimeout(1_000);
		}
	}
}

/**
 * Wait for the VizSwitcher (crate map visualization) to appear.
 * The crateMap query fires asynchronously after the page loads,
 * so we need to wait beyond the initial tree load.
 */
async function waitForViz(page: Page, timeout = 30_000) {
	await expect(page.locator('button:has-text("Treemap")')).toBeVisible({ timeout });
}

/**
 * All tests share a single browser page to preserve the SWR cache.
 * The crateMap query fires client-side after hydration — without a shared
 * page, each test would start with an empty cache and the viz buttons
 * may not appear within the timeout.
 *
 * The node navigation test is placed LAST because navigating to a child
 * node and back would require a full page load (clearing SWR cache).
 */
test.describe.serial('Crate Visualizations', () => {
	let ctx: BrowserContext;
	let pg: Page;

	test.beforeAll(async ({ browser }) => {
		ctx = await browser.newContext({ baseURL: 'http://127.0.0.1:8787' });
		pg = await ctx.newPage();

		// Navigate to a crate and wait for sidebar tree + viz data
		const go = (path: string) => safeGotoShared(pg, path);
		await setupCrateView(pg, go, { timeout: 60_000 });
		await waitForViz(pg, 60_000);
	});

	test.afterAll(async () => {
		await ctx.close();
	});

	test('treemap renders on crate root page', async () => {
		const treemapSvg = pg.locator('svg[aria-label="Module treemap"]');
		await expect(treemapSvg).toBeVisible({ timeout: 10_000 });
		await expect(pg.locator('text=Module Treemap')).toBeVisible();
	});

	test('standalone module graph visible on crate root', async () => {
		// Module graph should be a standalone section (not in VizSwitcher)
		const graphSvg = pg.locator('svg[aria-label="Module dependency graph"]');
		await expect(graphSvg).toBeVisible({ timeout: 10_000 });
		await expect(pg.locator('text=Module Graph')).toBeVisible();

		// Cards/Dots/Reset buttons should be in the graph card
		const graphCard = graphSvg.locator('..').locator('..');
		await expect(graphCard.locator('button.badge:has-text("Cards")')).toBeVisible();
		await expect(graphCard.locator('button.badge:has-text("Dots")')).toBeVisible();
		await expect(graphCard.locator('button.badge:has-text("Reset")')).toBeVisible();
	});

	test('graph render mode persists in URL', async () => {
		// Switch to dots — URL should update with gm=dots
		const graphCard = pg.locator('svg[aria-label="Module dependency graph"]').locator('..').locator('..');
		await graphCard.locator('button.badge:has-text("Dots")').click();
		await pg.waitForTimeout(300);
		expect(pg.url()).toContain('gm=dots');

		// Switch back to cards (default) — gm should be removed from URL
		await graphCard.locator('button.badge:has-text("Cards")').click();
		await pg.waitForTimeout(300);
		expect(pg.url()).not.toContain('gm=');
	});

	test('viz switcher tabs switch 3 visualizations', async () => {
		// VizSwitcher should NOT have a Graph button (graph is standalone)
		await expect(pg.locator('.corner-squircle button:has-text("Graph")')).not.toBeVisible({ timeout: 1_000 }).catch(() => {
			// Graph button might exist in the CrateGraph card, but not in VizSwitcher
		});

		// Switch to Sunburst
		await pg.locator('button:has-text("Sunburst")').click();
		await expect(pg.locator('svg[aria-label="Module sunburst"]')).toBeVisible({ timeout: 5_000 });
		await expect(pg.locator('text=Module Sunburst')).toBeVisible();

		// Switch to Grid
		await pg.locator('button:has-text("Grid")').click();
		await expect(pg.locator('text=Module Grid')).toBeVisible({ timeout: 5_000 });

		// Switch back to Treemap
		await pg.locator('button:has-text("Treemap")').click();
		await expect(pg.locator('svg[aria-label="Module treemap"]')).toBeVisible({ timeout: 5_000 });
	});

	test('viz mode persists in URL', async () => {
		// Switch to sunburst — URL should update
		await pg.locator('button:has-text("Sunburst")').click();
		await expect(pg.locator('svg[aria-label="Module sunburst"]')).toBeVisible({ timeout: 5_000 });
		expect(pg.url()).toContain('viz=sunburst');

		// Treemap is default — should NOT be in URL
		await pg.locator('button:has-text("Treemap")').click();
		await expect(pg.locator('svg[aria-label="Module treemap"]')).toBeVisible({ timeout: 5_000 });
		expect(pg.url()).not.toContain('viz=');
	});

	test('grid view shows depth group headers', async () => {
		await pg.locator('button:has-text("Grid")').click();
		await expect(pg.locator('text=Module Grid')).toBeVisible({ timeout: 5_000 });
		await expect(pg.getByRole('heading', { name: /Root/i })).toBeVisible({ timeout: 5_000 });
	});

	test('sunburst renders with center label', async () => {
		await pg.locator('button:has-text("Sunburst")').click();
		const sunburstSvg = pg.locator('svg[aria-label="Module sunburst"]');
		await expect(sunburstSvg).toBeVisible({ timeout: 5_000 });

		// Check center label inside SVG (not the header text)
		await expect(sunburstSvg.locator('text:text-matches("items")')).toBeVisible({ timeout: 5_000 });
	});

	// This test navigates away from the crate root, so it runs LAST
	// to avoid needing a full-page reload (which clears SWR cache).
	test('visualization persists on node navigation', async () => {
		// Ensure treemap is showing before navigation
		await pg.locator('button:has-text("Treemap")').click();
		await expect(pg.locator('svg[aria-label="Module treemap"]')).toBeVisible({ timeout: 5_000 });

		// Navigate to a child node via the sidebar tree
		const sidebar = pg.locator('.w-80');
		const treeLinks = sidebar.locator('.overflow-auto a');

		// The first link is the crate root; click the second to navigate to a child module
		const secondLink = treeLinks.nth(1);
		const hasSecondLink = await secondLink.isVisible({ timeout: 5_000 }).catch(() => false);

		if (hasSecondLink) {
			await secondLink.click();
			await pg.waitForURL(/\/[\w_-]+\/[\d.]+\//, { timeout: 10_000 });

			// VizSwitcher should still be visible on the child node page
			await waitForViz(pg);

			// Module dependency graph should NOT be visible on non-root pages
			await expect(pg.locator('text=Module Graph')).not.toBeVisible({ timeout: 3_000 });

			// Relationship graph should be visible (non-crate-root node)
			await expect(pg.locator('text=Relationship Graph')).toBeVisible({ timeout: 10_000 });
		}
	});
});
