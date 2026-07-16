import { isValidCrateNameParam, isValidVersionParam } from '$lib/crate-ref';
import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ url }) => {
	const crate = url.searchParams.get('crate') ?? '';
	const version = url.searchParams.get('version') ?? '';
	const path = (url.searchParams.get('path') ?? '')
		.split('/')
		.map((part) => encodeURIComponent(part))
		.join('/');
	const query = url.searchParams.get('query') ?? '';

	if (!isValidCrateNameParam(crate) || !isValidVersionParam(version)) redirect(303, '/');
	redirect(
		303,
		`/${encodeURIComponent(crate)}/${encodeURIComponent(version)}${path ? `/${path}` : ''}${query.startsWith('?') ? query : ''}`,
	);
};
