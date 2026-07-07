import { describe, expect, test } from 'vitest';
import { catalogEntryToSummary, orderCatalogSummaries } from './catalog';

describe('cloudflare catalog', () => {
	test('uses version as the concrete crate version', () => {
		expect(
			catalogEntryToSummary({
				name: 'proc_macro',
				storageName: 'proc_macro',
				version: '1.98.0-nightly',
				nodeCount: 10,
				edgeCount: 20,
			}),
		).toMatchObject({
			id: 'proc_macro',
			name: 'proc_macro',
			version: '1.98.0-nightly',
		});
	});

	test('drops malformed entries instead of returning undefined versions', () => {
		expect(
			orderCatalogSummaries([
				{ name: 'bad-crate', version: '' },
				{ name: 'serde', storageName: 'serde', version: '1.0.0' },
			]),
		).toEqual([{ id: 'serde', name: 'serde', version: '1.0.0', description: undefined }]);
	});
});
