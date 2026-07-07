import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { initProvider, type ParseQueueSnapshot } from '$lib/server/provider';
import { getAuthState } from '$lib/server/auth';
import { isValidCrateName, isValidVersion } from '$lib/server/validation';

const emptySnapshot: ParseQueueSnapshot = {
	active: [],
	activeRuns: [],
	recent: [],
	planned: null,
};

export const load: PageServerLoad = async (event) => {
	const provider = await initProvider(event);
	const [snapshot, auth] = await Promise.all([
		provider.getParseQueue ? provider.getParseQueue(100).catch(() => emptySnapshot) : emptySnapshot,
		event.locals.auth ?? getAuthState(event),
	]);

	return {
		snapshot,
		auth,
	};
};

export const actions: Actions = {
	forceParse: async (event) => {
		const auth = event.locals.auth ?? (await getAuthState(event));
		if (!auth.isAdmin) {
			return fail(403, {
				type: 'forceParse',
				ok: false,
				message: 'Admin access is required to force a parse.',
			});
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
			requestedVersion === 'latest'
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
