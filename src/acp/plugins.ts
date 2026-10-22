type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Resolve only a remote plugin already listed by Codex for this workspace. */
export function resolveRemotePluginInstall(
  pluginCatalog: unknown,
  pluginId: string,
  marketplaceName: string,
): { pluginName: string; remoteMarketplaceName: string } {
  const catalog = record(pluginCatalog);
  const marketplace = list(catalog?.marketplaces).map(record).find((entry) => entry?.name === marketplaceName);
  const plugin = list(marketplace?.plugins).map(record).find((entry) => entry?.id === pluginId);
  if (!plugin || typeof plugin.name !== "string") throw new Error("Плагин не найден в актуальном каталоге Codex");
  if (record(plugin.source)?.type !== "remote") throw new Error("С телефона доступны только плагины из удалённого каталога Codex");
  if (plugin.installed === true) throw new Error("Плагин уже установлен");
  if (plugin.installPolicy !== "AVAILABLE" || plugin.availability === "DISABLED_BY_ADMIN") {
    throw new Error("Этот плагин сейчас недоступен для установки");
  }
  return { pluginName: plugin.name, remoteMarketplaceName: marketplaceName };
}

export function installedPluginExists(installedPlugins: unknown, pluginId: string): boolean {
  for (const marketplace of list(record(installedPlugins)?.marketplaces)) {
    for (const plugin of list(record(marketplace)?.plugins)) {
      const entry = record(plugin);
      if (entry?.id === pluginId && entry.installed === true) return true;
    }
  }
  return false;
}
