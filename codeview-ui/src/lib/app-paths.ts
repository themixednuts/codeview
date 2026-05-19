import { resolve } from '$app/paths';
import type { PathnameWithSearchOrHash, ResolvedPathname } from '$app/types';

export function resolveAppPath(path: string): ResolvedPathname {
	return resolve(path as PathnameWithSearchOrHash);
}
