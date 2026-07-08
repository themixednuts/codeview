import type {
	AccentMode,
	CodeTheme,
	DensityMode,
	DocLayoutMode,
	ExternalLinkMode,
	SourceProviderMode,
	Theme,
	VcsMode,
	VoiceMode,
} from './context';

export const PREF_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export const THEME_KEY = 'codeview-theme';
export const ACCENT_KEY = 'codeview-accent';
export const DENSITY_KEY = 'codeview-density';
export const VOICE_KEY = 'codeview-voice';
export const DOC_LAYOUT_KEY = 'codeview-doc-layout';
export const CODE_LIGHT_KEY = 'codeview-code-light';
export const CODE_DARK_KEY = 'codeview-code-dark';
export const EXT_LINK_KEY = 'codeview-ext-link-mode';
export const SOURCE_PROVIDER_KEY = 'codeview-source-provider-mode';
export const VCS_KEY = 'codeview-vcs';
export const EDITOR_KEY = 'codeview-editor';
export const CUSTOM_EDITOR_KEY = 'codeview-editor-custom';
export const SOURCE_ROOT_KEY = 'codeview-source-root';

export const THEME_VALUES = ['light', 'dark', 'system'] as const satisfies readonly Theme[];
export const ACCENT_VALUES = ['orange', 'cobalt', 'forest', 'plum', 'char'] as const satisfies
	readonly AccentMode[];
export const DENSITY_VALUES = ['compact', 'comfortable', 'spacious'] as const satisfies
	readonly DensityMode[];
export const VOICE_VALUES = ['editorial', 'technical', 'geometric'] as const satisfies
	readonly VoiceMode[];
export const DOC_LAYOUT_VALUES = ['classic', 'reading', 'split'] as const satisfies
	readonly DocLayoutMode[];
export const CODE_VALUES = [
	'solarized-light',
	'solarized-dark',
	'catppuccin-latte',
	'catppuccin-mocha',
	'one-light',
	'one-dark',
	'github-light',
	'github-dark',
] as const satisfies readonly CodeTheme[];
export const EXT_LINK_VALUES = ['codeview', 'docs'] as const satisfies readonly ExternalLinkMode[];
export const SOURCE_PROVIDER_VALUES = ['auto', 'crates-io', 'github'] as const satisfies
	readonly SourceProviderMode[];
export const VCS_VALUES = ['git', 'jj'] as const satisfies readonly VcsMode[];
export const EDITOR_VALUES = ['vscode', 'cursor', 'zed', 'neovim', 'custom'] as const;

export type EditorId = (typeof EDITOR_VALUES)[number];

export function readAllowedPreference<T extends string>(
	value: string | null | undefined,
	allowed: readonly T[],
	fallback: T,
): T {
	return value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export function readClientPref(key: string, fallback: string): string {
	const cookieValue = readClientCookie(key);
	if (cookieValue !== null) return cookieValue;

	try {
		if (typeof localStorage === 'undefined') return fallback;
		return localStorage.getItem(key) ?? fallback;
	} catch {
		return fallback;
	}
}

export function readStoredPref<T extends string>(
	key: string,
	allowed: readonly T[],
	fallback: T,
): T {
	return readAllowedPreference(readClientPref(key, fallback), allowed, fallback);
}

export function writePref(key: string, value: string): void {
	try {
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem(key, value);
		}
	} catch {
		// A blocked localStorage write should not prevent the SSR cookie mirror.
	}

	if (typeof document !== 'undefined') {
		document.cookie = `${key}=${encodeURIComponent(
			value,
		)}; path=/; max-age=${PREF_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
	}
}

export function writeClientPref(key: string, value: string): void {
	try {
		if (typeof localStorage === 'undefined') return;
		const next = value.trim();
		if (next) localStorage.setItem(key, next);
		else localStorage.removeItem(key);
	} catch {
		// Local integration preferences are best-effort browser state.
	}
}

function readClientCookie(key: string): string | null {
	if (typeof document === 'undefined' || !document.cookie) return null;

	const prefix = `${key}=`;
	for (const rawPart of document.cookie.split(';')) {
		const part = rawPart.trim();
		if (!part.startsWith(prefix)) continue;

		const rawValue = part.slice(prefix.length);
		try {
			return decodeURIComponent(rawValue);
		} catch {
			return rawValue;
		}
	}

	return null;
}
