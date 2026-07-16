export function safeReturnPath(value: FormDataEntryValue | string | null | undefined): string {
	if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
	try {
		const url = new URL(value, 'https://codeview.invalid');
		return `${url.pathname}${url.search}${url.hash}`;
	} catch {
		return '/';
	}
}
