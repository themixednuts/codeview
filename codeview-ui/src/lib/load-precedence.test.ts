import { describe, expect, it } from 'vitest';
import { hasNonEmptyArray, preferNonEmptyArray } from './load-precedence';

describe('load precedence', () => {
	it('keeps fresh load data when client cache is empty', () => {
		const loadData = [{ id: 'gpui' }];

		expect(preferNonEmptyArray(loadData, [])).toBe(loadData);
	});

	it('uses client data when load data timed out or is missing', () => {
		const clientData = [{ id: 'gpui' }];

		expect(preferNonEmptyArray(null, clientData)).toBe(clientData);
	});

	it('does not treat empty arrays as available data', () => {
		expect(hasNonEmptyArray([])).toBe(false);
		expect(hasNonEmptyArray([{ id: 'gpui' }])).toBe(true);
	});
});
