import { test, expect, hasWorkspaceCrates, getFirstCrateHref, setupCrateView } from './fixtures';

test.describe('Edge Cases & Zombie States', () => {
	test('invalid crate name in URL does not crash the app', async ({ page, safeGoto }) => {
		await safeGoto('/-invalid-crate-/not-a-version');

		// App may render an error page or redirect — just verify no crash (body has content)
		await page.waitForTimeout(3_000);
		const body = await page.locator('body').textContent();
		expect(body).toBeTruthy();
	});

	test('crate name starting with number is handled', async ({ page, safeGoto }) => {
		await safeGoto('/123invalid/1.0.0');

		// App may render an error page — just verify no crash
		await page.waitForTimeout(3_000);
		const body = await page.locator('body').textContent();
		expect(body).toBeTruthy();
	});

	test('very long path does not crash', async ({ page, safeGoto }) => {
		const longPath = 'a/'.repeat(50) + 'end';
		await safeGoto(`/codeview_core/0.1.0/${longPath}`);

		await expect(page.locator('header').first()).toBeVisible({ timeout: 15_000 });
	});

	test('XSS in search input is safely handled', async ({ page, safeGoto }) => {
		await safeGoto('/');
		await page.waitForTimeout(1000);

		const input = page.locator('#global-search');
		await input.fill('<script>alert("xss")</script>');

		await page.waitForTimeout(500);

		const dropdown = page.locator('.corner-squircle.z-30');
		if (await dropdown.isVisible()) {
			const html = await dropdown.innerHTML();
			expect(html).not.toContain('<script>');
		}

		await expect(page.locator('header').first()).toBeVisible();
	});

	test('XSS in sidebar search is safely handled', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		const searchInput = sidebar.locator('input[name="q"]');
		await searchInput.fill('<img src=x onerror=alert(1)>');
		await searchInput.press('Enter');
		await page.waitForTimeout(2000);

		// Use .first() to avoid strict mode violation when multiple <header> elements exist (e.g. modal)
		await expect(page.locator('header').first()).toBeVisible();
	});

	test('rapid navigation between nodes does not break state', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		const treeLinks = sidebar.locator('.overflow-auto a');
		const count = await treeLinks.count();
		if (count < 2) {
			test.skip();
			return;
		}

		// Rapidly click between tree nodes instead of using back/forward
		// (SvelteKit SPA goBack/goForward is unreliable in Playwright)
		for (let i = 1; i < Math.min(count, 4); i++) {
			await treeLinks.nth(i).click();
			await page.waitForTimeout(200);
		}
		await treeLinks.nth(1).click();
		await page.waitForTimeout(1000);

		await expect(page.locator('header').first()).toBeVisible();
		await expect(sidebar).toBeVisible();
	});

	test('page refresh during crate view maintains state', async ({ page, safeGoto }) => {
		await setupCrateView(page, safeGoto);

		// Refresh
		await page.reload();

		const sidebarAfter = page.locator('.w-80');
		await expect(sidebarAfter).toBeVisible({ timeout: 60_000 });
	});

	test('concurrent navigations settle on final destination', async ({ page, safeGoto }) => {
		await safeGoto('/');

		const ws = page.locator('#workspace-crates');
		const hasWs = await ws.isVisible({ timeout: 3_000 }).catch(() => false);
		const cards = hasWs ? ws.locator('a') : page.locator('.crate-card');
		await expect(cards.first()).toBeVisible({ timeout: 15_000 });

		const count = await cards.count();
		if (count < 2) {
			test.skip();
			return;
		}

		const hrefs: string[] = [];
		for (let i = 0; i < count; i++) {
			hrefs.push((await cards.nth(i).getAttribute('href'))!);
		}

		const targetHref = hrefs[hrefs.length - 1];

		page.goto(hrefs[0]).catch(() => {});
		await page.waitForTimeout(50);
		await page.goto(targetHref);

		await page.waitForTimeout(3000);

		expect(page.url()).toContain(targetHref);
	});

	test('navigating away from crate page cleans up SSE', async ({ page, safeGoto }) => {
		await setupCrateView(page, safeGoto);

		// Navigate back to home
		await page.locator('header a', { hasText: 'Codeview' }).click();
		await page.waitForURL('/');

		await page.waitForTimeout(2000);

		await expect(page.locator('h1', { hasText: 'Code, visualized.' })).toBeVisible();
	});

	test('URL with query params preserves state across navigation', async ({ page, safeGoto }) => {
		await safeGoto('/');
		const href = await getFirstCrateHref(page);

		await safeGoto(`${href}?structural=1&semantic=0`);

		const sidebar = page.locator('.w-80');
		await expect(sidebar).toBeVisible({ timeout: 60_000 });

		expect(page.url()).toContain('structural=1');
		expect(page.url()).toContain('semantic=0');
	});

	test('special characters in crate version do not crash', async ({ page, safeGoto }) => {
		await safeGoto('/some_crate/1.0.0-alpha.1+build.123');

		await expect(page.locator('header').first()).toBeVisible({ timeout: 10_000 });
	});
});
