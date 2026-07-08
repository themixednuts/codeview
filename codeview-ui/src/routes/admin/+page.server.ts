import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getAuthState } from '$lib/server/auth';
import { initProvider } from '$lib/server/provider';
import { isValidCrateName, isValidVersion, normalizeCrateName } from '$lib/server/validation';
import { isStdCrate } from '$lib/std';

const HOSTED_SYSROOT_PARSE_CHANNEL = 'nightly';

export const load: PageServerLoad = async (event) => {
	event.depends('codeview:admin-dashboard');
	const auth = event.locals.auth ?? (await getAuthState(event));
	if (!auth.isAdmin) {
		throw redirect(303, '/');
	}

	const provider = await initProvider(event);
	if (!provider.getAdminDashboard) {
		return {
			auth,
			dashboard: null,
			loadError: 'Admin dashboard is not available in this deployment.',
		};
	}

	const dashboard = await provider.getAdminDashboard(100).catch((err) => {
		console.warn('admin dashboard load failed', err);
		return null;
	});

	return {
		auth,
		dashboard,
		loadError: dashboard ? null : 'Admin dashboard data is unavailable.',
	};
};

export const actions: Actions = {
	forceParse: async (event) => {
		const auth = event.locals.auth ?? (await getAuthState(event));
		if (!auth.isAdmin) {
			throw redirect(303, '/');
		}

		const form = await event.request.formData();
		const name = String(form.get('name') ?? '').trim();
		const requestedVersion = String(form.get('version') ?? 'latest').trim() || 'latest';
		if (!isValidCrateName(name)) {
			return fail(400, {
				type: 'forceParse',
				ok: false,
				message: 'Enter a valid crate name.',
			});
		}

		const provider = await initProvider(event);
		const version =
			requestedVersion === 'latest' && isStdCrate(normalizeCrateName(name))
				? HOSTED_SYSROOT_PARSE_CHANNEL
				: requestedVersion === 'latest'
					? ((await provider.getCrateVersions(name, 1).catch(() => []))[0] ?? requestedVersion)
					: requestedVersion;
		if (!isValidVersion(version)) {
			return fail(400, {
				type: 'forceParse',
				ok: false,
				message: 'Enter a valid version or latest.',
			});
		}

		const result = await provider.triggerParse(name, version, true);
		if (result.isErr()) {
			return fail(result.error._tag === 'RateLimitError' ? 429 : 422, {
				type: 'forceParse',
				ok: false,
				message: result.error.message,
			});
		}

		return {
			type: 'forceParse',
			ok: true,
			message: `Forced parse queued for ${name}@${version}.`,
			name,
			version,
		};
	},
};
