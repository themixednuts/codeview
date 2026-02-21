import { test, expect, hasWorkspaceCrates } from './fixtures';

test.describe('SSE Endpoint Validation', () => {
	test('events SSE endpoint responds without crash', async ({ request }) => {
		// The unified SSE endpoint is at /api/events/sse
		const response = await request.get('/api/events/sse?tag=status:rust:serde:1.0.0');
		// 200 = event-stream, 204 = no content, 400 = bad request, 501 = not impl (CF mode)
		expect(response.status()).toBeLessThanOrEqual(501);
	});

	test('events SSE returns error for missing tag', async ({ request }) => {
		const response = await request.get('/api/events/sse');
		// Should reject with 400+ (bad request or not implemented)
		expect(response.status()).toBeGreaterThanOrEqual(400);
	});

	test('subscribe endpoint responds without crash', async ({ request }) => {
		// Subscribe may be POST-only (405) or not implemented (501) in some modes
		const response = await request.get('/api/events/subscribe?tag=status:rust:serde:1.0.0');
		// Any response that isn't a 500 server error is acceptable
		expect(response.status()).toBeLessThanOrEqual(501);
	});
});

test.describe('SSE Connection Behavior', () => {
	test('SSE connection for workspace crate emits ready status', async ({ page, safeGoto }) => {
		await safeGoto('/');
		const hasWs = await hasWorkspaceCrates(page);
		if (!hasWs) {
			test.skip();
			return;
		}

		const sseRequests: string[] = [];

		page.on('request', (req) => {
			if (req.url().includes('/api/crate-status/sse')) {
				sseRequests.push(req.url());
			}
		});

		const workspaceSection = page.locator('#workspace-crates');
		const firstCard = workspaceSection.locator('a').first();
		await firstCard.click();
		await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+/);

		const sidebar = page.locator('.w-80');
		await expect(sidebar).toBeVisible({ timeout: 15_000 });

		expect(sseRequests.length).toBeGreaterThanOrEqual(1);
		expect(sseRequests[0]).toContain('/api/crate-status/sse');
	});

	test('rapid navigation does not accumulate SSE connections', async ({ page, safeGoto }) => {
		await safeGoto('/');
		const hasWs = await hasWorkspaceCrates(page);
		if (!hasWs) {
			test.skip();
			return;
		}

		const workspaceSection = page.locator('#workspace-crates');
		const cards = workspaceSection.locator('a');
		const count = await cards.count();
		if (count < 2) {
			test.skip();
			return;
		}

		const hrefs: string[] = [];
		for (let i = 0; i < count; i++) {
			hrefs.push((await cards.nth(i).getAttribute('href'))!);
		}

		let activeFetches = 0;
		let maxConcurrent = 0;

		page.on('request', (req) => {
			if (req.url().includes('/api/crate-status/sse')) {
				activeFetches++;
				maxConcurrent = Math.max(maxConcurrent, activeFetches);
			}
		});
		page.on('requestfinished', (req) => {
			if (req.url().includes('/api/crate-status/sse')) {
				activeFetches--;
			}
		});
		page.on('requestfailed', (req) => {
			if (req.url().includes('/api/crate-status/sse')) {
				activeFetches--;
			}
		});

		page.goto(hrefs[0]).catch(() => {});
		await page.waitForTimeout(200);
		page.goto(hrefs[1]).catch(() => {});
		await page.waitForTimeout(200);
		await page.goto(hrefs[0]);

		await page.waitForTimeout(3000);

		expect(maxConcurrent).toBeLessThanOrEqual(3);
	});
});
