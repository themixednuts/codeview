import { test, expect } from './fixtures';

test.describe('Theme & UI State', () => {
	test('dark mode applies correct data-theme', async ({ page, safeGoto }) => {
		await safeGoto('/');
		await page.waitForTimeout(500);

		const themeBtn = page.locator('button[title*="theme"]');
		await expect(themeBtn).toBeVisible();

		// Find current theme
		const currentTheme = await page.locator('html').getAttribute('data-theme');

		if (currentTheme !== 'dark') {
			await themeBtn.click();
			await page.waitForTimeout(300);
		}

		const htmlTheme = await page.locator('html').getAttribute('data-theme');
		expect(htmlTheme).toBe('dark');
	});

	test('light mode applies correct data-theme', async ({ page, safeGoto }) => {
		await safeGoto('/');
		await page.waitForTimeout(500);

		const themeBtn = page.locator('button[title*="theme"]');
		await expect(themeBtn).toBeVisible();

		const currentTheme = await page.locator('html').getAttribute('data-theme');

		if (currentTheme !== 'light') {
			await themeBtn.click();
			await page.waitForTimeout(300);
		}

		const htmlTheme = await page.locator('html').getAttribute('data-theme');
		expect(htmlTheme).toBe('light');
	});

	test('external link mode persists across reload', async ({ page, safeGoto }) => {
		await safeGoto('/');
		await page.waitForTimeout(500);

		const linkBtn = page.locator('button[title*="link"]');
		await expect(linkBtn).toBeVisible();

		// Get initial state
		const initialPressed = await linkBtn.getAttribute('aria-pressed');

		// Toggle it
		await linkBtn.click();
		await page.waitForTimeout(300);

		const toggledPressed = await linkBtn.getAttribute('aria-pressed');
		expect(toggledPressed).not.toBe(initialPressed);

		// Reload
		await safeGoto('/');
		await page.waitForTimeout(500);

		const linkBtnAfter = page.locator('button[title*="link"]');
		const afterPressed = await linkBtnAfter.getAttribute('aria-pressed');
		expect(afterPressed).toBe(toggledPressed);
	});

	test('corrupted localStorage theme does not crash app', async ({ page, safeGoto }) => {
		// Set corrupted theme value
		await safeGoto('/');
		await page.evaluate(() => {
			localStorage.setItem('codeview-theme', 'INVALID_VALUE');
			localStorage.setItem('codeview-ext-link-mode', '{}');
		});

		// Reload — app should still work
		await safeGoto('/');
		await page.waitForTimeout(1000);

		// Header should be visible (app didn't crash)
		await expect(page.locator('header')).toBeVisible();

		// Theme should fall back to a valid value
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

		await expect(page.locator('header')).toBeVisible();
		await expect(page.locator('h1', { hasText: 'Code, visualized.' })).toBeVisible();
	});

	test('theme toggle button label matches current state', async ({ page, safeGoto }) => {
		await safeGoto('/');
		await page.waitForTimeout(500);

		const themeBtn = page.locator('button[title*="theme"]');
		await expect(themeBtn).toBeVisible();

		const theme = await page.locator('html').getAttribute('data-theme');
		const btnText = await themeBtn.textContent();

		if (theme === 'dark') {
			expect(btnText?.trim()).toBe('Dark');
		} else {
			expect(btnText?.trim()).toBe('Light');
		}
	});

	test('external link mode toggle label matches state', async ({ page, safeGoto }) => {
		await safeGoto('/');
		await page.waitForTimeout(500);

		const linkBtn = page.locator('button[title*="link"]');
		await expect(linkBtn).toBeVisible();

		const pressed = await linkBtn.getAttribute('aria-pressed');
		const text = await linkBtn.textContent();

		if (pressed === 'true') {
			expect(text?.trim()).toBe('docs.rs');
		} else {
			expect(text?.trim()).toBe('Codeview');
		}
	});

	test('header Codeview link navigates to home', async ({ page, safeGoto }) => {
		// Navigate to a crate page first
		await safeGoto('/');
		const workspaceSection = page.locator('#workspace-crates');
		await expect(workspaceSection).toBeVisible({ timeout: 15_000 });

		const firstCard = workspaceSection.locator('a').first();
		await firstCard.click();
		await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+/);

		// Click the Codeview link in header
		await page.locator('header a', { hasText: 'Codeview' }).click();
		await page.waitForURL('/');

		// Should be back at home
		await expect(page.locator('h1', { hasText: 'Code, visualized.' })).toBeVisible();
	});

	test('multiple theme toggles work without issue', async ({ page, safeGoto }) => {
		await safeGoto('/');
		await page.waitForTimeout(500);

		const themeBtn = page.locator('button[title*="theme"]');
		await expect(themeBtn).toBeVisible();

		// Toggle multiple times rapidly
		for (let i = 0; i < 6; i++) {
			await themeBtn.click();
			await page.waitForTimeout(100);
		}

		// App should still be alive and functional
		await expect(page.locator('header')).toBeVisible();
		const theme = await page.locator('html').getAttribute('data-theme');
		expect(['light', 'dark']).toContain(theme);
	});
});
