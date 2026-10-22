export interface SearchableCatalogEntry {
  id: string;
  name: string;
  marketplace?: string;
  description?: string;
}

export const mobileCatalogPageSize = 20;

export function filterCatalogEntries<T extends SearchableCatalogEntry>(entries: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...entries];
  return entries.filter((entry) =>
    [entry.name, entry.id, entry.marketplace, entry.description]
      .some((value) => value?.toLowerCase().includes(needle)),
  );
}

export function filterPluginCatalog<T extends SearchableCatalogEntry & { marketplace: string }>(plugins: readonly T[], query: string): T[] {
  return filterCatalogEntries(plugins, query);
}

export function paginateCatalogEntries<T>(items: readonly T[], requestedPage: number, pageSize = mobileCatalogPageSize) {
  const safePageSize = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : mobileCatalogPageSize;
  const pageCount = Math.max(1, Math.ceil(items.length / safePageSize));
  const page = Math.min(pageCount, Math.max(1, Number.isFinite(requestedPage) ? Math.trunc(requestedPage) : 1));
  const start = (page - 1) * safePageSize;
  return { items: items.slice(start, start + safePageSize), page, pageCount, total: items.length };
}
