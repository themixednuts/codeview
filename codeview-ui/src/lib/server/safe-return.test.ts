import { describe, expect, it } from 'vitest';
import { safeReturnPath } from './safe-return';

describe('safeReturnPath', () => {
	it('keeps local paths with query and hash', () => {
		expect(safeReturnPath('/serde/1.0.228?q=enum#docs')).toBe('/serde/1.0.228?q=enum#docs');
	});

	it.each(['https://example.com', '//example.com', 'crate/path', '', null])(
		'rejects non-local return targets: %s',
		(value) => expect(safeReturnPath(value)).toBe('/'),
	);
});
