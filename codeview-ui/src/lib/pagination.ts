export function readPageParam(url: URL, name: string, pageCount: number): number {
	const raw = Number.parseInt(url.searchParams.get(name) ?? '1', 10);
	if (!Number.isFinite(raw)) return 1;
	return Math.min(Math.max(raw, 1), Math.max(pageCount, 1));
}

export function paginationHref(url: URL, name: string, page: number): string {
	const next = new URL(url);
	if (page <= 1) next.searchParams.delete(name);
	else next.searchParams.set(name, String(page));
	return `${next.pathname}${next.search}${next.hash}`;
}
