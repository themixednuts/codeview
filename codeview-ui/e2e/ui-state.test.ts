import { test, expect, getFirstCrateHref } from './fixtures';

/** Open the Settings drawer and wait for it to appear. */
async function openSettings(page: import('@playwright/test').Page) {
	const settingsBtn = page.locator('button[title="Settings"]');
	await expect(settingsBtn).toBeVisible({ timeout: 5_000 });
	await settingsBtn.click();
	const drawer = page.locator('[data-sheet-content], [role="dialog"]');
	await expect(drawer).toBeVisible({ timeout: 3_000 });
	return drawer;
}

test.describe('Theme & UI State', () => {
	test('dark mode applies correct data-theme', async ({ page, safeGoto }) => {
		await safeGoto('/');
		const drawer = await openSettings(page);

		await drawer.getByRole('radio', { name: 'Use dark theme' }).click();
		await page.waitForTimeout(300);

		const htmlTheme = await page.locator('html').getAttribute('data-theme');
		expect(htmlTheme).toBe('dark');
	});

	test('light mode applies correct data-theme', async ({ page, safeGoto }) => {
		await safeGoto('/');
		const drawer = await openSettings(page);

		await drawer.getByRole('radio', { name: 'Use light theme' }).click();
		await page.waitForTimeout(300);

		const htmlTheme = await page.locator('html').getAttribute('data-theme');
		expect(htmlTheme).toBe('light');
	});

	test('external link mode persists across reload', async ({ page, safeGoto }) => {
		await safeGoto('/');
		const drawer = await openSettings(page);

		// Switch to docs.rs mode
		await drawer.locator('button:has-text("docs.rs")').click();
		await page.waitForTimeout(300);

		// Close drawer and reload
		await page.keyboard.press('Escape');
		await safeGoto('/');
		await page.waitForTimeout(500);

		// Open settings again and verify docs.rs is still active
		const drawer2 = await openSettings(page);
		// The docs.rs button should have the accent styling (active state)
		// Just verify drawer opens without crash — persistence is tested by checking
		// that the stored value survives reload
		const stored = await page.evaluate(() => localStorage.getItem('codeview-ext-link-mode'));
		expect(stored).toBe('docs');
	});

	test('corrupted localStorage theme does not crash app', async ({ page, safeGoto }) => {
		await safeGoto('/');
		await page.evaluate(() => {
			localStorage.setItem('codeview-theme', 'INVALID_VALUE');
			localStorage.setItem('codeview-ext-link-mode', '{}');
		});

		await safeGoto('/');
		await page.waitForTimeout(1000);

		await expect(page.locator('header').first()).toBeVisible();

		const theme = await page.locator('html').getAttribute('data-theme');
		expect(['light', 'dark', null]).toContain(theme);
	});

	test('empty localStorage does not crash app', async ({ page, safeGoto }) => {
		await safeGoto('/');
		await page.evaluate(() => {
			localStorage.clear();
		});

		await safeGoto('/');
		await page.waitForTimeout(1000);

		await expect(page.locator('header').first()).toBeVisible();
		await expect(page.locator('h1', { hasText: 'Code, visualized.' })).toBeVisible();
	});

	test('theme matches data-theme attribute', async ({ page, safeGoto }) => {
		await safeGoto('/');
		const drawer = await openSettings(page);

		// Set to dark
		await drawer.getByRole('radio', { name: 'Use dark theme' }).click();
		await page.waitForTimeout(300);
		expect(await page.locator('html').getAttribute('data-theme')).toBe('dark');

		// Set to light
		await drawer.getByRole('radio', { name: 'Use light theme' }).click();
		await page.waitForTimeout(300);
		expect(await page.locator('html').getAttribute('data-theme')).toBe('light');
	});

	test('system theme mode respects OS preference', async ({ page, safeGoto }) => {
		await safeGoto('/');
		const drawer = await openSettings(page);

		await drawer.getByRole('radio', { name: 'Use system theme' }).click();
		await page.waitForTimeout(300);

		// Theme should resolve to either light or dark based on OS setting
		const theme = await page.locator('html').getAttribute('data-theme');
		expect(['light', 'dark']).toContain(theme);

		// Verify localStorage stores "system" (not the resolved value)
		const stored = await page.evaluate(() => localStorage.getItem('codeview-theme'));
		expect(stored).toBe('system');
	});

	test('header Codeview link navigates to home', async ({ page, safeGoto }) => {
		await safeGoto('/');
		const href = await getFirstCrateHref(page);
		await safeGoto(href);
		await page.waitForURL(/\/[\w_-]+\/[\d.]+/);

		await page.locator('header a', { hasText: 'Codeview' }).click();
		await page.waitForURL('/');

		await expect(page.locator('h1', { hasText: 'Code, visualized.' })).toBeVisible();
	});

	test('multiple theme toggles work without issue', async ({ page, safeGoto }) => {
		await safeGoto('/');
		const drawer = await openSettings(page);

		// Toggle rapidly between themes
		for (let i = 0; i < 3; i++) {
			await drawer.getByRole('radio', { name: 'Use dark theme' }).click();
			await page.waitForTimeout(100);
			await drawer.getByRole('radio', { name: 'Use light theme' }).click();
			await page.waitForTimeout(100);
		}

		await expect(page.locator('header').first()).toBeVisible();
		const theme = await page.locator('html').getAttribute('data-theme');
		expect(['light', 'dark']).toContain(theme);
	});
});
