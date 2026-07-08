import { describe, expect, it } from 'vite-plus/test';
import { nodeUrl, nodeUrlForRoute } from './url';

describe('node urls', () => {
	it('uses normalized and hyphenated version lookup keys', () => {
		expect(nodeUrl('proc_macro2::Literal', { 'proc-macro2': '1.0.106' })).toBe(
			'/proc-macro2/1.0.106/Literal',
		);
	});

	it('preserves the current route version for same-crate links', () => {
		const href = nodeUrlForRoute(
			'proc_macro2::impl-367',
			{ proc_macro2: 'latest' },
			'proc-macro2',
			'1.0.106',
		);

		expect(href).toBe('/proc-macro2/1.0.106/impl-367');
	});

	it('keeps indexed versions for other crates', () => {
		const href = nodeUrlForRoute(
			'core::fmt::Display',
			{ core: 'stable', proc_macro2: '1.0.106' },
			'proc-macro2',
			'1.0.106',
		);

		expect(href).toBe('/core/stable/fmt/Display');
	});
});
