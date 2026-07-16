import {
	ACCENT_KEY,
	ACCENT_VALUES,
	CODE_DARK_KEY,
	CODE_LIGHT_KEY,
	CODE_VALUES,
	DENSITY_KEY,
	DENSITY_VALUES,
	DOC_LAYOUT_KEY,
	DOC_LAYOUT_VALUES,
	PREF_COOKIE_MAX_AGE_SECONDS,
	THEME_KEY,
	THEME_VALUES,
	VOICE_KEY,
	VOICE_VALUES,
	readAllowedPreference,
} from '$lib/preferences';
import { safeReturnPath } from '$lib/server/safe-return';
import { redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

const preferences = [
	[THEME_KEY, THEME_VALUES, 'system'],
	[ACCENT_KEY, ACCENT_VALUES, 'orange'],
	[DENSITY_KEY, DENSITY_VALUES, 'comfortable'],
	[VOICE_KEY, VOICE_VALUES, 'editorial'],
	[DOC_LAYOUT_KEY, DOC_LAYOUT_VALUES, 'classic'],
	[CODE_LIGHT_KEY, CODE_VALUES, 'solarized-light'],
	[CODE_DARK_KEY, CODE_VALUES, 'solarized-dark'],
] as const;

function readPreferences(event: RequestEvent) {
	return Object.fromEntries(
		preferences.map(([key, allowed, fallback]) => [
			key,
			readAllowedPreference(event.cookies.get(key), allowed, fallback),
		]),
	);
}

export const load: PageServerLoad = (event) => ({
	preferences: readPreferences(event),
	returnTo: safeReturnPath(event.url.searchParams.get('returnTo')),
});

export const actions: Actions = {
	default: async (event) => {
		const form = await event.request.formData();
		for (const [key, allowed, fallback] of preferences) {
			const value = readAllowedPreference(String(form.get(key) ?? ''), allowed, fallback);
			event.cookies.set(key, value, {
				path: '/',
				maxAge: PREF_COOKIE_MAX_AGE_SECONDS,
				sameSite: 'lax',
				httpOnly: false,
				secure: event.url.protocol === 'https:',
			});
		}
		redirect(303, safeReturnPath(form.get('returnTo')));
	},
};
