import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { initProvider } from '$lib/server/provider';
import { hyphenateCrateName, normalizeCrateName } from '$lib/crate-names';
import { resolve } from '$lib/rpc/helpers';

/** Version aliases that should be resolved to a concrete semver and redirected. */
const VERSION_ALIASES = new Set(['latest', 'stable', 'beta', 'nightly']);
const LOAD_TIMEOUT_MS = 120;

function withTimeout<T>(promise: Promise<T>, fallback: T, timeoutMs = LOAD_TIMEOUT_MS): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((resolve) => {
			setTimeout(() => resolve(fallback), timeoutMs);
		}),
	]);
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

	// Kick off parsing without blocking SSR.
	// Small crates complete quickly; large crates stream data as they parse.
	void provider.ensureParsed?.(name, version).catch((err) => {
		console.error(`ensureParsed failed for ${name}@${version}:`, err);
	});

	// Derive nodeId from URL path (same logic as nodeIdFromPath in url.ts)
	const prefix = `/${crate}/${version}`;
	const rest = event.url.pathname.startsWith(prefix)
		? event.url.pathname.slice(prefix.length).replace(/^\//, '')
		: '';
	const normalizedCrate = normalizeCrateName(crate);
	const nodeId = rest
		? `${normalizedCrate}::${rest.replace(/\//g, '::')}`
		: normalizedCrate;

	const status = await provider.getCrateStatus(name, version);
	if (status.status !== 'ready') {
		// Crate not ready — return null for nodeView.
		// The client-side query handles fetching once status → ready.
		return {
			meta: null,
			roots: null,
			rootChildren: null,
			nodeView: null,
			nodeId,
		};
	}

	// Resolve re-exported items: URL "syn/2.0.0/Item" → nodeId "syn::Item",
	// but the canonical path is "syn::item::Item". Redirect to the canonical URL
	// so the browser always shows the correct path.
	if (rest) {
		const canonical = await resolve.resolveCanonicalNodeId(name, version, nodeId);
		if (canonical && canonical !== nodeId) {
			const canonicalPath = canonical
				.replace(new RegExp(`^${normalizedCrate}::`), '')
				.replace(/::/g, '/');
			throw redirect(302, `/${crate}/${version}/${canonicalPath}${event.url.search}`);
		}
	}

	// Stream nodeView — don't await it so the page shell renders immediately.
	// SvelteKit streams the resolved value to the browser.
	// DetailView's <svelte:boundary pending={…}> shows a loading state during SSR,
	// then renders the actual content once the promise resolves on the client.
	const nodeView = resolve.nodeView({ name, version, nodeId }).catch(() => null);

	const [meta, roots] = await Promise.all([
		withTimeout(resolve.crateMeta(name, version), null),
		withTimeout(resolve.treeRoots(name, version), null),
	]);

	const rootId = roots?.[0]?.node.id;
	const rootChildren = rootId
		? {
				id: rootId,
				children: await withTimeout(resolve.treeChildren(name, version, rootId), [], 80),
			}
		: null;

	return {
		meta,
		roots,
		rootChildren,
		nodeView,
		nodeId,
	};
};
