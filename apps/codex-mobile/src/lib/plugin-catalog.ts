export interface SearchablePlugin {
  id: string;
  name: string;
  marketplace: string;
  description?: string;
}

export const mobilePluginPageSize = 20;

export function filterPluginCatalog<T extends SearchablePlugin>(plugins: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...plugins];
  return plugins.filter((plugin) =>
    [plugin.name, plugin.id, plugin.marketplace, plugin.description]
      .some((value) => value?.toLowerCase().includes(needle)),
  );
}

export function paginatePluginCatalog<T>(items: readonly T[], requestedPage: number, pageSize = mobilePluginPageSize) {
  const safePageSize = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : mobilePluginPageSize;
  const pageCount = Math.max(1, Math.ceil(items.length / safePageSize));
  const page = Math.min(pageCount, Math.max(1, Number.isFinite(requestedPage) ? Math.trunc(requestedPage) : 1));
  const start = (page - 1) * safePageSize;
  return { items: items.slice(start, start + safePageSize), page, pageCount, total: items.length };
}
