import { test, expect, setupCrateView, hasWorkspaceCrates } from './fixtures';

test.describe('State Corruption & Race Conditions', () => {
	test('rapid node clicks do not leave stale detail data', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		const treeLinks = sidebar.locator('.overflow-auto a');
		const count = await treeLinks.count();
		if (count < 3) {
			test.skip();
			return;
		}

		// Click 3 nodes rapidly
		const hrefs: string[] = [];
		for (let i = 0; i < Math.min(count, 3); i++) {
			hrefs.push((await treeLinks.nth(i).getAttribute('href'))!);
		}

		// Navigate rapidly via clicks
		await treeLinks.nth(0).click();
		await page.waitForTimeout(100);
		await treeLinks.nth(1).click();
		await page.waitForTimeout(100);
		await treeLinks.nth(2).click();

		// Wait for detail view to settle
		await page.waitForTimeout(2000);

		// The URL should be at a node path (one of the clicked nodes)
		expect(page.url()).toMatch(/\/[\w_-]+\/[\d.]+\/.+/);

		// The detail panel should show content (not stuck loading)
		const mainPanel = page.locator('.relative.flex-1.overflow-auto');
		await expect(mainPanel).toBeVisible({ timeout: 5_000 });

		// Should not show an error boundary
		const errorText = mainPanel.locator('text=Failed to render');
		await expect(errorText).not.toBeVisible({ timeout: 2_000 });
	});

	test('search query does not leak between crate navigations', async ({ page, safeGoto }) => {
		await safeGoto('/');
		const hasWs = await hasWorkspaceCrates(page);
		if (!hasWs) {
			test.skip();
			return;
		}

		const workspaceSection = page.locator('#workspace-crates');
		const cards = workspaceSection.locator('a');
		const count = await cards.count();
		if (count < 2) {
			test.skip();
			return;
		}

		const firstHref = await cards.first().getAttribute('href');
		await safeGoto(firstHref!);
		const sidebar = page.locator('.w-80');
		await expect(sidebar).toBeVisible({ timeout: 15_000 });

		const searchInput = sidebar.locator('input[name="q"]');
		await searchInput.fill('test');
		await searchInput.press('Enter');
		await page.waitForTimeout(1000);

		expect(page.url()).toContain('q=test');

		const switcherBadges = sidebar.locator('.badge.badge-sm a, a.badge.badge-sm');
		const badgeCount = await switcherBadges.count();
		if (badgeCount > 0) {
			await switcherBadges.first().click();
			await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+/);
			await page.waitForTimeout(1000);

			const sidebarAfter = page.locator('.w-80');
			await expect(sidebarAfter).toBeVisible({ timeout: 15_000 });

			const treeLinks = sidebarAfter.locator('.overflow-auto a');
			await expect(treeLinks.first()).toBeVisible({ timeout: 10_000 });
		}
	});

	test('version dropdown switch loads correct crate data', async ({ page, safeGoto }) => {
		// Use a well-known public crate that always has multiple versions.
		await safeGoto('/hashbrown/0.16.1');

		const sidebar = page.locator('.w-80');
		await expect(sidebar).toBeVisible({ timeout: 60_000 });

		const versionSelect = sidebar.locator('select');
		await expect(versionSelect).toBeVisible({ timeout: 15_000 });

		await expect(async () => {
			const options = await versionSelect.locator('option').allTextContents();
			expect(options.length).toBeGreaterThan(1);
		}).toPass({ timeout: 10_000 });

		const options = await versionSelect.locator('option').allTextContents();
		const urlBefore = page.url();

		await versionSelect.selectOption(options[1]);
		await page.waitForTimeout(2000);

		expect(page.url()).not.toBe(urlBefore);
		expect(page.url()).toContain(options[1]);

		await expect(sidebar).toBeVisible({ timeout: 15_000 });
	});

	test('returning to crate root from detail view restores tree state', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		const treeLinks = sidebar.locator('.overflow-auto a');
		const countBefore = await treeLinks.count();

		if (countBefore > 1) {
			// Record the crate root URL
			const crateUrl = page.url();

			await treeLinks.nth(1).click();
			await page.waitForTimeout(1000);

			if (countBefore > 2) {
				await treeLinks.nth(2).click();
				await page.waitForTimeout(1000);
			}

			// Navigate back to crate root (avoids SPA goBack timing issues)
			await safeGoto(crateUrl);

			const sidebarAfter = page.locator('.w-80');
			const treeAfter = sidebarAfter.locator('.overflow-auto a');
			await expect(treeAfter.first()).toBeVisible({ timeout: 60_000 });

			const countAfter = await treeAfter.count();
			expect(countAfter).toBeGreaterThan(0);
		}
	});

	test('multiple rapid page refreshes do not corrupt tree state', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		page.reload().catch(() => {});
		await page.waitForTimeout(200);
		page.reload().catch(() => {});
		await page.waitForTimeout(200);
		await page.reload();

		await page.waitForTimeout(3000);

		const sidebarAfter = page.locator('.w-80');
		await expect(sidebarAfter).toBeVisible({ timeout: 15_000 });

		const treeLinks = sidebarAfter.locator('.overflow-auto a');
		await expect(treeLinks.first()).toBeVisible({ timeout: 10_000 });
	});

	test('SSE connections are cleaned up during rapid crate switching', async ({ page, safeGoto }) => {
		await safeGoto('/');
		const hasWs = await hasWorkspaceCrates(page);
		if (!hasWs) {
			test.skip();
			return;
		}

		const workspaceSection = page.locator('#workspace-crates');
		const cards = workspaceSection.locator('a');
		const count = await cards.count();
		if (count < 2) {
			test.skip();
			return;
		}

		const hrefs: string[] = [];
		for (let i = 0; i < count; i++) {
			hrefs.push((await cards.nth(i).getAttribute('href'))!);
		}

		let sseOpened = 0;
		let sseClosed = 0;
		page.on('request', (req) => {
			if (req.url().includes('/api/crate-status/sse')) sseOpened++;
		});
		page.on('requestfinished', (req) => {
			if (req.url().includes('/api/crate-status/sse')) sseClosed++;
		});
		page.on('requestfailed', (req) => {
			if (req.url().includes('/api/crate-status/sse')) sseClosed++;
		});

		for (let i = 0; i < Math.min(count, 4); i++) {
			page.goto(hrefs[i % count]).catch(() => {});
			await page.waitForTimeout(300);
		}

		await page.goto(hrefs[0]);
		await page.waitForTimeout(5000);

		const activeSSE = sseOpened - sseClosed;
		expect(activeSSE).toBeLessThanOrEqual(2);
	});

	test('expand/collapse all buttons work without errors', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		const expandAll = sidebar.locator('button', { hasText: 'Expand all' });
		const collapseAll = sidebar.locator('button', { hasText: 'Collapse all' });

		await expect(expandAll).toBeVisible({ timeout: 5_000 });
		await expect(collapseAll).toBeVisible({ timeout: 5_000 });

		const treeLinks = sidebar.locator('.overflow-auto a');
		const countBefore = await treeLinks.count();

		await expandAll.click();
		await page.waitForTimeout(1000);
		const countExpanded = await treeLinks.count();
		expect(countExpanded).toBeGreaterThanOrEqual(countBefore);

		await collapseAll.click();
		await page.waitForTimeout(1000);
		const countCollapsed = await treeLinks.count();
		expect(countCollapsed).toBeLessThanOrEqual(countExpanded);

		// Rapid expand/collapse cycling should not crash
		for (let i = 0; i < 5; i++) {
			await expandAll.click();
			await page.waitForTimeout(100);
			await collapseAll.click();
			await page.waitForTimeout(100);
		}

		await expect(page.locator('header').first()).toBeVisible();
		await expect(sidebar).toBeVisible();
	});

	test('navigating to hash-containing node path does not crash', async ({ page, safeGoto }) => {
		await safeGoto('/');
		const href = await (async () => {
			const ws = page.locator('#workspace-crates');
			const hasWs = await ws.isVisible({ timeout: 3_000 }).catch(() => false);
			const cards = hasWs ? ws.locator('a') : page.locator('.crate-card');
			await expect(cards.first()).toBeVisible({ timeout: 15_000 });
			return (await cards.first().getAttribute('href'))!;
		})();

		// Navigate to a path with URL-unfriendly characters
		await safeGoto(`${href}/SomePath%3A%3Awith%3A%3Acolons`);

		await expect(page.locator('header').first()).toBeVisible({ timeout: 15_000 });
	});

	test('opening multiple browser tabs does not cause SSE conflicts', async ({ page, context, safeGoto }) => {
		await setupCrateView(page, safeGoto);

		const page2 = await context.newPage();
		await page2.goto(page.url());

		await page.waitForTimeout(2000);
		await page2.waitForTimeout(2000);

		const sidebar1 = page.locator('.w-80');
		const sidebar2 = page2.locator('.w-80');

		await expect(sidebar1).toBeVisible({ timeout: 15_000 });
		await expect(sidebar2).toBeVisible({ timeout: 15_000 });

		const tree1 = sidebar1.locator('.overflow-auto a');
		const tree2 = sidebar2.locator('.overflow-auto a');
		await expect(tree1.first()).toBeVisible({ timeout: 10_000 });
		await expect(tree2.first()).toBeVisible({ timeout: 10_000 });

		await page2.close();
	});

	test('detail view handles missing node gracefully', async ({ page, safeGoto }) => {
		await safeGoto('/');
		const href = await (async () => {
			const ws = page.locator('#workspace-crates');
			const hasWs = await ws.isVisible({ timeout: 3_000 }).catch(() => false);
			const cards = hasWs ? ws.locator('a') : page.locator('.crate-card');
			await expect(cards.first()).toBeVisible({ timeout: 15_000 });
			return (await cards.first().getAttribute('href'))!;
		})();

		await safeGoto(`${href}/this/path/definitely/does/not/exist`);

		await expect(page.locator('header').first()).toBeVisible({ timeout: 15_000 });
		const sidebar = page.locator('.w-80');
		await expect(sidebar).toBeVisible({ timeout: 60_000 });
	});

	test('kind filter combined with search does not cause empty state', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		await expect(sidebar.locator('.flex-wrap button[data-kind]').first()).toBeVisible({ timeout: 5_000 });
		await page.evaluate(() => {
			(document.querySelector('.flex-wrap button[data-kind]') as HTMLElement)?.click();
		});
		await page.waitForTimeout(1000);

		const searchInput = sidebar.locator('input[name="q"]');
		await searchInput.fill('a');
		await searchInput.press('Enter');
		await page.waitForTimeout(2000);

		await expect(page.locator('header').first()).toBeVisible();
		await expect(sidebar).toBeVisible();

		// Clear search — tree should recover
		await searchInput.fill('');
		await searchInput.press('Enter');
		await page.waitForTimeout(2000);

		await expect(page.locator('header').first()).toBeVisible();
		await expect(sidebar).toBeVisible();
		const treeLinks = sidebar.locator('.overflow-auto a');
		await expect(treeLinks.first()).toBeVisible({ timeout: 10_000 });
	});
});
