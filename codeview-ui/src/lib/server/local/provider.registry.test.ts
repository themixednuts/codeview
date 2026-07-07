import { afterEach, describe, expect, test, vi } from 'vitest';
import { createLocalProvider } from './provider';

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}

describe('local provider registry discovery', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test('returns crates.io search results with route-safe crate ids', async () => {
		const fetchMock = vi.fn(
			async (_input: string | URL | Request, _init?: RequestInit) =>
				jsonResponse({
					crates: [
						{
							id: 'serde_json',
							name: 'serde_json',
							description: 'A JSON serialization file format',
							repository: 'https://github.com/serde-rs/json',
							max_version: '1.0.145',
						},
					],
				}),
		);
		vi.stubGlobal('fetch', fetchMock);

		const results = await createLocalProvider().searchRegistry('serde');

		expect(fetchMock.mock.calls[0][0]).toBe('https://crates.io/api/v1/crates?q=serde&per_page=20');
		expect(results).toEqual([
			{
				id: 'serde-json',
				name: 'serde_json',
				version: '1.0.145',
				description: 'A JSON serialization file format',
			},
		]);
	});

	test('returns crates.io popular crates with route-safe crate ids', async () => {
		const fetchMock = vi.fn(
			async (_input: string | URL | Request, _init?: RequestInit) =>
				jsonResponse({
					crates: [
						{
							id: 'rand_core',
							name: 'rand_core',
							description: 'Core random number generator traits',
							repository: 'https://github.com/rust-random/rand',
							max_version: '0.9.3',
						},
					],
				}),
		);
		vi.stubGlobal('fetch', fetchMock);

		const results = await createLocalProvider().getTopCrates(10);

		expect(fetchMock.mock.calls[0][0]).toBe(
			'https://crates.io/api/v1/crates?sort=downloads&per_page=10',
		);
		expect(results).toEqual([
			{
				id: 'rand-core',
				name: 'rand_core',
				version: '0.9.3',
				description: 'Core random number generator traits',
			},
		]);
	});
});
