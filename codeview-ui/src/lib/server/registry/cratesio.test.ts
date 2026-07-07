import { afterEach, describe, expect, test, vi } from 'vitest';
import { createCratesIoAdapter } from './cratesio';

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}

describe('crates.io registry adapter', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test('lists popular crates by all-time downloads', async () => {
		const fetchMock = vi.fn(
			async (_input: string | URL | Request, _init?: RequestInit) =>
				jsonResponse({
					crates: [
						{
							id: 'syn',
							name: 'syn',
							description: 'Parser for Rust source code',
							repository: 'https://github.com/dtolnay/syn',
							max_version: '2.0.108',
						},
					],
				}),
		);
		vi.stubGlobal('fetch', fetchMock);

		const results = await createCratesIoAdapter().listTop(10);

		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock.mock.calls[0][0]).toBe(
			'https://crates.io/api/v1/crates?sort=downloads&per_page=10',
		);
		expect(results).toMatchObject([
			{
				name: 'syn',
				version: '2.0.108',
				repository: 'dtolnay/syn',
			},
		]);
	});

	test('uses crates.io canonical crate name for docs.rs artifacts', async () => {
		const fetchMock = vi.fn(
			async (_input: string | URL | Request, _init?: RequestInit) =>
				jsonResponse({
					version: {
						num: '0.9.3',
						dl_path: '/api/v1/crates/rand-core/0.9.3/download',
						crate: 'rand_core',
					},
					crate: {
						id: 'rand_core',
						name: 'rand_core',
						description: 'Core random number generator traits',
						repository: 'https://github.com/rust-random/rand',
						max_version: '0.9.3',
					},
				}),
		);
		vi.stubGlobal('fetch', fetchMock);

		const resolved = await createCratesIoAdapter().resolve('rand-core', '0.9.3');

		expect(resolved).toMatchObject({
			name: 'rand_core',
			version: '0.9.3',
			artifactUrl: 'https://docs.rs/crate/rand_core/0.9.3/json.gz',
			sourceArchiveUrl: 'https://crates.io/api/v1/crates/rand-core/0.9.3/download',
		});
	});
});
