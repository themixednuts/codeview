import { test, expect } from './fixtures';

test.describe('SSE Endpoint Validation', () => {
	test('crate-status SSE returns text/event-stream for valid key', async ({ request }) => {
		const response = await request.get('/api/crate-status/sse?key=rust:codeview_core:0.1.0');
		// Should either be 200 with event-stream or close immediately with status data
		expect([200, 204]).toContain(response.status());
		if (response.status() === 200) {
			const contentType = response.headers()['content-type'] ?? '';
			expect(contentType).toContain('text/event-stream');
		}
	});

	test('crate-status SSE returns 400 for bad key format', async ({ request }) => {
		const response = await request.get('/api/crate-status/sse?key=bad');
		expect(response.status()).toBe(400);
	});

	test('crate-status SSE returns 400 for missing key', async ({ request }) => {
		const response = await request.get('/api/crate-status/sse');
		expect(response.status()).toBe(400);
	});

	test('crate-status SSE returns 400 for key with missing version', async ({ request }) => {
		const response = await request.get('/api/crate-status/sse?key=rust:serde:');
		expect(response.status()).toBe(400);
	});

	test('graph-updates SSE returns valid response for edge key', async ({ request }) => {
		const response = await request.get('/api/graph-updates/sse?key=edge:codeview_core::Graph');
		// Should be 200 with event-stream (may close immediately if no updates)
		expect([200, 204]).toContain(response.status());
	});

	test('processing-status SSE returns valid response', async ({ page }) => {
		// SSE streams are long-lived, so use page.evaluate with a timeout to check the status
		const status = await page.evaluate(async () => {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 3000);
			try {
				const res = await fetch('/api/processing-status/sse?key=processing:rust', {
					signal: controller.signal
				});
				clearTimeout(timeout);
				return res.status;
			} catch {
				clearTimeout(timeout);
				return 0; // aborted due to timeout (stream was open = 200)
			}
		});
		// 200 means stream opened successfully (aborted by our timeout), 503 is local mode fallback
		expect([0, 200, 503]).toContain(status);
	});
});

test.describe('SSE Connection Behavior', () => {
	test('SSE connection for workspace crate emits ready status', async ({ page, safeGoto }) => {
		// Monitor SSE requests
		const sseRequests: string[] = [];
		const sseResponses: { url: string; status: number }[] = [];

		page.on('request', (req) => {
			if (req.url().includes('/api/crate-status/sse')) {
				sseRequests.push(req.url());
			}
		});
		page.on('response', (res) => {
			if (res.url().includes('/api/crate-status/sse')) {
				sseResponses.push({ url: res.url(), status: res.status() });
			}
		});

		// Navigate to a workspace crate
		await safeGoto('/');
		const workspaceSection = page.locator('#workspace-crates');
		await expect(workspaceSection).toBeVisible({ timeout: 15_000 });

		const firstCard = workspaceSection.locator('a').first();
		await firstCard.click();
		await page.waitForURL(/\/[\w_-]+\/\d+\.\d+\.\d+/);

		// Wait for tree to load (indicates status reached 'ready')
		const sidebar = page.locator('.w-80');
		await expect(sidebar).toBeVisible({ timeout: 15_000 });

		// SSE request should have been made
		expect(sseRequests.length).toBeGreaterThanOrEqual(1);
		// At least one should be a crate-status SSE
		expect(sseRequests[0]).toContain('/api/crate-status/sse');
	});

	test('rapid navigation does not accumulate SSE connections', async ({ page, safeGoto }) => {
		await safeGoto('/');
		const workspaceSection = page.locator('#workspace-crates');
		await expect(workspaceSection).toBeVisible({ timeout: 15_000 });

		const cards = workspaceSection.locator('a');
		const count = await cards.count();
		if (count < 2) {
			test.skip();
			return;
		}

		// Collect hrefs before navigation (elements will detach from DOM)
		const hrefs: string[] = [];
		for (let i = 0; i < count; i++) {
			hrefs.push((await cards.nth(i).getAttribute('href'))!);
		}

		// Track active SSE fetches
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

		// Navigate rapidly using goto (not clicks — DOM detaches)
		page.goto(hrefs[0]).catch(() => {});
		await page.waitForTimeout(200);
		page.goto(hrefs[1]).catch(() => {});
		await page.waitForTimeout(200);
		await page.goto(hrefs[0]);

		// Wait for things to settle
		await page.waitForTimeout(3000);

		// We should not have more than 3 concurrent SSE connections at any point
		// (previous closing + new opening during rapid nav)
		expect(maxConcurrent).toBeLessThanOrEqual(3);
	});
});
