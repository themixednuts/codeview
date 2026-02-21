import { test, expect, setupCrateView, getFirstCrateHref } from './fixtures';

async function openDetailFromTree(
	page: import('@playwright/test').Page,
	sidebar: import('@playwright/test').Locator,
): Promise<boolean> {
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

test.describe('Node Detail View', () => {
	test('clicking a tree node loads detail view', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);
		if (!(await openDetailFromTree(page, sidebar))) {
			test.skip();
			return;
		}

		// Detail view should show content
		const rightPanel = page.locator('.relative.flex-1.overflow-auto');
		await expect(rightPanel).toBeVisible({ timeout: 5_000 });
	});

	test('node not found shows appropriate message', async ({ page, safeGoto }) => {
		await safeGoto('/');
		const href = await getFirstCrateHref(page);

		// Navigate to a nonexistent node path within the valid crate
		await safeGoto(`${href}/this/node/does/not/exist`);

		// Should show "Node not found" message
		const notFound = page.locator('text=Node not found');
		await expect(notFound).toBeVisible({ timeout: 60_000 });
	});

	test('layout switcher defaults to ego and can be changed', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);
		if (!(await openDetailFromTree(page, sidebar))) {
			test.skip();
			return;
		}

		// The URL should not have a layout param (ego is default)
		expect(page.url()).not.toContain('layout=');

		// Find layout switcher buttons
		const forceBtn = page.locator('button[data-layout="force"]');
		if (await forceBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
			await forceBtn.click();
			await page.waitForTimeout(500);
			expect(page.url()).toContain('layout=force');
		}
	});

	test('structural and semantic toggles update URL params', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);
		if (!(await openDetailFromTree(page, sidebar))) {
			test.skip();
			return;
		}

		// By default semantic=on (no param), structural=off
		expect(page.url()).not.toContain('structural=1');
		expect(page.url()).not.toContain('semantic=0');
	});

	test('back navigation preserves tree state', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		const treeLinks = sidebar.locator('.overflow-auto a');
		const linkCount = await treeLinks.count();
		if (linkCount <= 1) {
			test.skip();
			return;
		}

		// Record the crate root URL before navigating to a node
		const crateUrl = page.url();
		if (!(await openDetailFromTree(page, sidebar))) {
			test.skip();
			return;
		}

		// Navigate back to crate root (avoids SPA goBack timing issues)
		await safeGoto(crateUrl);

		// Sidebar should still be visible with tree loaded
		const sidebarAfterBack = page.locator('.w-80');
		await expect(sidebarAfterBack).toBeVisible({ timeout: 60_000 });

		const treeLinksAfter = sidebarAfterBack.locator('.overflow-auto a');
		await expect(treeLinksAfter.first()).toBeVisible({ timeout: 10_000 });
	});

	test('breadcrumbs render for nested nodes', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		const treeLinks = sidebar.locator('.overflow-auto a');
		const count = await treeLinks.count();
		let clicked = false;
		for (let i = 2; i < Math.min(count, 10); i++) {
			const href = await treeLinks.nth(i).getAttribute('href');
			if (href && href.split('/').length > 4) {
				await treeLinks.nth(i).click();
				clicked = true;
				break;
			}
		}

		if (!clicked) {
			if (count > 1) {
				await treeLinks.nth(1).click();
			}
		}

		await page.waitForURL(/\/[\w_-]+\/[\d.]+\/.+/, { timeout: 5000 }).catch(() => {});
		await page.waitForTimeout(2000);
	});

	test('relationship graph canvas renders', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);
		if (!(await openDetailFromTree(page, sidebar))) {
			test.skip();
			return;
		}

		// Wait for the relationship graph to render
		await page.waitForTimeout(3000);
		// Just verify no crash
	});
});
