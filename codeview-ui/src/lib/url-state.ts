import type { NodeKind } from '$lib/schema';
import { nodeKindOrder } from '$lib/display-names';

export const EXPLORER_EX_LIMIT = 64;

export type ExplorerViewMode = 'docs' | 'graph';
export type ExplorerDocLayout = 'classic' | 'reading' | 'split';
export type ExplorerVizMode = 'graph' | 'treemap' | 'sunburst' | 'grid';
export type HomeTab = 'workspace' | 'popular';

export type ExplorerViewState = {
	view: ExplorerViewMode;
	layout: ExplorerDocLayout | null;
	q: string;
	k: NodeKind[];
	ex: string[];
	gbi: boolean;
	viz: ExplorerVizMode | null;
	td: string | null;
	sd: string | null;
	src: string | null;
	peek: string | null;
	rel: string | null;
};

export type HomeViewState = {
	q: string;
	tab: HomeTab;
};

type HomeStateOptions = {
	defaultTab?: HomeTab;
};

const EXPLORER_VIEW_VALUES = ['docs', 'graph'] as const satisfies readonly ExplorerViewMode[];
const DOC_LAYOUT_VALUES = ['classic', 'reading', 'split'] as const satisfies readonly ExplorerDocLayout[];
const VIZ_VALUES = ['graph', 'treemap', 'sunburst', 'grid'] as const satisfies readonly ExplorerVizMode[];
const HOME_TAB_VALUES = ['workspace', 'popular'] as const satisfies readonly HomeTab[];

const EXPLORER_KEYS = ['view', 'layout', 'q', 'k', 'ex', 'gbi', 'viz', 'td', 'sd', 'src', 'peek', 'rel'];
const HOME_KEYS = ['q', 'tab'];

function readEnum<T extends string>(
	params: URLSearchParams,
	key: string,
	allowed: readonly T[],
	fallback: T,
): T;
function readEnum<T extends string>(
	params: URLSearchParams,
	key: string,
	allowed: readonly T[],
	fallback: T | null,
): T | null;
function readEnum<T extends string>(
	params: URLSearchParams,
	key: string,
	allowed: readonly T[],
	fallback: T | null,
): T | null {
	const raw = params.get(key);
	if (!raw) return fallback;
	return (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

function readText(params: URLSearchParams, key: string): string {
	return (params.get(key) ?? '').trim();
}

function readOptionalText(params: URLSearchParams, key: string): string | null {
	const value = readText(params, key);
	return value ? value : null;
}

function normalizeKinds(rawKinds: readonly string[]): NodeKind[] {
	if (!rawKinds.length) return [];
	const selected = new Set<NodeKind>();
	for (const raw of rawKinds) {
		const match = nodeKindOrder.find((kind) => kind.toLowerCase() === raw.trim().toLowerCase());
		if (match) selected.add(match);
	}
	return nodeKindOrder.filter((kind) => selected.has(kind));
}

function normalizeExpandedIds(rawIds: readonly string[]): string[] {
	if (!rawIds.length) return [];
	const ids = new Set<string>();
	for (const raw of rawIds) {
		const value = raw.trim();
		if (value) ids.add(value);
	}
	return Array.from(ids).sort().slice(0, EXPLORER_EX_LIMIT);
}

function readExpandedIds(params: URLSearchParams): string[] {
	const raw = params.get('ex');
	if (!raw) return [];
	return normalizeExpandedIds(raw.split(','));
}

function applyPatch<T extends object>(base: T, patch: Partial<T>): T {
	const next = { ...base };
	for (const [key, value] of Object.entries(patch) as Array<[keyof T, T[keyof T] | undefined]>) {
		if (value !== undefined) next[key] = value as T[keyof T];
	}
	return next;
}

function resetParams(url: URL, keys: readonly string[]) {
	for (const key of keys) url.searchParams.delete(key);
}

function setText(params: URLSearchParams, key: string, value: string | null | undefined) {
	const normalized = value?.trim();
	if (normalized) params.set(key, normalized);
}

export function parseExplorerState(url: URL): ExplorerViewState {
	const { searchParams } = url;
	return {
		view: readEnum(searchParams, 'view', EXPLORER_VIEW_VALUES, 'docs'),
		layout: readEnum(searchParams, 'layout', DOC_LAYOUT_VALUES, null),
		q: readText(searchParams, 'q'),
		k: normalizeKinds(searchParams.getAll('k')),
		ex: readExpandedIds(searchParams),
		gbi: searchParams.get('gbi') === '1',
		viz: readEnum(searchParams, 'viz', VIZ_VALUES, null),
		td: readOptionalText(searchParams, 'td'),
		sd: readOptionalText(searchParams, 'sd'),
		src: readOptionalText(searchParams, 'src'),
		peek: readOptionalText(searchParams, 'peek'),
		rel: readOptionalText(searchParams, 'rel'),
	};
}

export function serializeExplorerState(base: URL, patch: Partial<ExplorerViewState>): URL {
	const current = parseExplorerState(base);
	const next = applyPatch(current, patch);
	const url = new URL(base);
	resetParams(url, EXPLORER_KEYS);

	if (next.view !== 'docs') url.searchParams.set('view', next.view);
	if (next.layout) url.searchParams.set('layout', next.layout);
	setText(url.searchParams, 'q', next.q);
	for (const kind of normalizeKinds(next.k ?? [])) url.searchParams.append('k', kind);
	const expandedIds = normalizeExpandedIds(next.ex ?? []);
	if (expandedIds.length) url.searchParams.set('ex', expandedIds.join(','));
	if (next.gbi) url.searchParams.set('gbi', '1');
	if (next.viz) url.searchParams.set('viz', next.viz);
	setText(url.searchParams, 'td', next.td);
	setText(url.searchParams, 'sd', next.sd);
	setText(url.searchParams, 'src', next.src);
	setText(url.searchParams, 'peek', next.peek);
	setText(url.searchParams, 'rel', next.rel);

	return url;
}

export function parseHomeState(url: URL, options: HomeStateOptions = {}): HomeViewState {
	const { searchParams } = url;
	const defaultTab = options.defaultTab ?? 'workspace';
	return {
		q: readText(searchParams, 'q'),
		tab: readEnum(searchParams, 'tab', HOME_TAB_VALUES, defaultTab),
	};
}

export function serializeHomeState(
	base: URL,
	patch: Partial<HomeViewState>,
	options: HomeStateOptions = {},
): URL {
	const defaultTab = options.defaultTab ?? 'workspace';
	const current = parseHomeState(base, { defaultTab });
	const next = applyPatch(current, patch);
	const url = new URL(base);
	resetParams(url, HOME_KEYS);

	setText(url.searchParams, 'q', next.q);
	if (next.tab !== defaultTab) url.searchParams.set('tab', next.tab);

	return url;
}
