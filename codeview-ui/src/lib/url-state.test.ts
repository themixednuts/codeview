import { describe, expect, it } from 'vite-plus/test';
import {
	EXPLORER_EX_LIMIT,
	parseExplorerState,
	parseHomeState,
	serializeExplorerState,
	serializeHomeState,
} from './url-state';

function url(search = '') {
	return new URL(`https://codeview.test/std/1.0.0${search}`);
}

describe('url-state', () => {
	it('parses explorer defaults from an empty URL', () => {
		expect(parseExplorerState(url())).toEqual({
			view: 'docs',
			layout: null,
			q: '',
			k: [],
			ex: [],
			gbi: false,
			viz: null,
			td: null,
			sd: null,
			src: null,
			peek: null,
			rel: null,
		});
	});

	it('clamps invalid explorer enum values', () => {
		const state = parseExplorerState(url('?view=bad&layout=wide&viz=force&gbi=0'));
		expect(state.view).toBe('docs');
		expect(state.layout).toBeNull();
		expect(state.viz).toBeNull();
		expect(state.gbi).toBe(false);
	});

	it('normalizes kind facets in project order', () => {
		const state = parseExplorerState(url('?k=Trait&k=module&k=Unknown&k=Struct&k=Trait'));
		expect(state.k).toEqual(['Module', 'Struct', 'Trait']);
	});

	it('sorts, dedupes, and caps expanded ids', () => {
		const ids = Array.from({ length: EXPLORER_EX_LIMIT + 8 }, (_, i) =>
			`std::m${String(EXPLORER_EX_LIMIT + 8 - i).padStart(2, '0')}`,
		);
		const state = parseExplorerState(url(`?ex=${ids.join(',')},std::m01`));
		expect(state.ex).toHaveLength(EXPLORER_EX_LIMIT);
		expect(state.ex[0]).toBe('std::m01');
		expect(state.ex).toEqual([...state.ex].sort());
	});

	it('round-trips and normalizes explorer state while preserving unrelated params', () => {
		const next = serializeExplorerState(url('?perf=1&k=Trait&ex=z,a&view=bad'), {
			view: 'graph',
			layout: 'reading',
			q: ' Vec ',
			k: ['Function', 'Module', 'Function'],
			ex: ['beta', 'alpha', 'alpha'],
			gbi: true,
			viz: 'sunburst',
			td: 'std::alloc',
			sd: null,
			src: 'library/std/src/lib.rs:10:12',
			peek: 'std::vec::Vec',
			rel: 'uses',
		});

		expect(next.searchParams.get('perf')).toBe('1');
		expect(next.searchParams.getAll('k')).toEqual(['Module', 'Function']);
		expect(next.searchParams.get('ex')).toBe('alpha,beta');
		expect(parseExplorerState(next)).toMatchObject({
			view: 'graph',
			layout: 'reading',
			q: 'Vec',
			gbi: true,
			viz: 'sunburst',
			td: 'std::alloc',
			sd: null,
			src: 'library/std/src/lib.rs:10:12',
			peek: 'std::vec::Vec',
			rel: 'uses',
		});
	});

	it('deletes default and empty explorer params on serialize', () => {
		const next = serializeExplorerState(
			url('?view=graph&layout=split&q=old&k=Trait&ex=a&gbi=1&viz=grid&td=a&sd=b&src=c&peek=d&rel=e'),
			{
				view: 'docs',
				layout: null,
				q: '',
				k: [],
				ex: [],
				gbi: false,
				viz: null,
				td: null,
				sd: null,
				src: null,
				peek: null,
				rel: null,
			},
		);
		expect(next.search).toBe('');
	});

	it('parses and serializes home state', () => {
		expect(parseHomeState(url('?q=serde&tab=popular'))).toEqual({
			q: 'serde',
			tab: 'popular',
		});
		expect(parseHomeState(url('?tab=missing'))).toEqual({ q: '', tab: 'workspace' });

		const next = serializeHomeState(url('?tab=popular&q=old&debug=1'), {
			q: ' tokio ',
			tab: 'workspace',
		});
		expect(next.searchParams.get('debug')).toBe('1');
		expect(next.searchParams.get('q')).toBe('tokio');
		expect(next.searchParams.has('tab')).toBe(false);
	});
});
