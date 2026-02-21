const CRATE_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const VERSION_RE = /^\d{1,10}\.\d{1,10}\.\d{1,10}(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;

export function isValidCrateNameParam(value: string | null | undefined): value is string {
	return typeof value === 'string' && CRATE_NAME_RE.test(value);
}

export function isValidVersionParam(value: string | null | undefined): value is string {
	if (typeof value !== 'string') return false;
	if (value === 'latest' || value === 'stable' || value === 'beta' || value === 'nightly')
		return true;
	return VERSION_RE.test(value);
}
