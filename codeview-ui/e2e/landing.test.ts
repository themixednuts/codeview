import { test, expect } from './fixtures';

test.describe('Landing Page', () => {
	test.beforeEach(async ({ safeGoto }) => {
		await safeGoto('/');
	});

	test('page loads with title and header', async ({ page }) => {
		await expect(page).toHaveTitle('Codeview');
		const header = page.locator('header');
		await expect(header).toBeVisible();
		await expect(header.locator('a', { hasText: 'Codeview' })).toBeVisible();
	});

	test('workspace crates render', async ({ page }) => {
		// The workspace section should appear with at least one crate
		const workspaceSection = page.locator('#workspace-crates');
		await expect(workspaceSection).toBeVisible({ timeout: 15_000 });
		await expect(workspaceSection.locator('h2')).toHaveText('Workspace');

		// Should have at least one crate card (codeview_core, codeview_rustdoc, codeview_cli)
		const crateCards = workspaceSection.locator('a');
		await expect(crateCards.first()).toBeVisible();
		const count = await crateCards.count();
		expect(count).toBeGreaterThanOrEqual(1);
	});

	test('workspace crate cards have name and version', async ({ page }) => {
		const workspaceSection = page.locator('#workspace-crates');
		await expect(workspaceSection).toBeVisible({ timeout: 15_000 });

		const firstCard = workspaceSection.locator('a').first();
		// Each card has a name span and a version badge
		const name = firstCard.locator('span.font-semibold').first();
		await expect(name).not.toBeEmpty();

		const badge = firstCard.locator('.badge');
		await expect(badge).toBeVisible();
		// Version should look like semver (digits and dots)
		const versionText = await badge.textContent();
		expect(versionText).toMatch(/\d+\.\d+\.\d+/);
	});

	test('popular crates section shows heading', async ({ page }) => {
		const section = page.locator('#crates');
		await expect(section).toBeVisible({ timeout: 15_000 });
		await expect(section.locator('h2')).toHaveText('Popular Crates');
	});

	test('hero section renders', async ({ page }) => {
		await expect(page.locator('h1', { hasText: 'Code, visualized.' })).toBeVisible();
	});

	test('search requires at least 2 characters', async ({ page }) => {
		const input = page.locator('#global-search');
		await input.fill('a');
		// Wait a bit for debounce — dropdown should NOT appear
		await page.waitForTimeout(400);
		// No search results dropdown should be visible
		const dropdown = page.locator('.absolute.left-0.right-0.z-30');
		await expect(dropdown).not.toBeVisible();
	});

	test('search shows results for valid query', async ({ page }) => {
		const input = page.locator('#global-search');
		await input.fill('codeview');
		// Wait for debounce (250ms) + network
		await page.waitForTimeout(500);

		// The dropdown should appear
		const dropdown = page.locator('.absolute.left-0.right-0.z-30');
		await expect(dropdown).toBeVisible({ timeout: 5000 });
	});

	test('search shows "No matches" for gibberish', async ({ page }) => {
		const input = page.locator('#global-search');
		await input.fill('zzzzxxxxxnonexistent99');
		// Wait for debounce + network
		const noMatches = page.locator('text=No matches found');
		await expect(noMatches).toBeVisible({ timeout: 5000 });
	});

	test('clearing search hides dropdown', async ({ page }) => {
		const input = page.locator('#global-search');
		await input.fill('codeview');
		await page.waitForTimeout(500);
		const dropdown = page.locator('.absolute.left-0.right-0.z-30');
		await expect(dropdown).toBeVisible({ timeout: 5000 });

		// Clear the input
		await input.fill('');
		await expect(dropdown).not.toBeVisible();
	});

	test('clicking workspace crate navigates to crate page', async ({ page }) => {
		const workspaceSection = page.locator('#workspace-crates');
		await expect(workspaceSection).toBeVisible({ timeout: 15_000 });

		const firstCard = workspaceSection.locator('a').first();
		const href = await firstCard.getAttribute('href');
		expect(href).toMatch(/^\/[\w_-]+\/\d+\.\d+\.\d+$/);

		await firstCard.click();
		await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+/);
	});

	test('theme toggle changes data-theme attribute', async ({ page }) => {
		// Find the theme toggle button (has aria-pressed attribute, text is Light or Dark)
		const themeBtn = page.locator('button[title*="theme"]');
		await expect(themeBtn).toBeVisible();

		const initialTheme = await page.locator('html').getAttribute('data-theme');

		await themeBtn.click();
		const newTheme = await page.locator('html').getAttribute('data-theme');
		expect(newTheme).not.toBe(initialTheme);
	});

	test('theme persists across reload', async ({ page, safeGoto }) => {
		const themeBtn = page.locator('button[title*="theme"]');
		await expect(themeBtn).toBeVisible();

		// Toggle to dark
		const initialTheme = await page.locator('html').getAttribute('data-theme');
		await themeBtn.click();
		const toggledTheme = await page.locator('html').getAttribute('data-theme');
		expect(toggledTheme).not.toBe(initialTheme);

		// Reload and verify
		await safeGoto('/');
		await page.waitForTimeout(500); // Wait for onMount
		const reloadedTheme = await page.locator('html').getAttribute('data-theme');
		expect(reloadedTheme).toBe(toggledTheme);
	});

	test('external link mode toggle works', async ({ page }) => {
		const linkBtn = page.locator('button[title*="link"]');
		await expect(linkBtn).toBeVisible();

		const pressed = await linkBtn.getAttribute('aria-pressed');
		await linkBtn.click();
		const newPressed = await linkBtn.getAttribute('aria-pressed');
		expect(newPressed).not.toBe(pressed);
	});
});
