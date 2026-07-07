import type { LayoutServerLoad } from './$types';
import { getAuthState } from '$lib/server/auth';

export const load: LayoutServerLoad = async (event) => {
	const auth = event.locals.auth ?? (await getAuthState(event));
	return { auth };
};
