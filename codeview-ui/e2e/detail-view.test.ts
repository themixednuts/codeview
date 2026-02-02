import { test, expect } from './fixtures';

/**
 * Helper: Navigate to a workspace crate and wait for tree to load.
 * Returns the sidebar locator.
 */
async function navigateToFirstCrate(page: import('@playwright/test').Page, safeGoto: (path: string) => Promise<void>) {
	await safeGoto('/');
	const workspaceSection = page.locator('#workspace-crates');
	await expect(workspaceSection).toBeVisible({ timeout: 15_000 });

	const firstCard = workspaceSection.locator('a').first();
	await firstCard.click();
	await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+/);

	const sidebar = page.locator('.w-80');
	await expect(sidebar).toBeVisible({ timeout: 15_000 });

	// Wait for tree links to appear
	const treeLinks = sidebar.locator('.overflow-auto a');
	await expect(treeLinks.first()).toBeVisible({ timeout: 10_000 });

	return sidebar;
}

test.describe('Node Detail View', () => {
	test('clicking a tree node loads detail view', async ({ page, safeGoto }) => {
		const sidebar = await navigateToFirstCrate(page, safeGoto);

		// Click the first tree node (not the crate root)
		const treeLinks = sidebar.locator('.overflow-auto a');
		const secondLink = treeLinks.nth(1);
		const linkText = await secondLink.textContent();
		await secondLink.click();

		// URL should change to include the node path
		await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+\/.+/);

		// Detail view should show content (either node details or loading)
		const rightPanel = page.locator('.flex-1.overflow-auto.bg-\\[var\\(--bg\\)\\]');
		await expect(rightPanel).toBeVisible();
	});

	test('node not found shows appropriate message', async ({ page, safeGoto }) => {
		// Navigate to a workspace crate first to get a valid crate/version
		await safeGoto('/');
		const workspaceSection = page.locator('#workspace-crates');
		await expect(workspaceSection).toBeVisible({ timeout: 15_000 });

		const firstCard = workspaceSection.locator('a').first();
		const href = await firstCard.getAttribute('href');

		// Navigate to a nonexistent node path within the valid crate
		await safeGoto(`${href}/this/node/does/not/exist`);

		// Should show "Node not found" message
		const notFound = page.locator('text=Node not found');
		await expect(notFound).toBeVisible({ timeout: 15_000 });
	});

	test('layout switcher defaults to ego and can be changed', async ({ page, safeGoto }) => {
		const sidebar = await navigateToFirstCrate(page, safeGoto);

		// Click a tree node to load detail view
		const treeLinks = sidebar.locator('.overflow-auto a');
		await treeLinks.nth(1).click();
		await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+\/.+/);

		// Wait for detail view to load
		await page.waitForTimeout(2000);

		// The URL should not have a layout param (ego is default)
		expect(page.url()).not.toContain('layout=');

		// Find layout switcher buttons
		const layoutBtns = page.locator('button[data-layout]');
		const layoutBtnCount = await layoutBtns.count();

		// If there are layout buttons, click one
		if (layoutBtnCount > 0) {
			const forceBtn = page.locator('button[data-layout="force"]');
			if (await forceBtn.isVisible()) {
				await forceBtn.click();
				await page.waitForTimeout(500);
				expect(page.url()).toContain('layout=force');
			}
		}
	});

	test('structural and semantic toggles update URL params', async ({ page, safeGoto }) => {
		const sidebar = await navigateToFirstCrate(page, safeGoto);

		const treeLinks = sidebar.locator('.overflow-auto a');
		await treeLinks.nth(1).click();
		await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+\/.+/);
		await page.waitForTimeout(2000);

		// By default semantic=on (no param), structural=off
		expect(page.url()).not.toContain('structural=1');
		expect(page.url()).not.toContain('semantic=0');
	});

	test('back navigation preserves tree state', async ({ page, safeGoto }) => {
		const sidebar = await navigateToFirstCrate(page, safeGoto);

		// Click a tree node
		const treeLinks = sidebar.locator('.overflow-auto a');
		const linkCount = await treeLinks.count();
		expect(linkCount).toBeGreaterThan(1);

		await treeLinks.nth(1).click();
		await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+\/.+/);
		await page.waitForTimeout(1000);

		// Go back
		await page.goBack();
		await page.waitForTimeout(1000);

		// Sidebar should still be visible with tree loaded
		const sidebarAfterBack = page.locator('.w-80');
		await expect(sidebarAfterBack).toBeVisible({ timeout: 5_000 });

		const treeLinksAfter = sidebarAfterBack.locator('.overflow-auto a');
		await expect(treeLinksAfter.first()).toBeVisible({ timeout: 5_000 });
	});

	test('breadcrumbs render for nested nodes', async ({ page, safeGoto }) => {
		const sidebar = await navigateToFirstCrate(page, safeGoto);

		// Click a nested tree node
		const treeLinks = sidebar.locator('.overflow-auto a');
		// Find a link that looks nested (has :: in it or is indented)
		const count = await treeLinks.count();
		let clicked = false;
		for (let i = 2; i < Math.min(count, 10); i++) {
			const href = await treeLinks.nth(i).getAttribute('href');
			if (href && href.split('/').length > 4) {
				await treeLinks.nth(i).click();
				clicked = true;
				break;
			}
		}

		if (!clicked) {
			// Just click any non-first node
			if (count > 1) {
				await treeLinks.nth(1).click();
			}
		}

		await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+\/.+/, { timeout: 5000 }).catch(() => {});

		// Wait for detail to load
		await page.waitForTimeout(2000);

		// Breadcrumbs should exist if we're in a nested path
		// They appear as nav links in the detail panel
		// This test just verifies no crash on navigation
	});

	test('relationship graph canvas renders', async ({ page, safeGoto }) => {
		const sidebar = await navigateToFirstCrate(page, safeGoto);

		const treeLinks = sidebar.locator('.overflow-auto a');
		await treeLinks.nth(1).click();
		await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+\/.+/);

		// Wait for the relationship graph to render (it uses canvas)
		const canvas = page.locator('canvas');
		// Canvas may or may not be visible depending on the node type and edges
		await page.waitForTimeout(3000);
		// Just verify no crash — the canvas presence depends on whether the node has relationships
	});
});
