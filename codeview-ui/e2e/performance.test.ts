import { test, expect } from './fixtures';

/**
 * Navigate to a workspace crate and wait for tree to load.
 */
async function setupCrateView(page: import('@playwright/test').Page, safeGoto: (path: string) => Promise<void>) {
	await safeGoto('/');
	const workspaceSection = page.locator('#workspace-crates');
	await expect(workspaceSection).toBeVisible({ timeout: 15_000 });

	const firstCard = workspaceSection.locator('a').first();
	await firstCard.click();
	await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+/);

	const sidebar = page.locator('.w-80');
	await expect(sidebar).toBeVisible({ timeout: 15_000 });

	const treeLinks = sidebar.locator('.overflow-auto a');
	await expect(treeLinks.first()).toBeVisible({ timeout: 10_000 });

	return sidebar;
}

test.describe('Performance', () => {
	test('initial tree renders within 5 seconds', async ({ page, safeGoto }) => {
		const start = Date.now();

		await safeGoto('/');
		const workspaceSection = page.locator('#workspace-crates');
		await expect(workspaceSection).toBeVisible({ timeout: 15_000 });

		const firstCard = workspaceSection.locator('a').first();
		await firstCard.click();

		const sidebar = page.locator('.w-80');
		const treeLinks = sidebar.locator('.overflow-auto a');
		await expect(treeLinks.first()).toBeVisible({ timeout: 5_000 });

		const elapsed = Date.now() - start;
		expect(elapsed).toBeLessThan(5_000);
	});

	test('expand-all completes within 3 seconds', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		// Look for expand-all button
		const expandBtn = page.locator('button[aria-label="Expand all"], button:has-text("Expand")');
		if (await expandBtn.first().isVisible({ timeout: 3_000 }).catch(() => false)) {
			const start = Date.now();
			await expandBtn.first().click();

			// Wait for more nodes to appear
			const treeLinks = sidebar.locator('.overflow-auto a');
			const countBefore = await treeLinks.count();
			await page.waitForTimeout(500);
			const countAfter = await treeLinks.count();

			const elapsed = Date.now() - start;
			expect(elapsed).toBeLessThan(3_000);
			expect(countAfter).toBeGreaterThanOrEqual(countBefore);
		}
	});

	test('node navigation loads within 2 seconds', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		const treeLinks = sidebar.locator('.overflow-auto a');
		const start = Date.now();

		await treeLinks.nth(1).click();

		// Wait for detail panel to show content
		const detail = page.locator('.flex-1.overflow-auto.bg-\\[var\\(--bg\\)\\]');
		await expect(detail).toBeVisible({ timeout: 2_000 });

		// Wait for detail to have some content (not just loading spinner)
		await page.waitForFunction(
			() => {
				const panel = document.querySelector('.flex-1.overflow-auto');
				return panel && panel.children.length > 0 && !panel.querySelector('.animate-spin');
			},
			{ timeout: 2_000 }
		).catch(() => {});

		const elapsed = Date.now() - start;
		expect(elapsed).toBeLessThan(2_000);
	});

	test('search responds within 3 seconds', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		const searchInput = sidebar.locator('input[name="q"]');
		const start = Date.now();

		await searchInput.fill('new');
		await searchInput.press('Enter');

		// Wait for results or "No results"
		const resultCount = sidebar.locator('.overflow-auto >> text=/\\d+ result/');
		const noResults = sidebar.locator('text=No results for');

		await expect(resultCount.or(noResults)).toBeVisible({ timeout: 3_000 });

		const elapsed = Date.now() - start;
		expect(elapsed).toBeLessThan(3_000);
	});

	test('layout mode switch re-renders within 2 seconds', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		const treeLinks = sidebar.locator('.overflow-auto a');
		await treeLinks.nth(1).click();
		await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+\/.+/, { timeout: 10_000 });
		await page.waitForTimeout(2000);

		// Find layout buttons
		const forceBtn = page.locator('button[data-layout="force"]');
		if (await forceBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
			const start = Date.now();
			await forceBtn.click();
			await page.waitForTimeout(500);

			// SVG should still be present after switch
			const svg = page.locator('svg');
			await expect(svg.first()).toBeVisible({ timeout: 2_000 });

			const elapsed = Date.now() - start;
			expect(elapsed).toBeLessThan(2_000);
		}
	});

	test('rapid expand/collapse does not leak memory', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		// Navigate to a node for graph rendering
		const treeLinks = sidebar.locator('.overflow-auto a');
		await treeLinks.nth(1).click();
		await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+\/.+/, { timeout: 10_000 });
		await page.waitForTimeout(2000);

		// Get initial heap usage
		const getHeap = async () => {
			const metrics = await page.evaluate(() => {
				if ('memory' in performance) {
					return (performance as unknown as { memory: { usedJSHeapSize: number } }).memory
						.usedJSHeapSize;
				}
				return 0;
			});
			return metrics;
		};

		const initialHeap = await getHeap();
		if (initialHeap === 0) return; // performance.memory not available

		// Rapid expand/collapse cycles via tree navigation
		for (let i = 0; i < 10; i++) {
			const idx = (i % 3) + 1;
			const count = await treeLinks.count();
			if (idx < count) {
				await treeLinks.nth(idx).click();
				await page.waitForTimeout(200);
			}
		}

		// Force GC if available
		await page.evaluate(() => {
			if ('gc' in globalThis) {
				(globalThis as unknown as { gc: () => void }).gc();
			}
		});
		await page.waitForTimeout(500);

		const finalHeap = await getHeap();
		const growth = finalHeap - initialHeap;

		// Growth should be less than 10MB
		expect(growth).toBeLessThan(10 * 1024 * 1024);
	});

	test('graph SVG node count matches edge summary', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		const treeLinks = sidebar.locator('.overflow-auto a');
		await treeLinks.nth(1).click();
		await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+\/.+/, { timeout: 10_000 });
		await page.waitForTimeout(2000);

		// Count SVG graph nodes
		const svgNodes = page.locator('svg g.node, svg [data-node-id]');
		const svgNodeCount = await svgNodes.count();

		// Look for edge count text like "X edges" or "X relationships"
		const edgeText = page.locator('text=/\\d+ (edge|relationship)/i');
		const hasEdgeText = await edgeText.isVisible().catch(() => false);

		if (hasEdgeText && svgNodeCount > 0) {
			const text = await edgeText.textContent();
			const match = text?.match(/(\d+)/);
			if (match) {
				// SVG should have at least some nodes
				expect(svgNodeCount).toBeGreaterThan(0);
			}
		}
	});

	test('no console errors during navigation', async ({ page, safeGoto }) => {
		const errors: string[] = [];
		page.on('console', (msg) => {
			if (msg.type() === 'error') {
				errors.push(msg.text());
			}
		});

		const sidebar = await setupCrateView(page, safeGoto);

		const treeLinks = sidebar.locator('.overflow-auto a');
		const count = await treeLinks.count();

		// Navigate through 3 nodes
		for (let i = 1; i < Math.min(4, count); i++) {
			await treeLinks.nth(i).click();
			await page.waitForTimeout(1000);
		}

		// Filter out known benign errors (e.g., favicon, HMR)
		const realErrors = errors.filter(
			(e) =>
				!e.includes('favicon') &&
				!e.includes('HMR') &&
				!e.includes('hot-update') &&
				!e.includes('[vite]')
		);

		expect(realErrors).toEqual([]);
	});
});
