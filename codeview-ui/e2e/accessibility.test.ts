import { test, expect } from './fixtures';

/**
 * Navigate to a crate view with tree loaded.
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

		const kindBtn = sidebar.locator('.flex-wrap button[data-kind]').first();
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
			expect(page.url()).toContain(hrefBefore.split('?')[0]);
		}
	});

	test('graph zoom buttons are keyboard-accessible', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		// Navigate to a node to show the graph
		const treeLinks = sidebar.locator('.overflow-auto a');
		await treeLinks.nth(1).click();
		await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+\/.+/, { timeout: 10_000 });
		await page.waitForTimeout(2000);

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

		// Navigate to a nested node (prefer deeply nested, fall back to any)
		const treeLinks = sidebar.locator('.overflow-auto a');
		const count = await treeLinks.count();
		let clicked = false;
		for (let i = 2; i < Math.min(count, 15); i++) {
			const href = await treeLinks.nth(i).getAttribute('href');
			if (href && href.split('/').filter(Boolean).length > 3) {
				await treeLinks.nth(i).click();
				clicked = true;
				break;
			}
		}
		if (!clicked && count > 1) {
			await treeLinks.nth(1).click();
		}

		await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+\/.+/, { timeout: 10_000 });
		await page.waitForTimeout(2000);

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

		// Navigate to a node that might have source
		const treeLinks = sidebar.locator('.overflow-auto a');
		await treeLinks.nth(1).click();
		await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+\/.+/, { timeout: 10_000 });
		await page.waitForTimeout(2000);

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

		// Navigate to a node to get full UI
		const treeLinks = sidebar.locator('.overflow-auto a');
		await treeLinks.nth(1).click();
		await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+\/.+/, { timeout: 10_000 });
		await page.waitForTimeout(2000);

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

		const treeLinks = sidebar.locator('.overflow-auto a');
		await treeLinks.nth(1).click();
		await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+\/.+/, { timeout: 10_000 });
		await page.waitForTimeout(1000);

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

		// Verify no erratic jumps (each region should appear as contiguous block)
		// Build a set of transitions
		const transitions: string[] = [];
		for (let i = 1; i < focusOrder.length; i++) {
			transitions.push(`${focusOrder[i - 1]}->${focusOrder[i]}`);
		}

		// No region should appear twice non-contiguously (would indicate jumping)
		const regionFirstSeen = new Map<string, number>();
		const regionLastSeen = new Map<string, number>();
		for (let i = 0; i < focusOrder.length; i++) {
			const r = focusOrder[i];
			if (!regionFirstSeen.has(r)) regionFirstSeen.set(r, i);
			regionLastSeen.set(r, i);
		}

		for (const [region, first] of regionFirstSeen) {
			const last = regionLastSeen.get(region)!;
			// All entries between first and last should be this region (contiguous)
			for (let i = first; i <= last; i++) {
				expect(focusOrder[i]).toBe(region);
			}
		}
	});
});
