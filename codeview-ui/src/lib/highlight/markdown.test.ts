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

	it('renders safe rustdoc HTML while removing executable and style content', () => {
		const html = renderMarkdown(
			[
				'<style> .badges { display: none; } </style>',
				'<div class=“badges”>',
				'[![crate](https://img.shields.io/crates/v/demo.svg)](https://crates.io/crates/demo)',
				'</div>',
				'<img src="https://example.com/demo.png" onerror="globalThis.pwned=true">',
				'<script>globalThis.pwned=true</script>',
			].join('\n'),
		);

		expect(html).toContain('<div>');
		expect(html).toContain('<img src="https://img.shields.io/crates/v/demo.svg"');
		expect(html).toContain('loading="lazy"');
		expect(html).not.toContain('&lt;div');
		expect(html).not.toContain('<style');
		expect(html).not.toContain('.badges');
		expect(html).not.toContain('<script');
		expect(html).not.toContain('globalThis.pwned');
		expect(html).not.toContain('onerror');
	});

	it('removes unsafe URL schemes from raw rustdoc HTML', () => {
		const html = renderMarkdown('<a href="javascript:globalThis.pwned=true">unsafe</a>');

		expect(html).toContain('<a>unsafe</a>');
		expect(html).not.toContain('javascript:');
	});

	it('writes resolved app routes into intra-doc anchors', () => {
		const html = renderMarkdown(
			'Use [`Item`].',
			{ Item: 'demo::module::Item' },
			(nodeId) => `/demo/1.0.0/${nodeId.split('::').slice(1).join('/')}`,
		);

		expect(html).toContain('href="/demo/1.0.0/module/Item"');
		expect(html).toContain('data-node-id="demo::module::Item"');
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
