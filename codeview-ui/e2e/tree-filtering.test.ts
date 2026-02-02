import { test, expect } from './fixtures';

/**
 * Navigate to a workspace crate and wait for tree + kind filters to load.
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

	// Wait for tree to load
	const treeLinks = sidebar.locator('.overflow-auto a');
	await expect(treeLinks.first()).toBeVisible({ timeout: 10_000 });

	return sidebar;
}

test.describe('Graph Tree & Filtering', () => {
	test('tree renders with top-level items', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		const treeLinks = sidebar.locator('.overflow-auto a');
		const count = await treeLinks.count();
		expect(count).toBeGreaterThan(0);
	});

	test('kind filter buttons are present', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		// Kind filter area should have buttons with kind names and counts
		const kindButtons = sidebar.locator('.flex-wrap button');
		await expect(kindButtons.first()).toBeVisible({ timeout: 5_000 });

		const buttonCount = await kindButtons.count();
		expect(buttonCount).toBeGreaterThan(0);

		// Each button should have text like "Struct (5)" or "Module (3)"
		const firstText = await kindButtons.first().textContent();
		expect(firstText).toMatch(/\w+\s*\(\d+\)/);
	});

	test('clicking kind filter highlights it', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		const firstButton = sidebar.locator('.flex-wrap button[data-kind]').first();
		await expect(firstButton).toBeVisible({ timeout: 5_000 });
		await expect(firstButton).not.toHaveAttribute('data-active', 'true');

		await page.evaluate(() => {
			(document.querySelector('.flex-wrap button[data-kind]') as HTMLElement)?.click();
		});
		await expect(firstButton).toHaveAttribute('data-active', 'true', { timeout: 5_000 });
	});

	test('clicking active kind filter deactivates it', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		const firstButton = sidebar.locator('.flex-wrap button[data-kind]').first();
		await expect(firstButton).toBeVisible({ timeout: 5_000 });

		// Activate
		await page.evaluate(() => {
			(document.querySelector('.flex-wrap button[data-kind]') as HTMLElement)?.click();
		});
		await expect(firstButton).toHaveAttribute('data-active', 'true', { timeout: 5_000 });

		// Deactivate
		await page.evaluate(() => {
			(document.querySelector('.flex-wrap button[data-kind]') as HTMLElement)?.click();
		});
		await expect(firstButton).not.toHaveAttribute('data-active', { timeout: 5_000 });
	});

	test('sidebar search shows results', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		// Find the sidebar search input
		const searchInput = sidebar.locator('input[name="q"]');
		await expect(searchInput).toBeVisible();

		// Type a search query — use a term likely to exist in any Rust crate
		await searchInput.fill('new');
		await searchInput.press('Enter');

		// Wait for search results or "No results" message
		await page.waitForTimeout(2000);

		// Should show either results or "No results for"
		const resultCount = sidebar.locator('.overflow-auto >> text=/\\d+ result/');
		const noResults = sidebar.locator('text=No results for');
		const hasResults = await resultCount.isVisible().catch(() => false);
		const hasNoResults = await noResults.isVisible().catch(() => false);

		// One of them should be true
		expect(hasResults || hasNoResults).toBe(true);
	});

	test('sidebar search for gibberish shows no results', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		const searchInput = sidebar.locator('input[name="q"]');
		await searchInput.fill('zzzzxxxxxnonexistent99');
		await searchInput.press('Enter');

		await page.waitForTimeout(2000);

		const noResults = sidebar.locator('text=No results for');
		await expect(noResults).toBeVisible({ timeout: 5_000 });
	});

	test('clearing sidebar search restores tree', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		// Count tree links before search
		const treeLinks = sidebar.locator('.overflow-auto a');
		const countBefore = await treeLinks.count();

		// Search for something
		const searchInput = sidebar.locator('input[name="q"]');
		await searchInput.fill('test');
		await searchInput.press('Enter');
		await page.waitForTimeout(2000);

		// Clear search
		await searchInput.fill('');
		await searchInput.press('Enter');
		await page.waitForTimeout(2000);

		// Tree should be back
		const countAfter = await treeLinks.count();
		expect(countAfter).toBe(countBefore);
	});
});
