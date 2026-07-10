import { describe, expect, it } from 'vitest';
import { parseDocumentation } from './documentation';

describe('rustdoc documentation segments', () => {
	it('captures fenced code without exposing its structural marker', () => {
		const segments = parseDocumentation(
			[
				'Before.',
				'',
				'```rust,no_run',
				'# let hidden = true;',
				'let visible = 42;',
				'```',
				'',
				'After.',
			].join('\n'),
		);

		expect(segments).toEqual([
			expect.objectContaining({ type: 'text', html: '<p>Before.</p>' }),
			{ type: 'code', content: 'let visible = 42;', lang: 'rust' },
			expect.objectContaining({ type: 'text', html: '<p>After.</p>' }),
		]);
	});

	it('does not treat a user-authored marker as a code block', () => {
		const segments = parseDocumentation('<div data-codeview-code-block="0"></div>');

		expect(segments).toHaveLength(1);
		const segment = segments[0];
		expect(segment).toMatchObject({ type: 'text' });
		if (segment?.type !== 'text') throw new Error('expected a text segment');
		expect(segment.html).toContain('&lt;div data-codeview-code-block=');
	});
});
