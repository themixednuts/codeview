import type { Cookies, Handle } from '@sveltejs/kit';
import { setupLogging } from '$lib/log';
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
	THEME_KEY,
	THEME_VALUES,
	VOICE_KEY,
	VOICE_VALUES,
	readAllowedPreference,
} from '$lib/preferences';

await setupLogging();

type HtmlDataAttributes = Record<`data-${string}`, string>;

export const handle: Handle = async ({ event, resolve }) => {
	const htmlAttributes = getHtmlDataAttributes(event.cookies);
	let appliedHtmlAttributes = false;

	return resolve(event, {
		transformPageChunk: ({ html }) => {
			if (appliedHtmlAttributes) return html;

			const nextHtml = setHtmlDataAttributes(html, htmlAttributes);
			appliedHtmlAttributes = nextHtml !== html;
			return nextHtml;
		},
	});
};

function getHtmlDataAttributes(cookies: Cookies): HtmlDataAttributes {
	const themePref = readAllowedPreference(cookies.get(THEME_KEY), THEME_VALUES, 'light');
	const theme = themePref === 'dark' ? 'dark' : 'light';
	const codeThemeLight = readAllowedPreference(
		cookies.get(CODE_LIGHT_KEY),
		CODE_VALUES,
		'solarized-light',
	);
	const codeThemeDark = readAllowedPreference(
		cookies.get(CODE_DARK_KEY),
		CODE_VALUES,
		'solarized-dark',
	);

	return {
		'data-theme': theme,
		'data-accent': readAllowedPreference(cookies.get(ACCENT_KEY), ACCENT_VALUES, 'orange'),
		'data-density': readAllowedPreference(
			cookies.get(DENSITY_KEY),
			DENSITY_VALUES,
			'comfortable',
		),
		'data-voice': readAllowedPreference(cookies.get(VOICE_KEY), VOICE_VALUES, 'editorial'),
		'data-doc-layout': readAllowedPreference(
			cookies.get(DOC_LAYOUT_KEY),
			DOC_LAYOUT_VALUES,
			'classic',
		),
		'data-code-theme': theme === 'dark' ? codeThemeDark : codeThemeLight,
	};
}

function setHtmlDataAttributes(html: string, attributes: HtmlDataAttributes): string {
	return html.replace(/<html\b([^>]*)>/i, (_tag, rawAttributes: string) => {
		let nextAttributes = rawAttributes;

		for (const [name, value] of Object.entries(attributes)) {
			const attribute = `${name}="${escapeHtmlAttribute(value)}"`;
			const pattern = htmlAttributePattern(name);
			nextAttributes = pattern.test(nextAttributes)
				? nextAttributes.replace(pattern, ` ${attribute}`)
				: `${nextAttributes} ${attribute}`;
		}

		return `<html${nextAttributes}>`;
	});
}

function htmlAttributePattern(name: string): RegExp {
	const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`\\s${escapedName}=(?:"[^"]*"|'[^']*'|[^\\s>]*)`, 'i');
}

function escapeHtmlAttribute(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
