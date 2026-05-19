import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { initProvider } from '$lib/server/provider';
import { hyphenateCrateName, normalizeCrateName } from '$lib/crate-names';
import { resolve } from '$lib/rpc/helpers';
import { isHosted } from '$lib/platform';

/** Version aliases that should be resolved to a concrete semver and redirected. */
const VERSION_ALIASES = new Set(['latest', 'stable', 'beta', 'nightly']);
const LOAD_TIMEOUT_MS = 120;
const MAX_PREFETCH_TREE_CHILDREN = 64;

function withTimeout<T>(promise: Promise<T>, fallback: T, timeoutMs = LOAD_TIMEOUT_MS): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((resolve) => {
			setTimeout(() => resolve(fallback), timeoutMs);
		}),
	]);
}

function readExpandedIds(searchParams: URLSearchParams): string[] {
	const raw = searchParams.get('ex');
	if (!raw) return [];
	return raw
		.split(',')
		.map((id) => id.trim())
		.filter(Boolean)
		.slice(0, MAX_PREFETCH_TREE_CHILDREN);
}

export const load: LayoutServerLoad = async (event) => {
	const { crate, version } = event.params;
	if (!crate || !version) return;

	// Allow client-side invalidation when crate status changes (e.g. parsing completes).
	event.depends('app:crateData');

	const provider = await initProvider(event);
	const name = hyphenateCrateName(crate);

	// Resolve version aliases (latest → concrete semver) and redirect
	if (VERSION_ALIASES.has(version)) {
		const resolved = await provider.resolveVersion(name, version);
		if (resolved !== version) {
			const prefix = `/${crate}/${version}`;
			const rest = event.url.pathname.startsWith(prefix)
				? event.url.pathname.slice(prefix.length)
				: '';
			throw redirect(302, `/${crate}/${resolved}${rest}${event.url.search}`);
		}
	}

	if (!isHosted) {
		void provider.ensureParsed?.(name, version).catch((err) => {
			console.error(`ensureParsed failed for ${name}@${version}:`, err);
		});
	}

	// Derive nodeId from URL path (same logic as nodeIdFromPath in url.ts)
	const prefix = `/${crate}/${version}`;
	const rest = event.url.pathname.startsWith(prefix)
		? event.url.pathname.slice(prefix.length).replace(/^\//, '')
		: '';
	const normalizedCrate = normalizeCrateName(crate);
	const nodeId = rest ? `${normalizedCrate}::${rest.replace(/\//g, '::')}` : normalizedCrate;

	const status = await provider.getCrateStatus(name, version);
	if (status.status !== 'ready') {
		return {
			status,
			meta: null,
			roots: null,
			rootChildren: null,
			crateMap: null,
			nodeView: null,
			prefetchedTreeChildren: [],
			nodeId,
		};
	}

	// Resolve re-exported items: URL "syn/2.0.0/Item" → nodeId "syn::Item",
	// but the canonical path is "syn::item::Item". Redirect to the canonical URL
	// so the browser always shows the correct path.
	if (rest && !isHosted) {
		const canonical = await resolve.resolveCanonicalNodeId(name, version, nodeId);
		if (canonical && canonical !== nodeId) {
			const canonicalPath = canonical
				.replace(new RegExp(`^${normalizedCrate}::`), '')
				.replace(/::/g, '/');
			throw redirect(302, `/${crate}/${version}/${canonicalPath}${event.url.search}`);
		}
	}

	// Node detail is primary route content, not a secondary enhancement.
	// Await it in load so SSR and client navigations render the same stable
	// layout instead of committing a pending shell and shifting when data arrives.
	const nodeView = await resolve.nodeView({ name, version, nodeId }).catch(() => null);
	const crateMap =
		rest === ''
			? await provider
					.loadCrateMap(name, version, { maxHierarchyModules: 180, maxMatrixModules: 24 })
					.catch(() => null)
			: null;

	const [meta, roots] = await Promise.all([
		withTimeout(resolve.crateMeta(name, version), null),
		withTimeout(resolve.treeRoots(name, version), null),
	]);

	const rootId = roots?.[0]?.node.id;
	const rootChildrenPromise = rootId
		? withTimeout(resolve.treeChildren(name, version, rootId), [], 80)
		: Promise.resolve(null);

	const prefetchIds = new Set<string>();
	if (nodeView?.ancestors) {
		for (const ancestor of nodeView.ancestors) prefetchIds.add(ancestor.id);
	}
	for (const id of readExpandedIds(event.url.searchParams)) prefetchIds.add(id);

	const [rootChildrenData, prefetchedTreeChildren] = await Promise.all([
		rootChildrenPromise,
		Promise.all(
			Array.from(prefetchIds)
				.filter((id) => id !== rootId)
				.slice(0, MAX_PREFETCH_TREE_CHILDREN)
				.map(async (id) => ({
					id,
					children: await withTimeout(resolve.treeChildren(name, version, id), [], 80),
				})),
		),
	]);

	const rootChildren = rootId
		? {
				id: rootId,
				children: rootChildrenData ?? [],
			}
		: null;

	return {
		status,
		meta,
		roots,
		rootChildren,
		prefetchedTreeChildren,
		crateMap,
		nodeView,
		nodeId,
	};
};
