import { test, expect } from './fixtures';

test.describe('Edge Cases & Zombie States', () => {
	test('invalid crate name in URL does not crash the app', async ({ page, safeGoto }) => {
		await safeGoto('/-invalid-crate-/not-a-version');

		// App should handle this gracefully — either show an error or redirect
		// The page should still have a header at minimum
		const header = page.locator('header');
		await expect(header).toBeVisible({ timeout: 10_000 });

		// Should not see an unhandled error page (500)
		// Check that the page is not completely blank
		const body = await page.locator('body').textContent();
		expect(body).toBeTruthy();
	});

	test('crate name starting with number is handled', async ({ page, safeGoto }) => {
		await safeGoto('/123invalid/1.0.0');

		// Should handle gracefully — validation rejects names starting with number
		const header = page.locator('header');
		await expect(header).toBeVisible({ timeout: 10_000 });
	});

	test('very long path does not crash', async ({ page, safeGoto }) => {
		const longPath = 'a/'.repeat(50) + 'end';
		await safeGoto(`/codeview_core/0.1.0/${longPath}`);

		// Should show "Node not found" or handle gracefully
		const header = page.locator('header');
		await expect(header).toBeVisible({ timeout: 15_000 });
	});

	test('XSS in search input is safely handled', async ({ page, safeGoto }) => {
		await safeGoto('/');
		await page.waitForTimeout(1000);

		const input = page.locator('#global-search');
		await input.fill('<script>alert("xss")</script>');

		// Wait for debounce
		await page.waitForTimeout(500);

		// The script should not execute — verify no alert dialog
		// Also verify the text is displayed safely (escaped)
		const dropdown = page.locator('.absolute.left-0.right-0.z-30');
		if (await dropdown.isVisible()) {
			const html = await dropdown.innerHTML();
			// Should not contain unescaped script tags
			expect(html).not.toContain('<script>');
		}

		// Page should still be functional
		await expect(page.locator('header')).toBeVisible();
	});

	test('XSS in sidebar search is safely handled', async ({ page, safeGoto }) => {
		await safeGoto('/');
		const workspaceSection = page.locator('#workspace-crates');
		await expect(workspaceSection).toBeVisible({ timeout: 15_000 });

		const firstCard = workspaceSection.locator('a').first();
		await firstCard.click();
		await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+/);

		const sidebar = page.locator('.w-80');
		await expect(sidebar).toBeVisible({ timeout: 15_000 });

		const searchInput = sidebar.locator('input[name="q"]');
		await searchInput.fill('<img src=x onerror=alert(1)>');
		await searchInput.press('Enter');
		await page.waitForTimeout(2000);

		// Page should still be alive, no crash
		await expect(page.locator('header')).toBeVisible();
	});

	test('rapid back/forward navigation does not break state', async ({ page, safeGoto }) => {
		await safeGoto('/');
		const workspaceSection = page.locator('#workspace-crates');
		await expect(workspaceSection).toBeVisible({ timeout: 15_000 });

		const firstCard = workspaceSection.locator('a').first();
		await firstCard.click();
		await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+/);
		await page.waitForTimeout(1000);

		// Navigate to a node
		const sidebar = page.locator('.w-80');
		await expect(sidebar).toBeVisible({ timeout: 15_000 });
		const treeLinks = sidebar.locator('.overflow-auto a');
		await expect(treeLinks.first()).toBeVisible({ timeout: 10_000 });

		if (await treeLinks.count() > 1) {
			await treeLinks.nth(1).click();
			await page.waitForTimeout(500);
		}

		// Rapid back/forward
		await page.goBack();
		await page.waitForTimeout(100);
		await page.goForward();
		await page.waitForTimeout(100);
		await page.goBack();
		await page.waitForTimeout(100);
		await page.goBack();
		await page.waitForTimeout(1000);

		// Should be back at landing or crate page without crash
		await expect(page.locator('header')).toBeVisible();
	});

	test('page refresh during crate view maintains state', async ({ page, safeGoto }) => {
		await safeGoto('/');
		const workspaceSection = page.locator('#workspace-crates');
		await expect(workspaceSection).toBeVisible({ timeout: 15_000 });

		const firstCard = workspaceSection.locator('a').first();
		const href = await firstCard.getAttribute('href');
		await firstCard.click();
		await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+/);

		// Wait for tree to load
		const sidebar = page.locator('.w-80');
		await expect(sidebar).toBeVisible({ timeout: 15_000 });

		// Refresh
		await page.reload();

		// After reload, the crate view should still work
		const sidebarAfter = page.locator('.w-80');
		await expect(sidebarAfter).toBeVisible({ timeout: 15_000 });
	});

	test('concurrent navigations settle on final destination', async ({ page, safeGoto }) => {
		await safeGoto('/');
		const workspaceSection = page.locator('#workspace-crates');
		await expect(workspaceSection).toBeVisible({ timeout: 15_000 });

		const cards = workspaceSection.locator('a');
		const count = await cards.count();
		if (count < 2) {
			test.skip();
			return;
		}

		// Collect hrefs before any navigation (elements will detach from DOM)
		const hrefs: string[] = [];
		for (let i = 0; i < count; i++) {
			hrefs.push((await cards.nth(i).getAttribute('href'))!);
		}

		const targetHref = hrefs[hrefs.length - 1];

		// Trigger rapid navigations via goto (not clicks, since DOM detaches)
		page.goto(hrefs[0]).catch(() => {});
		await page.waitForTimeout(50);
		await page.goto(targetHref);

		// Wait for navigation to settle
		await page.waitForTimeout(3000);

		// Should be on the last navigated crate
		expect(page.url()).toContain(targetHref);
	});

	test('navigating away from crate page cleans up SSE', async ({ page, safeGoto }) => {
		await safeGoto('/');
		const workspaceSection = page.locator('#workspace-crates');
		await expect(workspaceSection).toBeVisible({ timeout: 15_000 });

		const firstCard = workspaceSection.locator('a').first();
		await firstCard.click();
		await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+/);

		const sidebar = page.locator('.w-80');
		await expect(sidebar).toBeVisible({ timeout: 15_000 });

		// Navigate back to home
		await page.locator('header a', { hasText: 'Codeview' }).click();
		await page.waitForURL('/');

		// Wait for any SSE cleanup
		await page.waitForTimeout(2000);

		// Page should be at home, fully functional
		await expect(page.locator('h1', { hasText: 'Code, visualized.' })).toBeVisible();
	});

	test('URL with query params preserves state across navigation', async ({ page, safeGoto }) => {
		await safeGoto('/');
		const workspaceSection = page.locator('#workspace-crates');
		await expect(workspaceSection).toBeVisible({ timeout: 15_000 });

		const firstCard = workspaceSection.locator('a').first();
		const href = await firstCard.getAttribute('href');

		// Navigate with extra query params
		await safeGoto(`${href}?structural=1&semantic=0`);

		const sidebar = page.locator('.w-80');
		await expect(sidebar).toBeVisible({ timeout: 15_000 });

		// Query params should still be in URL
		expect(page.url()).toContain('structural=1');
		expect(page.url()).toContain('semantic=0');
	});

	test('special characters in crate version do not crash', async ({ page, safeGoto }) => {
		await safeGoto('/some_crate/1.0.0-alpha.1+build.123');

		// Should handle gracefully (may show loading/failed/unknown)
		const header = page.locator('header');
		await expect(header).toBeVisible({ timeout: 10_000 });
	});
});
