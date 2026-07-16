import { createAuth } from '$lib/server/auth';
import { safeReturnPath } from '$lib/server/safe-return';
import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const auth = createAuth(event);
	if (!auth) error(503, 'GitHub sign-in is not configured');

	const form = await event.request.formData();
	const callbackURL = safeReturnPath(form.get('returnTo'));
	const result = await auth.api.signInSocial({
		body: { provider: 'github', callbackURL },
		headers: event.request.headers,
	});

	if (!result.url) error(502, 'GitHub sign-in did not return a redirect');
	redirect(303, result.url);
};
