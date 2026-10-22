import { normalizeMobileMcpInputSchema, type MobileMcpInputSchema } from "../acp/mobile-mcp.js";

type JsonRecord = Record<string, unknown>;

const MOBILE_PLUGIN_INVENTORY_LIMIT = 1000;

export interface MobilePluginSummary {
  id: string;
  name: string;
  marketplace: string;
  description?: string;
  capabilities: string[];
  sourceType?: "remote" | "local" | "git" | "npm";
  installed: boolean;
  enabled: boolean;
  canToggle: boolean;
  installable: boolean;
  installPolicy: "AVAILABLE" | "INSTALLED_BY_DEFAULT" | "NOT_AVAILABLE" | "unknown";
  availability: string;
  mustShowInstallationInterstitial: boolean;
}

export interface MobileAppSummary {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  accessible: boolean;
  callable: boolean;
  installUrl?: string;
}

export interface MobileMcpToolSummary {
  name: string;
  description?: string;
  inputSchema?: MobileMcpInputSchema;
}

export interface MobileMcpResourceSummary {
  id: string;
  name: string;
  description?: string;
  mimeType?: string;
  parameters?: string[];
}

export interface MobileMcpServerSummary {
  name: string;
  status: "notStarted" | "starting" | "connected" | "authenticationRequired" | "failed" | "cancelled" | "disabled" | "unknown";
  authStatus: "unknown" | "unsupported" | "notLoggedIn" | "bearerToken" | "oauth";
  serverName?: string;
  serverVersion?: string;
  tools: MobileMcpToolSummary[];
  resources?: MobileMcpResourceSummary[];
  toolCount: number;
  resourceCount: number;
  resourceTemplateCount: number;
  discoveryFailed: boolean;
}

export interface MobileIntegrationInventory {
  pluginCatalogAvailable: boolean;
  appsAvailable: boolean;
  plugins: MobilePluginSummary[];
  apps: MobileAppSummary[];
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function safeText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
  return text || undefined;
}

function safeHttpsUrl(value: unknown): string | undefined {
  const raw = safeText(value, 2048);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return url.href;
  } catch { return undefined; }
}

function installedPluginIds(value: unknown): Set<string> {
  const ids = new Set<string>();
  for (const marketplace of list(record(value)?.marketplaces)) {
    for (const plugin of list(record(marketplace)?.plugins)) {
      const id = safeText(record(plugin)?.id, 200);
      if (id && record(plugin)?.installed === true) ids.add(id);
    }
  }
  return ids;
}

function flattenPlugins(value: unknown, installedIds: Set<string>): MobilePluginSummary[] {
  const result: MobilePluginSummary[] = [];
  for (const rawMarketplace of list(record(value)?.marketplaces)) {
    const marketplace = record(rawMarketplace);
    const marketplaceName = safeText(marketplace?.name, 120);
    if (!marketplaceName) continue;
    for (const rawPlugin of list(marketplace?.plugins)) {
      if (result.length >= MOBILE_PLUGIN_INVENTORY_LIMIT) return result;
      const plugin = record(rawPlugin);
      const id = safeText(plugin?.id, 200);
      const name = safeText(plugin?.name, 160);
      if (!id || !name) continue;
      const sourceType = safeText(record(plugin?.source)?.type, 16);
      const policy = plugin?.installPolicy;
      const installPolicy = policy === "AVAILABLE" || policy === "INSTALLED_BY_DEFAULT" || policy === "NOT_AVAILABLE"
        ? policy
        : "unknown";
      const installed = plugin?.installed === true || installedIds.has(id);
      const availability = safeText(plugin?.availability, 40) ?? "unknown";
      const pluginInterface = record(plugin?.interface);
      result.push({
        id,
        name,
        marketplace: marketplaceName,
        description: safeText(pluginInterface?.shortDescription ?? pluginInterface?.longDescription, 500),
        capabilities: list(pluginInterface?.capabilities).flatMap((entry) => {
          const capability = safeText(entry, 80);
          return capability ? [capability] : [];
        }).slice(0, 12),
        sourceType: sourceType === "remote" || sourceType === "local" || sourceType === "git" || sourceType === "npm"
          ? sourceType
          : undefined,
        installed,
        enabled: plugin?.enabled === true,
        canToggle: installed && availability !== "DISABLED_BY_ADMIN",
        installable: !installed && sourceType === "remote" && installPolicy === "AVAILABLE" && availability !== "DISABLED_BY_ADMIN",
        installPolicy,
        availability,
        mustShowInstallationInterstitial: plugin?.mustShowInstallationInterstitial === true,
      });
    }
  }
  return result;
}

function safeApp(value: unknown, installed: Map<string, JsonRecord>): MobileAppSummary | undefined {
  const app = record(value);
  const id = safeText(app?.id, 200);
  if (!id) return undefined;
  const installedState = installed.get(id);
  return {
    id,
    name: safeText(app?.name, 160) ?? safeText(installedState?.runtimeName, 160) ?? id,
    description: safeText(app?.description, 500),
    enabled: typeof installedState?.enabled === "boolean" ? installedState.enabled : app?.isEnabled !== false,
    accessible: app?.isAccessible === true,
    callable: installedState?.callable === true,
    installUrl: safeHttpsUrl(app?.installUrl),
  };
}

/** Remove local paths, remote media and untrusted metadata we do not need on the phone. */
export function normalizeMobileIntegrations(
  pluginCatalog: unknown,
  installedPlugins: unknown,
  appCatalog: unknown,
  installedApps: unknown,
): MobileIntegrationInventory {
  const pluginCatalogRecord = record(pluginCatalog);
  const appCatalogRecord = record(appCatalog);
  const installedPluginCatalogRecord = record(installedPlugins);
  const installedAppCatalogRecord = record(installedApps);
  const installedIds = installedPluginIds(installedPlugins);
  const appsInstalled = new Map<string, JsonRecord>();
  for (const app of list(installedAppCatalogRecord?.apps)) {
    const entry = record(app);
    const id = safeText(entry?.id, 200);
    if (id) appsInstalled.set(id, entry!);
  }
  const appsById = new Map<string, MobileAppSummary>();
  for (const value of list(appCatalogRecord?.data)) {
    const app = safeApp(value, appsInstalled);
    if (app) appsById.set(app.id, app);
  }
  for (const [id, state] of appsInstalled) {
    if (!appsById.has(id)) {
      const app = safeApp({ id, name: state.runtimeName }, appsInstalled);
      if (app) appsById.set(id, app);
    }
  }
  const plugins = new Map<string, MobilePluginSummary>();
  for (const plugin of flattenPlugins(pluginCatalog, installedIds)) plugins.set(`${plugin.marketplace}:${plugin.id}`, plugin);
  for (const plugin of flattenPlugins(installedPlugins, installedIds)) {
    const key = `${plugin.marketplace}:${plugin.id}`;
    const existing = plugins.get(key);
    plugins.set(key, existing ? {
      ...existing,
      ...plugin,
      installed: true,
      enabled: typeof plugin.enabled === "boolean" ? plugin.enabled : existing.enabled,
      canToggle: plugin.availability !== "DISABLED_BY_ADMIN" && existing.canToggle,
      installable: false,
    } : { ...plugin, installed: true, installable: false });
  }
  return {
    pluginCatalogAvailable: Array.isArray(pluginCatalogRecord?.marketplaces) || Array.isArray(installedPluginCatalogRecord?.marketplaces),
    appsAvailable: Array.isArray(appCatalogRecord?.data) || appsInstalled.size > 0,
    plugins: [...plugins.values()].slice(0, MOBILE_PLUGIN_INVENTORY_LIMIT),
    apps: [...appsById.values()].slice(0, MOBILE_PLUGIN_INVENTORY_LIMIT),
  };
}

export function normalizePluginInstallResult(value: unknown): Array<{ id: string; name: string; installUrl?: string }> {
  return list(record(value)?.appsNeedingAuth).flatMap((raw) => {
    const app = record(raw);
    const id = safeText(app?.id, 200);
    const name = safeText(app?.name, 160);
    if (!id || !name) return [];
    const installUrl = safeHttpsUrl(app?.installUrl);
    return [{ id, name, ...(installUrl ? { installUrl } : {}) }];
  }).slice(0, 20);
}

/** Keep thread-scoped MCP status useful while omitting endpoints, schemas, errors and secrets. */
export function normalizeMobileMcpServers(value: unknown): MobileMcpServerSummary[] {
  return list(value).flatMap((raw): MobileMcpServerSummary[] => {
    const server = record(raw);
    const name = safeText(server?.name, 120);
    if (!name) return [];

    const rawTools = record(server?.tools) ?? {};
    const tools = Object.entries(rawTools).slice(0, 100).flatMap(([rawName, rawTool]) => {
      const toolName = safeText(rawName, 120);
      if (!toolName) return [];
      const tool = record(rawTool);
      const description = safeText(tool?.description, 500);
      const inputSchema = normalizeMobileMcpInputSchema(tool?.inputSchema);
      return [{ name: toolName, ...(description ? { description } : {}), ...(inputSchema ? { inputSchema } : {}) }];
    });
    const status = server?.runtimeStatus;
    const allowedStatuses = new Set(["notStarted", "starting", "connected", "authenticationRequired", "failed", "cancelled", "disabled"]);
    const rawAuthStatus = server?.authStatus;
    const authStatus = rawAuthStatus === "needs_auth" ? "notLoggedIn" : rawAuthStatus;
    const allowedAuthStatuses = new Set(["unknown", "unsupported", "notLoggedIn", "bearerToken", "oauth"]);
    const serverInfo = record(server?.serverInfo);

    return [{
      name,
      status: typeof status === "string" && allowedStatuses.has(status)
        ? status as MobileMcpServerSummary["status"]
        : "unknown",
      authStatus: typeof authStatus === "string" && allowedAuthStatuses.has(authStatus)
        ? authStatus as MobileMcpServerSummary["authStatus"]
        : "unknown",
      ...(safeText(serverInfo?.name, 120) ? { serverName: safeText(serverInfo?.name, 120)! } : {}),
      ...(safeText(serverInfo?.version, 80) ? { serverVersion: safeText(serverInfo?.version, 80)! } : {}),
      tools,
      toolCount: Object.keys(rawTools).length,
      resourceCount: list(server?.resources).length,
      resourceTemplateCount: list(server?.resourceTemplates).length,
      discoveryFailed: typeof server?.toolsError === "string" && server.toolsError.length > 0,
    }];
  }).slice(0, 100);
}
