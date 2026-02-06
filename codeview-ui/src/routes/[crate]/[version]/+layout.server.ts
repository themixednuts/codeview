import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { initProvider } from '$lib/server/provider';
import { hyphenateCrateName } from '$lib/crate-names';

/** Version aliases that should be resolved to a concrete semver and redirected. */
const VERSION_ALIASES = new Set(['latest', 'stable', 'beta', 'nightly']);

export const load: LayoutServerLoad = async (event) => {
	const { crate, version } = event.params;
	if (!crate || !version || !VERSION_ALIASES.has(version)) return;

	const provider = await initProvider(event);
	const resolved = await provider.resolveVersion(
		hyphenateCrateName(crate),
		version,
	);

	if (resolved !== version) {
		// Replace only the version segment in the pathname, preserving
		// the crate name and any trailing [...path] segments.
		const prefix = `/${crate}/${version}`;
		const rest = event.url.pathname.startsWith(prefix)
			? event.url.pathname.slice(prefix.length)
			: '';
		redirect(302, `/${crate}/${resolved}${rest}${event.url.search}`);
	}
};
