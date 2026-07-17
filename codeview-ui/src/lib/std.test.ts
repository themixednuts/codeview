import { describe, expect, test } from 'vitest';
import { searchToolchainCrates } from './std';

describe('searchToolchainCrates', () => {
	test('defaults bare crate searches to all channels with stable first', () => {
		expect(searchToolchainCrates('std').map(({ name, version }) => `${name}@${version}`)).toEqual([
			'std@stable',
			'std@beta',
			'std@nightly',
		]);
	});

	test('supports explicit channel qualifiers', () => {
		expect(searchToolchainCrates('core@nightly')).toMatchObject([
			{ id: 'core', name: 'core', version: 'nightly' },
		]);
		expect(searchToolchainCrates('alloc beta')).toMatchObject([
			{ id: 'alloc', name: 'alloc', version: 'beta' },
		]);
	});

	test('normalizes proc macro spelling variants', () => {
		for (const query of ['proc_macro@stable', 'proc-macro@stable', 'proc macro stable']) {
			expect(searchToolchainCrates(query)).toMatchObject([
				{ id: 'proc-macro', name: 'proc_macro', version: 'stable' },
			]);
		}
	});

	test('can discover every toolchain crate by channel', () => {
		expect(searchToolchainCrates('nightly').map(({ name }) => name)).toEqual([
			'std',
			'core',
			'alloc',
			'proc_macro',
			'test',
		]);
	});
});
