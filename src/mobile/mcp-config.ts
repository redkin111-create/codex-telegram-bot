import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import type { AcpClient } from "../acp/client.js";
import { isPathWithinRoot } from "../projects/manager.js";
import { globalMcpPath, parseMcpServers, setMcpDisabled, workspaceMcpPath } from "../mcp/config.js";
import { detailOf, transportOf, type McpScope, type McpServer, type McpTransport } from "../mcp/types.js";
import type { RuntimeRegistry } from "../bot/registry.js";

const MAX_CONFIG_BYTES = 1024 * 1024;
const SAFE_SERVER_NAME = /^[A-Za-z0-9_-]{1,128}$/;

export interface MobileMcpConfigEntry {
  name: string;
  scope: McpScope;
  enabled: boolean;
  transport: McpTransport;
}

export interface MobileMcpConfigChange extends MobileMcpConfigEntry {
  restartRequired: boolean;
}

function configServers(path: string, scope: McpScope, projectRoot?: string): McpServer[] {
  if (!existsSync(path)) return [];
  let metadata;
  let actualPath: string;
  try { metadata = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("Не удалось проверить файл конфигурации MCP");
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("Файл конфигурации MCP должен быть обычным файлом");
  try { actualPath = realpathSync.native(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("Не удалось проверить файл конфигурации MCP");
  }
  if (scope === "workspace" && (!projectRoot || !isPathWithinRoot(projectRoot, actualPath))) {
    throw new Error("Файл конфигурации MCP выходит за пределы проекта");
  }
  let actualMetadata;
  try { actualMetadata = statSync(actualPath); }
  catch { throw new Error("Не удалось прочитать файл конфигурации MCP"); }
  if (scope === "workspace" && actualMetadata.nlink > 1) throw new Error("Файл конфигурации MCP связан с путём за пределами проекта");
  if (actualMetadata.size > MAX_CONFIG_BYTES) throw new Error("Файл конфигурации MCP слишком велик для мобильного просмотра");
  let text: string;
  try { text = readFileSync(actualPath, "utf8"); }
  catch { throw new Error("Не удалось прочитать файл конфигурации MCP"); }
  const parsed = parseMcpServers(text);
  return Object.entries(parsed).filter(([name]) => SAFE_SERVER_NAME.test(name)).map(([name, config]) => ({
    name,
    scope,
    configPath: actualPath,
    disabled: config.disabled === true || config.enabled === false,
    transport: transportOf(config),
    detail: detailOf(config),
    config,
  }));
}

function configuredServers(cwd: string): McpServer[] {
  let projectRoot: string;
  try { projectRoot = realpathSync.native(cwd); }
  catch { throw new Error("Папка проекта для MCP недоступна"); }
  const workspace = configServers(workspaceMcpPath(projectRoot), "workspace", projectRoot);
  const byName = new Map<string, McpServer>();
  for (const server of configServers(globalMcpPath(), "global")) byName.set(server.name, server);
  for (const server of workspace) byName.set(server.name, server);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

function publicEntry(server: McpServer): MobileMcpConfigEntry {
  return {
    name: server.name.slice(0, 128),
    scope: server.scope,
    enabled: !server.disabled,
    transport: server.transport,
  };
}

/** Read configured MCP servers without returning commands, URLs, paths, args or environment values. */
export function listMobileMcpConfig(cwd: string): MobileMcpConfigEntry[] {
  if (typeof cwd !== "string" || !cwd.trim() || cwd.length > 1200) throw new Error("Неверная папка проекта для MCP");
  return configuredServers(cwd).map(publicEntry);
}

/** Toggle one effective Codex MCP entry through the existing TOML-preserving writer. */
export function setMobileMcpConfigEnabled(cwd: string, name: string, enabled: boolean): MobileMcpConfigChange {
  if (typeof cwd !== "string" || !cwd.trim() || cwd.length > 1200) throw new Error("Неверная папка проекта для MCP");
  if (typeof name !== "string" || !SAFE_SERVER_NAME.test(name)) throw new Error("Неверное имя MCP-сервера");
  if (typeof enabled !== "boolean") throw new Error("Состояние MCP-сервера должно быть включено или выключено");
  const server = configuredServers(cwd).find((item) => item.name === name);
  if (!server) throw new Error("MCP-сервер не найден в разрешённой конфигурации");

  // Recheck the file boundary immediately before calling the existing writer.
  const candidates = configServers(server.configPath, server.scope, server.scope === "workspace" ? realpathSync.native(cwd) : undefined);
  const current = candidates.find((item) => item.name === name);
  if (!current) throw new Error("MCP-сервер изменился. Обновите список и повторите действие");
  const restartRequired = (!current.disabled) !== enabled;
  const result = setMcpDisabled(current, !enabled);
  if (!result.ok) throw new Error("Не удалось изменить конфигурацию MCP");
  const updated = publicEntry({ ...current, disabled: !enabled });
  return { ...updated, restartRequired };
}

/** Restart the shared Codex app-server only when no session has work in flight. */
export async function restartMobileCodex(
  acp: Pick<AcpClient, "isConnected" | "hasInflightPrompt" | "restart">,
  registry: Pick<RuntimeRegistry, "hasPendingWork">,
): Promise<{ restarted: true }> {
  if (!acp.isConnected) throw new Error("Codex сейчас офлайн");
  if (acp.hasInflightPrompt()) throw new Error("Codex занят. Дождитесь завершения текущей задачи перед перезапуском");
  if (registry.hasPendingWork()) throw new Error("В Codex есть ожидающие запросы. Выполните их или удалите перед перезапуском");
  await acp.restart();
  return { restarted: true };
}
