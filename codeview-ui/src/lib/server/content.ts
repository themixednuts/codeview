export function getContentId(headers: Headers, fallback: string): string {
	const raw = headers.get('etag') ?? headers.get('last-modified');
	if (!raw) return fallback;
	const normalized = raw.replace(/^W\//, '').trim();
	if (normalized.startsWith('"') && normalized.endsWith('"')) {
		return normalized.slice(1, -1);
	}
	return normalized;
}
