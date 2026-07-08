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
});
