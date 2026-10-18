type JsonRecord = Record<string, unknown>;

export interface MobileMarketplaceSummary {
  name: string;
  pluginCount: number;
  installedPluginCount: number;
  manageable: boolean;
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function safeName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return name && name.length <= 120 && !/[\\/:]/.test(name) ? name : undefined;
}

/** Return counts and a boolean only; Codex marketplace paths never reach the phone. */
export function normalizeMobileMarketplaces(catalog: unknown, installed: unknown): MobileMarketplaceSummary[] {
  const installedByName = new Map<string, Set<string>>();
  for (const rawMarketplace of list(record(installed)?.marketplaces)) {
    const marketplace = record(rawMarketplace);
    const name = safeName(marketplace?.name);
    if (!name) continue;
    const ids = new Set<string>();
    for (const rawPlugin of list(marketplace?.plugins)) {
      const plugin = record(rawPlugin);
      if (plugin?.installed !== true) continue;
      if (typeof plugin.id === "string" && plugin.id.length <= 200) ids.add(plugin.id);
    }
    installedByName.set(name, ids);
  }

  const result: MobileMarketplaceSummary[] = [];
  const seen = new Set<string>();
  for (const rawMarketplace of list(record(catalog)?.marketplaces)) {
    const marketplace = record(rawMarketplace);
    const name = safeName(marketplace?.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const plugins = list(marketplace?.plugins).flatMap((rawPlugin) => {
      const plugin = record(rawPlugin);
      return typeof plugin?.id === "string" && plugin.id.length <= 200 ? [plugin.id] : [];
    });
    const installedIds = installedByName.get(name) ?? new Set<string>();
    result.push({
      name,
      pluginCount: Math.min(plugins.length, 500),
      installedPluginCount: Math.min(plugins.filter((id) => installedIds.has(id)).length, 500),
      manageable: typeof marketplace?.path === "string" && marketplace.path.length > 0,
    });
    if (result.length >= 100) break;
  }
  return result;
}
