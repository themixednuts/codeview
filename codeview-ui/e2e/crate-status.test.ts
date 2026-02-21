import { test, expect, waitForIdle, setupCrateView, hasWorkspaceCrates, getFirstCrateHref } from './fixtures';

test.describe('Crate Loading & Status', () => {
	test('workspace crate loads directly without processing overlay', async ({ page, safeGoto }) => {
		await safeGoto('/');
		const hasWs = await hasWorkspaceCrates(page);
		if (!hasWs) {
			test.skip();
			return;
		}

		const workspaceSection = page.locator('#workspace-crates');
		const firstCard = workspaceSection.locator('a').first();
		const href = await firstCard.getAttribute('href');
		expect(href).toBeTruthy();

		await safeGoto(href!);

		// Should NOT show processing overlay — workspace crates are already parsed
		const sidebar = page.locator('.w-80');
		await expect(sidebar).toBeVisible({ timeout: 15_000 });

		const processingText = page.locator('text=Parsing');
		await expect(processingText).not.toBeVisible({ timeout: 2000 });
	});

	test('sidebar shows crate name and version', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		// Sidebar should show a crate name (font-semibold) and version (text-xs)
		await expect(sidebar.locator('.font-semibold').first()).toBeVisible();
		await expect(sidebar.locator('.text-xs').first()).toBeVisible();
	});

	test('tree loads with clickable nodes', async ({ page, safeGoto }) => {
		const sidebar = await setupCrateView(page, safeGoto);

		const treeLinks = sidebar.locator('.overflow-auto a');
		await expect(treeLinks.first()).toBeVisible({ timeout: 10_000 });
		const linkCount = await treeLinks.count();
		expect(linkCount).toBeGreaterThan(0);
	});

	test('navigating to unknown crate shows loading/failed state', async ({ page, safeGoto }) => {
		await safeGoto('/nonexistent_fake_crate/0.0.0');

		// Should show either loading, processing, or failed state
		const loadingOrFailed = page
			.getByText('Loading nonexistent_fake_crate')
			.or(page.getByText('Failed to parse nonexistent_fake_crate'))
			.or(page.getByText('Parsing nonexistent_fake_crate'));
		await expect(loadingOrFailed.first()).toBeVisible({ timeout: 30_000 });
	});

	test('failed crate shows error message and retry button', async ({ page, safeGoto }) => {
		await safeGoto('/zzzzz_does_not_exist/9.9.9');

		const failedText = page.locator('text=Failed to parse');
		await expect(failedText).toBeVisible({ timeout: 30_000 });

		const retryBtn = page.locator('button', { hasText: 'Retry' });
		await expect(retryBtn).toBeVisible();
	});

	test('retry button transitions back to processing', async ({ page, safeGoto }) => {
		await safeGoto('/zzzzz_does_not_exist/9.9.9');

		const failedText = page.getByText('Failed to parse');
		await expect(failedText).toBeVisible({ timeout: 30_000 });

		const retryBtn = page.locator('button', { hasText: 'Retry' });
		await retryBtn.click();

		const processingOrFailed = page
			.getByText('Parsing zzzzz_does_not_exist')
			.or(page.getByText('Failed to parse'));
		await expect(processingOrFailed.first()).toBeVisible({ timeout: 30_000 });
	});

	test('other workspace crates appear as switcher badges', async ({ page, safeGoto }) => {
		await safeGoto('/');
		const hasWs = await hasWorkspaceCrates(page);
		if (!hasWs) {
			test.skip();
			return;
		}

		const workspaceSection = page.locator('#workspace-crates');
		const cards = workspaceSection.locator('a');
		const count = await cards.count();

		if (count <= 1) {
			test.skip();
			return;
		}

		await cards.first().click();
		await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+/);

		const sidebar = page.locator('.w-80');
		await expect(sidebar).toBeVisible({ timeout: 15_000 });

		const switcherBadges = sidebar.locator('.badge.badge-sm');
		await expect(switcherBadges.first()).toBeVisible({ timeout: 5_000 });
	});
});
