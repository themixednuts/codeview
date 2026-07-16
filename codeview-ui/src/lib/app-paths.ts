import { base } from '$app/paths';
import type { ResolvedPathname } from '$app/types';

export function resolveAppPath(path: string): ResolvedPathname {
	if (!path.startsWith('/')) {
		throw new TypeError(`Expected an absolute app path, received: ${path}`);
	}

	const alreadyBased =
		base.length > 0 &&
		(path === base ||
			path.startsWith(`${base}/`) ||
			path.startsWith(`${base}?`) ||
			path.startsWith(`${base}#`));
	return (alreadyBased ? path : `${base}${path}`) as ResolvedPathname;
}
