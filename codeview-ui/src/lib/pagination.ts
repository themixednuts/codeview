type SearchParamsReader = {
  href: string;
  searchParams: { get(name: string): string | null };
};

export function readPageParam(url: SearchParamsReader, name: string, pageCount: number): number {
  const raw = Number.parseInt(url.searchParams.get(name) ?? "1", 10);
  if (!Number.isFinite(raw)) return 1;
  return Math.min(Math.max(raw, 1), Math.max(pageCount, 1));
}

export function paginationHref(url: SearchParamsReader, name: string, page: number): string {
  const next = new URL(url.href);
  if (page <= 1) next.searchParams.delete(name);
  else next.searchParams.set(name, String(page));
  return `${next.pathname}${next.search}${next.hash}`;
}
