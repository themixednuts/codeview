import { defineConfig } from '@playwright/test';

const PORT = 8787;

export default defineConfig({
	testDir: './e2e',
	testMatch: '**/*.test.ts',
	fullyParallel: false,
	workers: 1,
	retries: 1, // Svelte 5 event delegation can occasionally miss clicks
	timeout: 30_000,
	expect: { timeout: 10_000 },
	use: {
		baseURL: `http://127.0.0.1:${PORT}`,
		trace: 'on-first-retry',
		screenshot: 'only-on-failure'
	},
	projects: [
		{
			name: 'chromium',
			use: { browserName: 'chromium' }
		}
	],
	webServer: {
		command: 'bun run e2e/run-cf-dev-supervisor.mjs',
		port: PORT,
		timeout: 120_000,
		reuseExistingServer: !process.env.CI
	}
});
