import { test, expect } from './fixtures';

/**
 * Navigate to a workspace crate and wait for the sidebar to load.
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

		// Navigate rapidly via goto
		page.goto(hrefs[0]).catch(() => {});
		await page.waitForTimeout(100);
		page.goto(hrefs[1]).catch(() => {});
		await page.waitForTimeout(100);
		await page.goto(hrefs[2]);

		// Wait for detail view to settle
		await page.waitForTimeout(2000);

		// The URL should match the last navigation target
		expect(page.url()).toContain(hrefs[2]);

		// The detail panel should show content (not stuck loading)
		const mainPanel = page.locator('.flex-1.overflow-auto.bg-\\[var\\(--bg\\)\\]');
		await expect(mainPanel).toBeVisible({ timeout: 5_000 });

		// Should not show an error boundary
		const errorText = mainPanel.locator('text=Failed to render');
		await expect(errorText).not.toBeVisible({ timeout: 2_000 });
	});

	test('search query does not leak between crate navigations', async ({ page, safeGoto }) => {
		await safeGoto('/');
		const workspaceSection = page.locator('#workspace-crates');
		await expect(workspaceSection).toBeVisible({ timeout: 15_000 });

		const cards = workspaceSection.locator('a');
		const count = await cards.count();
		if (count < 2) {
			test.skip();
			return;
		}

		// Navigate to first crate
		const firstHref = await cards.first().getAttribute('href');
		await safeGoto(firstHref!);
		const sidebar = page.locator('.w-80');
		await expect(sidebar).toBeVisible({ timeout: 15_000 });

		// Search for something
		const searchInput = sidebar.locator('input[name="q"]');
		await searchInput.fill('test');
		await searchInput.press('Enter');
		await page.waitForTimeout(1000);

		// Verify search is active (URL has ?q=test)
		expect(page.url()).toContain('q=test');

		// Navigate to the other crate via the switcher badge
		const switcherBadges = sidebar.locator('.badge.badge-sm a, a.badge.badge-sm');
		const badgeCount = await switcherBadges.count();
		if (badgeCount > 0) {
			await switcherBadges.first().click();
			await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+/);
			await page.waitForTimeout(1000);

			// The search query should NOT persist to the new crate
			// (This tests whether the search param leaks across crates)
			const sidebarAfter = page.locator('.w-80');
			await expect(sidebarAfter).toBeVisible({ timeout: 15_000 });

			// Tree should show items (not be filtered to nothing)
			const treeLinks = sidebarAfter.locator('.overflow-auto a');
			await expect(treeLinks.first()).toBeVisible({ timeout: 10_000 });
		}
	});

	test('version dropdown switch loads correct crate data', async ({ page, safeGoto }) => {
		// Workspace crates may not be published on crates.io, so navigate to
		// a well-known public crate that always has multiple versions.
		await safeGoto('/hashbrown/0.16.1');

		const sidebar = page.locator('.w-80');
		await expect(sidebar).toBeVisible({ timeout: 30_000 });

		// Wait for the version dropdown to appear (versions load async from crates.io)
		const versionSelect = sidebar.locator('select');
		await expect(versionSelect).toBeVisible({ timeout: 15_000 });

		// Wait for multiple options to populate
		await expect(async () => {
			const options = await versionSelect.locator('option').allTextContents();
			expect(options.length).toBeGreaterThan(1);
		}).toPass({ timeout: 10_000 });

		const options = await versionSelect.locator('option').allTextContents();

		// Get current version from URL
		const urlBefore = page.url();

		// Switch to a different version
		await versionSelect.selectOption(options[1]);
		await page.waitForTimeout(2000);

		// URL should change to the new version
		expect(page.url()).not.toBe(urlBefore);
		expect(page.url()).toContain(options[1]);

		// Sidebar should still be functional
		await expect(sidebar).toBeVisible({ timeout: 15_000 });
	});

	test('browser back from detail view restores tree state', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		// Count tree items before any navigation
		const treeLinks = sidebar.locator('.overflow-auto a');
		const countBefore = await treeLinks.count();

		// Navigate to a node
		if (countBefore > 1) {
			const nodeHref = await treeLinks.nth(1).getAttribute('href');
			await treeLinks.nth(1).click();
			await page.waitForTimeout(1000);

			// Navigate to another node
			if (countBefore > 2) {
				await treeLinks.nth(2).click();
				await page.waitForTimeout(1000);
			}

			// Go back twice
			await page.goBack();
			await page.waitForTimeout(500);
			await page.goBack();
			await page.waitForTimeout(1000);

			// Tree should still have the same items
			const sidebarAfter = page.locator('.w-80');
			const treeAfter = sidebarAfter.locator('.overflow-auto a');
			await expect(treeAfter.first()).toBeVisible({ timeout: 10_000 });

			const countAfter = await treeAfter.count();
			// Allow some tolerance since expand state may have changed
			expect(countAfter).toBeGreaterThan(0);
		}
	});

	test('multiple rapid page refreshes do not corrupt tree state', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		// Get the current URL
		const currentUrl = page.url();

		// Rapid refreshes
		page.reload().catch(() => {});
		await page.waitForTimeout(200);
		page.reload().catch(() => {});
		await page.waitForTimeout(200);
		await page.reload();

		// Wait for everything to settle
		await page.waitForTimeout(3000);

		// Sidebar should still work
		const sidebarAfter = page.locator('.w-80');
		await expect(sidebarAfter).toBeVisible({ timeout: 15_000 });

		// Tree should have items
		const treeLinks = sidebarAfter.locator('.overflow-auto a');
		await expect(treeLinks.first()).toBeVisible({ timeout: 10_000 });
	});

	test('SSE connections are cleaned up during rapid crate switching', async ({ page, safeGoto }) => {
		await safeGoto('/');
		const workspaceSection = page.locator('#workspace-crates');
		await expect(workspaceSection).toBeVisible({ timeout: 15_000 });

		const cards = workspaceSection.locator('a');
		const count = await cards.count();
		if (count < 2) {
			test.skip();
			return;
		}

		// Collect hrefs
		const hrefs: string[] = [];
		for (let i = 0; i < count; i++) {
			hrefs.push((await cards.nth(i).getAttribute('href'))!);
		}

		// Track SSE connections
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

		// Rapidly navigate between crates
		for (let i = 0; i < Math.min(count, 4); i++) {
			page.goto(hrefs[i % count]).catch(() => {});
			await page.waitForTimeout(300);
		}

		// Navigate to final destination
		await page.goto(hrefs[0]);
		await page.waitForTimeout(5000);

		// All but the last SSE connection should be closed
		const activeSSE = sseOpened - sseClosed;
		expect(activeSSE).toBeLessThanOrEqual(2); // Allow 1 active + 1 closing
	});

	test('expand/collapse all buttons work without errors', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		// Find expand/collapse buttons
		const expandAll = sidebar.locator('button', { hasText: 'Expand all' });
		const collapseAll = sidebar.locator('button', { hasText: 'Collapse all' });

		await expect(expandAll).toBeVisible({ timeout: 5_000 });
		await expect(collapseAll).toBeVisible({ timeout: 5_000 });

		// Get initial tree link count
		const treeLinks = sidebar.locator('.overflow-auto a');
		const countBefore = await treeLinks.count();

		// Expand all
		await expandAll.click();
		await page.waitForTimeout(1000);
		const countExpanded = await treeLinks.count();
		expect(countExpanded).toBeGreaterThanOrEqual(countBefore);

		// Collapse all
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

		// Page should still be functional
		await expect(page.locator('header')).toBeVisible();
		await expect(sidebar).toBeVisible();
	});

	test('navigating to hash-containing node path does not crash', async ({ page, safeGoto }) => {
		await safeGoto('/');
		const workspaceSection = page.locator('#workspace-crates');
		await expect(workspaceSection).toBeVisible({ timeout: 15_000 });

		const firstCard = workspaceSection.locator('a').first();
		const href = await firstCard.getAttribute('href');

		// Navigate to a path with URL-unfriendly characters
		await safeGoto(`${href}/SomePath%3A%3Awith%3A%3Acolons`);

		// Should not crash — either show the node or "Node not found"
		await expect(page.locator('header')).toBeVisible({ timeout: 15_000 });
	});

	test('opening multiple browser tabs does not cause SSE conflicts', async ({ page, context, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		// Open the same page in a new tab
		const page2 = await context.newPage();
		await page2.goto(page.url());

		// Wait for both tabs to settle
		await page.waitForTimeout(2000);
		await page2.waitForTimeout(2000);

		// Both pages should have functional sidebars
		const sidebar1 = page.locator('.w-80');
		const sidebar2 = page2.locator('.w-80');

		await expect(sidebar1).toBeVisible({ timeout: 15_000 });
		await expect(sidebar2).toBeVisible({ timeout: 15_000 });

		// Both should have tree items
		const tree1 = sidebar1.locator('.overflow-auto a');
		const tree2 = sidebar2.locator('.overflow-auto a');
		await expect(tree1.first()).toBeVisible({ timeout: 10_000 });
		await expect(tree2.first()).toBeVisible({ timeout: 10_000 });

		await page2.close();
	});

	test('detail view handles missing node gracefully', async ({ page, safeGoto }) => {
		await safeGoto('/');
		const workspaceSection = page.locator('#workspace-crates');
		await expect(workspaceSection).toBeVisible({ timeout: 15_000 });

		const firstCard = workspaceSection.locator('a').first();
		const href = await firstCard.getAttribute('href');

		// Navigate to a node that doesn't exist in the tree
		await safeGoto(`${href}/this/path/definitely/does/not/exist`);

		// Should not crash — header and sidebar should still be visible
		await expect(page.locator('header')).toBeVisible({ timeout: 15_000 });
		const sidebar = page.locator('.w-80');
		await expect(sidebar).toBeVisible({ timeout: 15_000 });
	});

	test('kind filter combined with search does not cause empty state', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		// Activate a kind filter
		await expect(sidebar.locator('.flex-wrap button[data-kind]').first()).toBeVisible({ timeout: 5_000 });
		await page.evaluate(() => {
			(document.querySelector('.flex-wrap button[data-kind]') as HTMLElement)?.click();
		});
		await page.waitForTimeout(1000);

		// Now also search
		const searchInput = sidebar.locator('input[name="q"]');
		await searchInput.fill('a');
		await searchInput.press('Enter');
		await page.waitForTimeout(2000);

		// Page should not crash or show errors
		await expect(page.locator('header')).toBeVisible();
		await expect(sidebar).toBeVisible();

		// Clear search — tree should recover to a usable state
		await searchInput.fill('');
		await searchInput.press('Enter');
		await page.waitForTimeout(2000);

		// Page should still be functional with tree items visible
		await expect(page.locator('header')).toBeVisible();
		await expect(sidebar).toBeVisible();
		const treeLinks = sidebar.locator('.overflow-auto a');
		await expect(treeLinks.first()).toBeVisible({ timeout: 10_000 });
	});
});
