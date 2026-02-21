import { test, expect, hasWorkspaceCrates } from './fixtures';

/** Open the Settings drawer and wait for it to appear. */
async function openSettings(page: import('@playwright/test').Page) {
	const drawer = page.locator('[data-slot="sheet-content"]');
	if (await drawer.isVisible().catch(() => false)) {
		return drawer;
	}

	const settingsBtn = page.locator('button[title="Settings"], button[aria-label="Open settings"]');
	await expect(settingsBtn).toBeVisible({ timeout: 5_000 });

	for (let attempt = 0; attempt < 3; attempt += 1) {
		if (attempt === 1) {
			await settingsBtn.evaluate((el) => (el as HTMLButtonElement).click());
		} else {
			await settingsBtn.click();
		}

		if (await drawer.isVisible().catch(() => false)) {
			return drawer;
		}
		await page.waitForTimeout(200);
	}

	await drawer.waitFor({ state: 'visible', timeout: 8_000 });
	return drawer;
}

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

	test('workspace crates render when in local mode', async ({ page }) => {
		const hasWs = await hasWorkspaceCrates(page);
		if (!hasWs) {
			test.skip();
			return;
		}

		const workspaceSection = page.locator('#workspace-crates');
		await expect(workspaceSection.locator('h2')).toHaveText('Workspace');

		const crateCards = workspaceSection.locator('a');
		await expect(crateCards.first()).toBeVisible();
		const count = await crateCards.count();
		expect(count).toBeGreaterThanOrEqual(1);
	});

	test('workspace crate cards have name and version', async ({ page }) => {
		const hasWs = await hasWorkspaceCrates(page);
		if (!hasWs) {
			test.skip();
			return;
		}

		const workspaceSection = page.locator('#workspace-crates');
		const firstCard = workspaceSection.locator('a').first();
		const name = firstCard.locator('span.font-semibold').first();
		await expect(name).not.toBeEmpty();

		const badge = firstCard.locator('.badge');
		await expect(badge).toBeVisible();
		const versionText = await badge.textContent();
		expect(versionText).toMatch(/\d+\.\d+\.\d+/);
	});

	test('explore crates section shows heading', async ({ page }) => {
		const heading = page.locator('h2', { hasText: 'Explore' });
		await expect(heading).toBeVisible({ timeout: 15_000 });
	});

	test('hero section renders', async ({ page }) => {
		await expect(page.locator('h1', { hasText: 'Code, visualized.' })).toBeVisible();
	});

	test('search requires at least 2 characters', async ({ page }) => {
		const input = page.locator('#global-search');
		await input.fill('a');
		await page.waitForTimeout(400);
		const dropdown = page.locator('.corner-squircle.z-30');
		await expect(dropdown).not.toBeVisible();
	});

	test('search shows results for valid query', async ({ page }) => {
		const input = page.locator('#global-search');
		await input.fill('serde');
		// Wait for debounce (250ms) + network
		const dropdown = page.locator('.corner-squircle.z-30');
		await expect(dropdown).toBeVisible({ timeout: 10_000 });
	});

	test('search shows "No matches" for gibberish', async ({ page }) => {
		const input = page.locator('#global-search');
		await input.fill('zzzzxxxxxnonexistent99');
		const dropdown = page.locator('.corner-squircle.z-30');
		await expect(dropdown).toBeVisible({ timeout: 10_000 });
		await expect(dropdown.locator('a')).toHaveCount(0);
	});

	test('clearing search hides dropdown', async ({ page }) => {
		const input = page.locator('#global-search');
		await input.fill('serde');
		const dropdown = page.locator('.corner-squircle.z-30');
		await expect(dropdown).toBeVisible({ timeout: 10_000 });

		await input.fill('');
		await expect(dropdown).not.toBeVisible();
	});

	test('clicking crate card navigates to crate page', async ({ page }) => {
		const crateCard = page.locator('.crate-card').first();
		await expect(crateCard).toBeVisible({ timeout: 15_000 });

		const href = await crateCard.getAttribute('href');
		expect(href).toMatch(/^\/[\w_-]+\/[\d.]+$/);

		await crateCard.click();
		await page.waitForURL(/\/[\w_-]+\/[\d.]+/);
	});

	test('theme toggle changes data-theme attribute', async ({ page }) => {
		const drawer = await openSettings(page);

		const initialTheme = await page.locator('html').getAttribute('data-theme');
		// Click the opposite theme button inside the drawer
		const targetTheme = initialTheme === 'dark' ? 'Light' : 'Dark';
		const themeBtn = drawer.locator(`button:has-text("${targetTheme}")`).first();
		await themeBtn.click();
		await page.waitForTimeout(300);

		const newTheme = await page.locator('html').getAttribute('data-theme');
		expect(newTheme).not.toBe(initialTheme);
	});

	test('theme persists across reload', async ({ page, safeGoto }) => {
		const drawer = await openSettings(page);

		const initialTheme = await page.locator('html').getAttribute('data-theme');
		const targetTheme = initialTheme === 'dark' ? 'Light' : 'Dark';
		await drawer.locator(`button:has-text("${targetTheme}")`).first().click();
		await page.waitForTimeout(300);

		const toggledTheme = await page.locator('html').getAttribute('data-theme');
		expect(toggledTheme).not.toBe(initialTheme);

		// Reload and verify
		await safeGoto('/');
		await page.waitForTimeout(500);
		const reloadedTheme = await page.locator('html').getAttribute('data-theme');
		expect(reloadedTheme).toBe(toggledTheme);
	});

	test('external link mode toggle works', async ({ page }) => {
		const drawer = await openSettings(page);

		// The link mode buttons are "Codeview" and "docs.rs"
		const docsBtn = drawer.locator('button:has-text("docs.rs")');
		const codeviewBtn = drawer.locator('button:has-text("Codeview")').last(); // last to avoid header match
		await expect(docsBtn).toBeVisible({ timeout: 3_000 });

		// Click docs.rs
		await docsBtn.click();
		await page.waitForTimeout(300);

		// Click back to Codeview
		await codeviewBtn.click();
		await page.waitForTimeout(300);

		// Just verify no crash — the drawer is still visible
		await expect(drawer).toBeVisible();
	});
});
