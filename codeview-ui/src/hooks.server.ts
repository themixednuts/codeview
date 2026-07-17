import type { Cookies, Handle } from '@sveltejs/kit';
import { setupLogging } from '$lib/log.server';
import { handleWsUpgrade } from '$provider';
import { getAuthState, handleAuthRequest } from '$lib/server/auth';
import {
	ACCENT_KEY,
	ACCENT_VALUES,
	CODE_DARK_KEY,
	CODE_DARK_VALUES,
	CODE_LIGHT_KEY,
	CODE_LIGHT_VALUES,
	DENSITY_KEY,
	DENSITY_VALUES,
	DOC_LAYOUT_KEY,
	DOC_LAYOUT_VALUES,
	THEME_KEY,
	THEME_VALUES,
	TEXT_SIZE_KEY,
	TEXT_SIZE_VALUES,
	VOICE_KEY,
	VOICE_VALUES,
	readAllowedPreference,
} from '$lib/preferences';

await setupLogging();

type HtmlDataAttributes = Record<`data-${string}`, string>;

export const handle: Handle = async ({ event, resolve }) => {
	if (event.url.pathname === '/api/events/ws') {
		if (event.request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
			return new Response('Expected WebSocket upgrade', { status: 426 });
		}
		return handleWsUpgrade(event);
	}

	event.locals.auth = await getAuthState(event);
	event.locals.user = event.locals.auth.user;
	event.locals.session = event.locals.auth.session;

	if (event.url.pathname === '/api/auth' || event.url.pathname.startsWith('/api/auth/')) {
		return withSecurityHeaders(
			withDynamicCachePolicy(event.url.pathname, await handleAuthRequest(event)),
		);
	}

	const htmlAttributes = getHtmlDataAttributes(event.cookies);
	let appliedHtmlAttributes = false;

	const response = await resolve(event, {
		transformPageChunk: ({ html }) => {
			if (appliedHtmlAttributes) return html;

			const nextHtml = setHtmlDataAttributes(html, htmlAttributes);
			appliedHtmlAttributes = nextHtml !== html;
			return nextHtml;
		},
	});
	return withSecurityHeaders(withDynamicCachePolicy(event.url.pathname, response));
};

function withDynamicCachePolicy(pathname: string, response: Response): Response {
	if (pathname.startsWith('/_app/immutable/') && !response.ok) {
		return withCacheControl(response, 'no-store');
	}
	if (response.headers.has('Cache-Control')) return response;
	if (pathname.startsWith('/_app/immutable/') || pathname.startsWith('/favicon')) return response;
	return withCacheControl(response, 'no-store');
}

function withCacheControl(response: Response, value: string): Response {
	const headers = new Headers(response.headers);
	headers.set('Cache-Control', value);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function withSecurityHeaders(response: Response): Response {
	const headers = new Headers(response.headers);
	headers.set('X-Content-Type-Options', 'nosniff');
	headers.set('X-Frame-Options', 'DENY');
	headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
	headers.set(
		'Content-Security-Policy',
		"frame-ancestors 'none'; base-uri 'self'; object-src 'none'; worker-src 'self'",
	);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function getHtmlDataAttributes(cookies: Cookies): HtmlDataAttributes {
	const theme = readAllowedPreference(cookies.get(THEME_KEY), THEME_VALUES, 'system');
	const codeThemeLight = readAllowedPreference(
		cookies.get(CODE_LIGHT_KEY),
		CODE_LIGHT_VALUES,
		'solarized-light',
	);
	const codeThemeDark = readAllowedPreference(
		cookies.get(CODE_DARK_KEY),
		CODE_DARK_VALUES,
		'solarized-dark',
	);

	return {
		'data-theme': theme,
		'data-accent': readAllowedPreference(cookies.get(ACCENT_KEY), ACCENT_VALUES, 'orange'),
		'data-density': readAllowedPreference(cookies.get(DENSITY_KEY), DENSITY_VALUES, 'comfortable'),
		'data-text-size': readAllowedPreference(
			cookies.get(TEXT_SIZE_KEY),
			TEXT_SIZE_VALUES,
			'standard',
		),
		'data-voice': readAllowedPreference(cookies.get(VOICE_KEY), VOICE_VALUES, 'editorial'),
		'data-doc-layout': readAllowedPreference(
			cookies.get(DOC_LAYOUT_KEY),
			DOC_LAYOUT_VALUES,
			'classic',
		),
		'data-code-theme': theme === 'dark' ? codeThemeDark : codeThemeLight,
		'data-code-theme-light': codeThemeLight,
		'data-code-theme-dark': codeThemeDark,
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
