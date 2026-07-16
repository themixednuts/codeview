import { describe, expect, it } from 'vitest';
import { paginationHref, readPageParam } from './pagination';

describe('pagination URL state', () => {
	it('clamps invalid pages to the available range', () => {
		expect(
			readPageParam(new URL('https://codeview.test/queue?recentPage=99'), 'recentPage', 4),
		).toBe(4);
		expect(
			readPageParam(new URL('https://codeview.test/queue?recentPage=-2'), 'recentPage', 4),
		).toBe(1);
	});

	it('preserves unrelated query state', () => {
		expect(
			paginationHref(new URL('https://codeview.test/queue?activePage=2'), 'recentPage', 3),
		).toBe('/queue?activePage=2&recentPage=3');
	});
});
