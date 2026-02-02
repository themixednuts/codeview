import { defineConfig } from '@playwright/test';

/**
 * The local server (`bun run local`) picks a random port and prints:
 *   Codeview UI running at http://127.0.0.1:{port}
 *
 * We use a fixed port via the PORT env var for test predictability.
 */
const PORT = 4321;

export default defineConfig({
	testDir: './e2e',
	testMatch: '**/*.test.ts',
	fullyParallel: false,
	workers: 1, // SQLite single-writer; SSE state is per-process
	retries: 0, // We want to see real failures
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
		command: `cargo run -p codeview-cli -- ui . --port ${PORT}`,
		cwd: '..',
		port: PORT,
		timeout: 120_000, // Cargo build can be slow
		reuseExistingServer: !process.env.CI
	}
});
