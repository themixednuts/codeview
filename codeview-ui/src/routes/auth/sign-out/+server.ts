import { createAuth } from '$lib/server/auth';
import { safeReturnPath } from '$lib/server/safe-return';
import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const auth = createAuth(event);
	if (!auth) error(503, 'Authentication is not configured');

	const form = await event.request.formData();
	await auth.api.signOut({ headers: event.request.headers });
	redirect(303, safeReturnPath(form.get('returnTo')));
};
