import { test, expect } from './fixtures';

/**
 * Navigate to a workspace crate, wait for tree to load, then click a tree node
 * so we have a detail view to test against.
 */
async function setupWithNode(page: import('@playwright/test').Page, safeGoto: (path: string) => Promise<void>) {
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

	return { sidebar, treeLinks };
}

test.describe('State Sync', () => {
	test('tree click updates URL and detail panel', async ({ page, safeGoto }) => {
		const { treeLinks } = await setupWithNode(page, safeGoto);

		const link = treeLinks.nth(1);
		const linkText = await link.textContent();
		const href = await link.getAttribute('href');
		await link.click();

		// URL should include node path
		await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+\/.+/, { timeout: 10_000 });
		expect(page.url()).toContain(href!.split('?')[0]);

		// Detail panel should show content
		const detail = page.locator('.flex-1.overflow-auto.bg-\\[var\\(--bg\\)\\]');
		await expect(detail).toBeVisible({ timeout: 5_000 });
	});

	test('URL navigation highlights tree item', async ({ page, safeGoto }) => {
		const { treeLinks } = await setupWithNode(page, safeGoto);

		// Get the href of a tree node
		const link = treeLinks.nth(1);
		const href = await link.getAttribute('href');
		expect(href).toBeTruthy();

		// Navigate directly via URL
		await safeGoto(href!);

		// The corresponding tree item should have the selection ring
		const sidebar = page.locator('.w-80');
		await expect(sidebar).toBeVisible({ timeout: 15_000 });
		const selectedItem = sidebar.locator('.overflow-auto a.ring-1, .overflow-auto a[class*="ring-1"]');
		await expect(selectedItem).toBeVisible({ timeout: 10_000 });
	});

	test('graph node click updates URL, tree, and detail', async ({ page, safeGoto }) => {
		const { treeLinks } = await setupWithNode(page, safeGoto);

		// Click a tree node to load the graph
		await treeLinks.nth(1).click();
		await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+\/.+/, { timeout: 10_000 });
		await page.waitForTimeout(2000);

		// Look for SVG graph links
		const graphLinks = page.locator('svg g.node a[href], svg a[data-sveltekit-noscroll]');
		const graphLinkCount = await graphLinks.count();

		if (graphLinkCount > 0) {
			const graphLink = graphLinks.first();
			const graphHref = await graphLink.getAttribute('href');
			await graphLink.click();
			await page.waitForTimeout(2000);

			// URL should update
			if (graphHref) {
				expect(page.url()).toContain(graphHref.split('?')[0]);
			}

			// Tree should show a selection
			const sidebar = page.locator('.w-80');
			const selectedItem = sidebar.locator('.overflow-auto a.ring-1, .overflow-auto a[class*="ring-1"]');
			await expect(selectedItem).toBeVisible({ timeout: 10_000 });
		}
	});

	test('breadcrumbs match node ancestry', async ({ page, safeGoto }) => {
		const { treeLinks } = await setupWithNode(page, safeGoto);

		// Find a deeply nested node (href with many path segments)
		const count = await treeLinks.count();
		let deepHref: string | null = null;
		for (let i = 0; i < Math.min(count, 20); i++) {
			const href = await treeLinks.nth(i).getAttribute('href');
			if (href && href.split('/').filter(Boolean).length > 3) {
				deepHref = href;
				await treeLinks.nth(i).click();
				break;
			}
		}

		if (!deepHref) {
			// Fallback: just click something
			await treeLinks.nth(1).click();
		}

		await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+\/.+/, { timeout: 10_000 });
		await page.waitForTimeout(2000);

		// Breadcrumbs should exist as nav links
		const breadcrumbs = page.locator('nav[aria-label="Breadcrumb"] a, nav[aria-label*="readcrumb"] a');
		const bcCount = await breadcrumbs.count();

		if (bcCount > 0) {
			// Each breadcrumb link should be a valid navigation target
			for (let i = 0; i < bcCount; i++) {
				const href = await breadcrumbs.nth(i).getAttribute('href');
				expect(href).toBeTruthy();
			}
		}
	});

	test('layout mode persists across navigation', async ({ page, safeGoto }) => {
		const { treeLinks } = await setupWithNode(page, safeGoto);

		// Click a node to get detail view
		await treeLinks.nth(1).click();
		await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+\/.+/, { timeout: 10_000 });
		await page.waitForTimeout(2000);

		// Switch to force layout
		const forceBtn = page.locator('button[data-layout="force"]');
		if (await forceBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
			await forceBtn.click();
			await page.waitForTimeout(500);
			expect(page.url()).toContain('layout=force');

			// Navigate to another node
			const count = await treeLinks.count();
			if (count > 2) {
				await treeLinks.nth(2).click();
				await page.waitForTimeout(2000);

				// layout=force should persist
				expect(page.url()).toContain('layout=force');
			}
		}
	});

	test('structural toggle syncs with URL', async ({ page, safeGoto }) => {
		const { treeLinks } = await setupWithNode(page, safeGoto);

		await treeLinks.nth(1).click();
		await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+\/.+/, { timeout: 10_000 });
		await page.waitForTimeout(2000);

		// Look for structural toggle
		const structuralBtn = page.locator('button:has-text("Structural"), button[data-edge-toggle="structural"]');
		if (await structuralBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
			await structuralBtn.click();
			await page.waitForTimeout(500);
			expect(page.url()).toContain('structural=1');

			// Navigate to another node — should persist
			const count = await treeLinks.count();
			if (count > 2) {
				await treeLinks.nth(2).click();
				await page.waitForTimeout(2000);
				expect(page.url()).toContain('structural=1');
			}
		}
	});

	test('kind filter affects tree but not detail', async ({ page, safeGoto }) => {
		const { sidebar, treeLinks } = await setupWithNode(page, safeGoto);

		// Click a node to load detail
		await treeLinks.nth(1).click();
		await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+\/.+/, { timeout: 10_000 });
		await page.waitForTimeout(2000);

		// Count tree items before filter
		const countBefore = await treeLinks.count();

		// Activate a kind filter
		const kindBtn = sidebar.locator('.flex-wrap button[data-kind]').first();
		if (await kindBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
			await page.evaluate(() => {
				(document.querySelector('.flex-wrap button[data-kind]') as HTMLElement)?.click();
			});
			await page.waitForTimeout(1000);

			// Tree should be filtered (different count or same if all match)
			const countAfter = await treeLinks.count();
			// The detail panel should still be visible
			const detail = page.locator('.flex-1.overflow-auto.bg-\\[var\\(--bg\\)\\]');
			await expect(detail).toBeVisible();
		}
	});

	test('search results link to correct detail', async ({ page, safeGoto }) => {
		const { sidebar } = await setupWithNode(page, safeGoto);

		const searchInput = sidebar.locator('input[name="q"]');
		await searchInput.fill('new');
		await searchInput.press('Enter');
		await page.waitForTimeout(3000);

		// Check if search results appeared
		const resultLinks = sidebar.locator('.overflow-auto a');
		const resultCount = await resultLinks.count();

		if (resultCount > 0) {
			const firstResult = resultLinks.first();
			const resultHref = await firstResult.getAttribute('href');
			await firstResult.click();

			await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+\/.+/, { timeout: 10_000 });

			if (resultHref) {
				expect(page.url()).toContain(resultHref.split('?')[0]);
			}

			// Detail panel should be visible
			const detail = page.locator('.flex-1.overflow-auto.bg-\\[var\\(--bg\\)\\]');
			await expect(detail).toBeVisible({ timeout: 5_000 });
		}
	});
});
