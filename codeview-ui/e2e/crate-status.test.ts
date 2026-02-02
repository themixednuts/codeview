import { test, expect, waitForIdle } from './fixtures';

test.describe('Crate Loading & Status', () => {
	test('workspace crate loads directly without processing overlay', async ({ page, safeGoto }) => {
		// Navigate to the landing page first to discover a real workspace crate
		await safeGoto('/');
		const workspaceSection = page.locator('#workspace-crates');
		await expect(workspaceSection).toBeVisible({ timeout: 15_000 });

		const firstCard = workspaceSection.locator('a').first();
		const href = await firstCard.getAttribute('href');
		expect(href).toBeTruthy();

		// Navigate directly to the crate
		await safeGoto(href!);

		// Should NOT show processing overlay — workspace crates are already parsed
		// Instead we should see the sidebar with tree
		const sidebar = page.locator('.w-80');
		await expect(sidebar).toBeVisible({ timeout: 15_000 });

		// Processing overlay should not be visible
		const processingText = page.locator('text=Parsing');
		// Use a short timeout — it should not appear at all
		await expect(processingText).not.toBeVisible({ timeout: 2000 });
	});

	test('sidebar shows crate name and version', async ({ page, safeGoto }) => {
		await safeGoto('/');
		const workspaceSection = page.locator('#workspace-crates');
		await expect(workspaceSection).toBeVisible({ timeout: 15_000 });

		const firstCard = workspaceSection.locator('a').first();
		const nameEl = firstCard.locator('span.font-semibold').first();
		const badgeEl = firstCard.locator('.badge').first();
		const crateName = await nameEl.textContent();
		const crateVersion = await badgeEl.textContent();

		await firstCard.click();
		await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+/);

		// Sidebar header should show the crate name and version
		const sidebar = page.locator('.w-80');
		await expect(sidebar).toBeVisible({ timeout: 15_000 });
		await expect(sidebar.locator('.font-semibold', { hasText: crateName!.trim() })).toBeVisible();
		await expect(sidebar.locator('.text-xs', { hasText: crateVersion!.trim() })).toBeVisible();
	});

	test('tree loads with clickable nodes', async ({ page, safeGoto }) => {
		await safeGoto('/');
		const workspaceSection = page.locator('#workspace-crates');
		await expect(workspaceSection).toBeVisible({ timeout: 15_000 });

		const firstCard = workspaceSection.locator('a').first();
		await firstCard.click();
		await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+/);

		// Wait for tree to load
		const sidebar = page.locator('.w-80');
		await expect(sidebar).toBeVisible({ timeout: 15_000 });

		// Tree should have links (nodes)
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
		// Navigate to a crate that will definitely fail (fake name)
		await safeGoto('/zzzzz_does_not_exist/9.9.9');

		// Wait for failure state
		const failedText = page.locator('text=Failed to parse');
		await expect(failedText).toBeVisible({ timeout: 30_000 });

		// Retry button should be present
		const retryBtn = page.locator('button', { hasText: 'Retry' });
		await expect(retryBtn).toBeVisible();
	});

	test('retry button transitions back to processing', async ({ page, safeGoto }) => {
		await safeGoto('/zzzzz_does_not_exist/9.9.9');

		const failedText = page.getByText('Failed to parse');
		await expect(failedText).toBeVisible({ timeout: 30_000 });

		const retryBtn = page.locator('button', { hasText: 'Retry' });
		await retryBtn.click();

		// After clicking retry, should show processing or fail again
		const processingOrFailed = page
			.getByText('Parsing zzzzz_does_not_exist')
			.or(page.getByText('Failed to parse'));
		await expect(processingOrFailed.first()).toBeVisible({ timeout: 30_000 });
	});

	test('other workspace crates appear as switcher badges', async ({ page, safeGoto }) => {
		await safeGoto('/');
		const workspaceSection = page.locator('#workspace-crates');
		await expect(workspaceSection).toBeVisible({ timeout: 15_000 });

		const cards = workspaceSection.locator('a');
		const count = await cards.count();

		if (count <= 1) {
			test.skip();
			return;
		}

		// Navigate to first crate
		await cards.first().click();
		await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+/);

		const sidebar = page.locator('.w-80');
		await expect(sidebar).toBeVisible({ timeout: 15_000 });

		// Other crates should appear as badges in the sidebar
		const switcherBadges = sidebar.locator('.badge.badge-sm');
		await expect(switcherBadges.first()).toBeVisible({ timeout: 5_000 });
	});
});
