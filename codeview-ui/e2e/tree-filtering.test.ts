import { test, expect, setupCrateView } from './fixtures';

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

		// Find a non-disabled kind filter button
		const enabledButtons = sidebar.locator('.flex-wrap button[data-kind]:not([disabled])');
		await expect(enabledButtons.first()).toBeVisible({ timeout: 5_000 });
		const firstButton = enabledButtons.first();
		await expect(firstButton).not.toHaveAttribute('data-active', 'true');

		await firstButton.click();
		await expect(firstButton).toHaveAttribute('data-active', 'true', { timeout: 5_000 });
	});

	test('clicking active kind filter deactivates it', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		// Find a non-disabled kind filter button
		const enabledButtons = sidebar.locator('.flex-wrap button[data-kind]:not([disabled])');
		await expect(enabledButtons.first()).toBeVisible({ timeout: 5_000 });
		const firstButton = enabledButtons.first();

		// Activate
		await firstButton.click();
		await expect(firstButton).toHaveAttribute('data-active', 'true', { timeout: 5_000 });

		// Deactivate
		await firstButton.click();
		await expect(firstButton).not.toHaveAttribute('data-active', { timeout: 5_000 });
	});

	test('sidebar search shows results', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		const searchInput = sidebar.locator('input[name="q"]');
		await expect(searchInput).toBeVisible();

		await searchInput.fill('new');
		await searchInput.press('Enter');

		await page.waitForTimeout(2000);

		const resultCount = sidebar.locator('.overflow-auto >> text=/\\d+ result/');
		const noResults = sidebar.locator('text=No results for');
		const hasResults = await resultCount.isVisible().catch(() => false);
		const hasNoResults = await noResults.isVisible().catch(() => false);

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

		const treeLinks = sidebar.locator('.overflow-auto a');
		const countBefore = await treeLinks.count();

		const searchInput = sidebar.locator('input[name="q"]');
		await searchInput.fill('test');
		await searchInput.press('Enter');
		await page.waitForTimeout(2000);

		// Clear search
		await searchInput.fill('');
		await searchInput.press('Enter');
		await page.waitForTimeout(2000);

		const countAfter = await treeLinks.count();
		expect(countAfter).toBe(countBefore);
	});
});
