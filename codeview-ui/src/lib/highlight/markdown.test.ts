import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

describe('rustdoc markdown links', () => {
	it('resolves rustdoc href aliases and shortcut code references', () => {
		const html = renderMarkdown(
			[
				'Implementations support [`Rng::random_range(Range)`](RngExt::random_range).',
				'Use [`Uniform::new`] or [`Uniform::new_inclusive`].',
				'Implement [`Distribution<T>`] and call [`RngExt::random`].',
				'Keep `From<Range>` as code.',
			].join('\n'),
			{
				'RngExt::random_range': 'rand::RngExt::random_range',
				'Uniform::new': 'rand::distr::Uniform::new',
				'Uniform::new_inclusive': 'rand::distr::Uniform::new_inclusive',
				'`Distribution<T>`': 'rand::distr::Distribution',
				'`RngExt::random`': 'rand::RngExt::random',
			},
		);

		expect(html).toContain('href="#rand::RngExt::random_range"');
		expect(html).toContain('data-node-id="rand::RngExt::random_range"');
		expect(html).toContain('href="#rand::distr::Uniform::new"');
		expect(html).toContain('href="#rand::distr::Uniform::new_inclusive"');
		expect(html).toContain('href="#rand::distr::Distribution"');
		expect(html).toContain('<code>Distribution&lt;T&gt;</code>');
		expect(html).toContain('href="#rand::RngExt::random"');
		expect(html).toContain('<code>From&lt;Range&gt;</code>');
	});

	it('escapes raw HTML from crate documentation', () => {
		const html = renderMarkdown(
			'<img src=x onerror="globalThis.pwned=true"><script>globalThis.pwned=true</script>',
		);

		expect(html).not.toContain('<img');
		expect(html).not.toContain('<script>');
		expect(html).toContain('&lt;img');
		expect(html).toContain('&lt;script&gt;');
	});

	it('keeps per-render link maps isolated', () => {
		const first = renderMarkdown('[`Item`]', { Item: 'first::Item' });
		const second = renderMarkdown('[`Item`]', { Item: 'second::Item' });

		expect(first).toContain('href="#first::Item"');
		expect(first).not.toContain('second::Item');
		expect(second).toContain('href="#second::Item"');
		expect(second).not.toContain('first::Item');
	});

	it('resolves rustdoc reference-style links using their visible label', () => {
		const html = renderMarkdown('The complete list is [here][crate::de].', {
			'crate::de': 'serde::de',
		});

		expect(html).toContain('href="#serde::de"');
		expect(html).toContain('data-node-id="serde::de"');
		expect(html).toContain('>here</a>');
		expect(html).not.toContain('[here]');
		expect(html).not.toContain('crate::de');
	});
});
