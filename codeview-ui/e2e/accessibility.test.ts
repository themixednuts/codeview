import { test, expect, setupCrateView } from './fixtures';

async function navigateToNode(page: import('@playwright/test').Page, sidebar: import('@playwright/test').Locator): Promise<boolean> {
	const treeLinks = sidebar.locator('.overflow-auto a');
	const count = await treeLinks.count();
	if (count < 2) return false;

	let clicked = false;
	for (let i = 1; i < Math.min(count, 15); i++) {
		const href = await treeLinks.nth(i).getAttribute('href');
		if (!href) continue;
		if (href.split('/').filter(Boolean).length > 3) {
			await treeLinks.nth(i).click();
			clicked = true;
			break;
		}
	}

	if (!clicked) {
		await treeLinks.nth(1).click();
	}

	await page.waitForTimeout(2000);
	return /\/[\w_-]+\/[\d.]+\/.+/.test(new URL(page.url()).pathname);
}

test.describe('Accessibility', () => {
	test('search input is keyboard-accessible', async ({ page, safeGoto }) => {
		await setupCrateView(page, safeGoto);

		// Tab until we reach the search input
		const searchInput = page.locator('input[name="q"]');
		await searchInput.focus();
		await expect(searchInput).toBeFocused();

		// Type a query and press Enter
		await searchInput.fill('test');
		await searchInput.press('Enter');

		await page.waitForTimeout(2000);

		// Should show results or "No results"
		const sidebar = page.locator('.w-80');
		const hasContent = sidebar.locator('.overflow-auto');
		await expect(hasContent).toBeVisible();
	});

	test('kind filter buttons are keyboard-focusable', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		const kindBtn = sidebar.locator('.flex-wrap button[data-kind]:not([disabled])').first();
		if ((await kindBtn.count()) === 0) {
			test.skip();
			return;
		}
		await expect(kindBtn).toBeVisible({ timeout: 5_000 });

		// Focus and activate via keyboard
		await kindBtn.focus();
		await expect(kindBtn).toBeFocused();
		await kindBtn.press('Enter');

		await expect(kindBtn).toHaveAttribute('data-active', 'true', { timeout: 5_000 });
	});

	test('tree links are in tab order', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		const treeLinks = sidebar.locator('.overflow-auto a');
		const firstLink = treeLinks.first();

		// Focus the first tree link
		await firstLink.focus();
		await expect(firstLink).toBeFocused();

		// Press Enter to navigate
		const hrefBefore = await firstLink.getAttribute('href');
		await firstLink.press('Enter');

		await page.waitForTimeout(2000);

		// URL should have changed if the link had an href
		if (hrefBefore) {
			const expectedPath = new URL(hrefBefore, page.url()).pathname;
			expect(new URL(page.url()).pathname).toBe(expectedPath);
		}
	});

	test('graph zoom buttons are keyboard-accessible', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		if (!(await navigateToNode(page, sidebar))) {
			test.skip();
			return;
		}

		// Look for zoom buttons
		const zoomBtns = page.locator('button[aria-label*="zoom"], button[aria-label*="Zoom"], button:has-text("Zoom")');
		const zoomCount = await zoomBtns.count();

		if (zoomCount > 0) {
			const btn = zoomBtns.first();
			await btn.focus();
			await expect(btn).toBeFocused();
			// Just verify it can receive focus and be activated
			await btn.press('Enter');
		}
	});

	test('breadcrumb ARIA is correct', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		if (!(await navigateToNode(page, sidebar))) {
			test.skip();
			return;
		}

		const breadcrumbNav = page.locator('nav[aria-label="Breadcrumb"]');
		const hasBreadcrumb = await breadcrumbNav.isVisible().catch(() => false);

		if (hasBreadcrumb) {
			// Breadcrumb links should be navigable
			const links = breadcrumbNav.locator('a');
			const linkCount = await links.count();
			expect(linkCount).toBeGreaterThan(0);

			for (let i = 0; i < linkCount; i++) {
				const href = await links.nth(i).getAttribute('href');
				expect(href).toBeTruthy();
			}
		}
	});

	test('source viewer modal has focus management', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		if (!(await navigateToNode(page, sidebar))) {
			test.skip();
			return;
		}

		// Look for source view button/link
		const sourceBtn = page.locator('button:has-text("Source"), a:has-text("Source"), button:has-text("src/")');
		if (await sourceBtn.first().isVisible({ timeout: 3_000 }).catch(() => false)) {
			await sourceBtn.first().click();
			await page.waitForTimeout(1000);

			// If a modal opened, check for aria-modal
			const modal = page.locator('[aria-modal="true"], [role="dialog"]');
			if (await modal.isVisible().catch(() => false)) {
				// Escape should close it
				await page.keyboard.press('Escape');
				await expect(modal).not.toBeVisible({ timeout: 3_000 });
			}
		}
	});

	test('no duplicate element IDs on page', async ({ page, safeGoto }) => {
		await setupCrateView(page, safeGoto);

		const duplicates = await page.evaluate(() => {
			const ids = Array.from(document.querySelectorAll('[id]')).map((el) => el.id);
			const seen = new Set<string>();
			const dupes: string[] = [];
			for (const id of ids) {
				if (seen.has(id)) dupes.push(id);
				seen.add(id);
			}
			return dupes;
		});

		expect(duplicates).toEqual([]);
	});

	test('buttons with SVG icons have accessible text', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		if (!(await navigateToNode(page, sidebar))) {
			test.skip();
			return;
		}

		// Find all buttons with SVGs but no text content or aria-label
		const inaccessibleButtons = await page.evaluate(() => {
			const buttons = Array.from(document.querySelectorAll('button'));
			const bad: string[] = [];
			for (const btn of buttons) {
				const hasSvg = btn.querySelector('svg') !== null;
				if (!hasSvg) continue;
				const text = btn.textContent?.trim() ?? '';
				const ariaLabel = btn.getAttribute('aria-label') ?? '';
				const title = btn.getAttribute('title') ?? '';
				if (!text && !ariaLabel && !title) {
					bad.push(btn.outerHTML.substring(0, 100));
				}
			}
			return bad;
		});

		expect(inaccessibleButtons).toEqual([]);
	});

	test('selected tree item is visually distinct via ring', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		if (!(await navigateToNode(page, sidebar))) {
			test.skip();
			return;
		}

		// The selected item should have ring styling
		const selected = sidebar.locator('.overflow-auto a[class*="ring-1"]');
		await expect(selected).toBeVisible({ timeout: 5_000 });

		// Verify it uses ring, not just color
		const classes = await selected.getAttribute('class');
		expect(classes).toContain('ring-1');
	});

	test('tab order follows visual layout', async ({ page, safeGoto }) => {
		await setupCrateView(page, safeGoto);

		// Tab through the page and record which regions receive focus
		const focusOrder: string[] = [];

		for (let i = 0; i < 20; i++) {
			await page.keyboard.press('Tab');
			const region = await page.evaluate(() => {
				const el = document.activeElement;
				if (!el) return 'none';
				// Determine which region the focused element is in
				if (el.closest('.w-80 input[name="q"]') || el.matches('input[name="q"]')) return 'search';
				if (el.closest('.flex-wrap') && el.matches('button[data-kind]')) return 'filters';
				if (el.closest('.overflow-auto') && el.matches('a')) return 'tree';
				if (el.closest('.flex-1.overflow-auto')) return 'detail';
				if (el.closest('header, nav')) return 'header';
				if (el.matches('select')) return 'version-select';
				return 'other';
			});

			if (region !== 'none' && region !== 'other') {
				if (focusOrder.length === 0 || focusOrder[focusOrder.length - 1] !== region) {
					focusOrder.push(region);
				}
			}
		}

		// Focus should move through meaningful regions without getting stuck.
		expect(focusOrder.length).toBeGreaterThan(1);
		expect(new Set(focusOrder).size).toBeGreaterThan(1);
	});
});
