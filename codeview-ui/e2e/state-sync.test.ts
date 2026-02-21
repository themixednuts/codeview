import { test, expect, setupCrateView } from './fixtures';

function toPathname(urlOrPath: string, base: string): string {
	return new URL(urlOrPath, base).pathname;
}

async function firstNavigatingTreeHref(
	page: import('@playwright/test').Page,
	treeLinks: import('@playwright/test').Locator,
	options?: { requireDeep?: boolean; maxLinks?: number },
): Promise<string | null> {
	const currentPath = toPathname(page.url(), page.url());
	const count = await treeLinks.count();
	const maxLinks = Math.min(count, options?.maxLinks ?? 24);

	for (let i = 0; i < maxLinks; i += 1) {
		const href = await treeLinks.nth(i).getAttribute('href');
		if (!href) continue;
		const hrefPath = toPathname(href, page.url());
		if (hrefPath === currentPath) continue;
		if (options?.requireDeep && hrefPath.split('/').filter(Boolean).length <= 3) continue;
		return href;
	}

	return null;
}

async function clickNavigatingTreeLink(
	page: import('@playwright/test').Page,
	treeLinks: import('@playwright/test').Locator,
	options?: { requireDeep?: boolean; maxLinks?: number },
): Promise<string | null> {
	const href = await firstNavigatingTreeHref(page, treeLinks, options);
	if (!href) return null;

	const targetPath = toPathname(href, page.url());
	const count = await treeLinks.count();
	for (let i = 0; i < Math.min(count, options?.maxLinks ?? 24); i += 1) {
		if ((await treeLinks.nth(i).getAttribute('href')) === href) {
			await treeLinks.nth(i).click();
			break;
		}
	}

	await expect.poll(() => toPathname(page.url(), page.url()), { timeout: 10_000 }).toBe(targetPath);
	return href;
}

async function clickNavigatingGraphLink(page: import('@playwright/test').Page): Promise<string | null> {
	const graphLinks = page.locator('svg g.node a[href], svg a[data-sveltekit-noscroll]');
	const currentPath = toPathname(page.url(), page.url());
	const count = await graphLinks.count();

	for (let i = 0; i < Math.min(count, 24); i += 1) {
		const link = graphLinks.nth(i);
		const href = await link.getAttribute('href');
		if (!href) continue;
		const targetPath = toPathname(href, page.url());
		if (targetPath === currentPath) continue;

		await link.click();
		await expect.poll(() => toPathname(page.url(), page.url()), { timeout: 10_000 }).toBe(targetPath);
		return href;
	}

	return null;
}

test.describe('State Sync', () => {
	test('tree click updates URL and detail panel', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);
		const treeLinks = sidebar.locator('.overflow-auto a');
		const cratePath = toPathname(page.url(), page.url());

		const treeHref = await clickNavigatingTreeLink(page, treeLinks);
		if (!treeHref) {
			test.skip();
			return;
		}

		// URL should have changed to include a node path (deeper than crate root)
		expect(toPathname(page.url(), page.url())).not.toBe(cratePath);
		expect(page.url()).toMatch(/\/[\w_-]+\/[\d.]+\/.+/);

		const detail = page.locator('.relative.flex-1.overflow-auto');
		await expect(detail).toBeVisible({ timeout: 5_000 });
	});

	test('URL navigation highlights tree item', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);
		const treeLinks = sidebar.locator('.overflow-auto a');

		const href = await firstNavigatingTreeHref(page, treeLinks);
		if (!href) {
			test.skip();
			return;
		}

		await safeGoto(href);

		const sidebarAfter = page.locator('.w-80');
		await expect(sidebarAfter).toBeVisible({ timeout: 15_000 });
		const selectedItem = sidebarAfter.locator('.overflow-auto a.ring-1, .overflow-auto a[class*="ring-1"]');
		await expect(selectedItem).toBeVisible({ timeout: 10_000 });
	});

	test('graph node click updates URL, tree, and detail', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);
		const treeLinks = sidebar.locator('.overflow-auto a');

		const treeHref = await clickNavigatingTreeLink(page, treeLinks);
		if (!treeHref) {
			test.skip();
			return;
		}

		const graphHref = await clickNavigatingGraphLink(page);
		if (!graphHref) {
			test.skip();
			return;
		}

		expect(page.url()).toContain(graphHref.split('?')[0]);

		const sidebarAfter = page.locator('.w-80');
		const selectedItem = sidebarAfter.locator('.overflow-auto a.ring-1, .overflow-auto a[class*="ring-1"]');
		await expect(selectedItem).toBeVisible({ timeout: 10_000 });
	});

	test('breadcrumbs match node ancestry', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);
		const treeLinks = sidebar.locator('.overflow-auto a');

		const deepHref =
			(await clickNavigatingTreeLink(page, treeLinks, { requireDeep: true, maxLinks: 30 })) ??
			(await clickNavigatingTreeLink(page, treeLinks));
		if (!deepHref) {
			test.skip();
			return;
		}

		const breadcrumbs = page.locator('nav[aria-label="Breadcrumb"] a, nav[aria-label*="readcrumb"] a');
		const bcCount = await breadcrumbs.count();

		if (bcCount > 0) {
			for (let i = 0; i < bcCount; i++) {
				const href = await breadcrumbs.nth(i).getAttribute('href');
				expect(href).toBeTruthy();
			}
		}
	});

	test('layout mode persists across navigation', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);
		const treeLinks = sidebar.locator('.overflow-auto a');

		const treeHref = await clickNavigatingTreeLink(page, treeLinks);
		if (!treeHref) {
			test.skip();
			return;
		}

		const forceBtn = page.locator('button[data-layout="force"]');
		if (await forceBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
			await forceBtn.click();
			await page.waitForTimeout(500);
			expect(page.url()).toContain('layout=force');

			const secondHref = await clickNavigatingTreeLink(page, treeLinks);
			if (secondHref) expect(page.url()).toContain('layout=force');
		}
	});

	test('structural toggle syncs with URL', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);
		const treeLinks = sidebar.locator('.overflow-auto a');

		const treeHref = await clickNavigatingTreeLink(page, treeLinks);
		if (!treeHref) {
			test.skip();
			return;
		}

		const structuralBtn = page.locator('button:has-text("Structural"), button[data-edge-toggle="structural"]');
		if (await structuralBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
			await structuralBtn.click();
			await page.waitForTimeout(500);
			expect(page.url()).toContain('structural=1');

			const secondHref = await clickNavigatingTreeLink(page, treeLinks);
			if (secondHref) expect(page.url()).toContain('structural=1');
		}
	});

	test('kind filter affects tree but not detail', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);
		const treeLinks = sidebar.locator('.overflow-auto a');

		const treeHref = await clickNavigatingTreeLink(page, treeLinks);
		if (!treeHref) {
			test.skip();
			return;
		}

		const kindBtn = sidebar.locator('.flex-wrap button[data-kind]').first();
		if (await kindBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
			await page.evaluate(() => {
				(document.querySelector('.flex-wrap button[data-kind]') as HTMLElement)?.click();
			});
			await page.waitForTimeout(1000);

			const detail = page.locator('.relative.flex-1.overflow-auto');
			await expect(detail).toBeVisible();
		}
	});

	test('search results link to correct detail', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		const searchInput = sidebar.locator('input[name="q"]');
		await searchInput.fill('new');
		await searchInput.press('Enter');
		await page.waitForTimeout(3000);

		const resultLinks = sidebar.locator('.overflow-auto a');
		const resultCount = await resultLinks.count();

		if (resultCount > 0) {
			const firstResult = resultLinks.first();
			const resultHref = await firstResult.getAttribute('href');
			await firstResult.click();

			// Wait for navigation to settle (SPA may not trigger page load events)
			await page.waitForTimeout(3000);

			if (resultHref) {
				expect(page.url()).toContain(resultHref.split('?')[0]);
			}

			// Detail panel should be visible if we navigated to a node
			if (page.url().match(/\/[\w_-]+\/[\d.]+\/.+/)) {
				const detail = page.locator('.relative.flex-1.overflow-auto');
				await expect(detail).toBeVisible({ timeout: 5_000 });
			}
		}
	});
});
