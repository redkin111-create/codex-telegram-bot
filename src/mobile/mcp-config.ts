import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AcpClient } from "../acp/client.js";
import { isPathWithinRoot } from "../projects/manager.js";
import { globalMcpPath, parseMcpServers, setMcpDisabled, workspaceMcpPath } from "../mcp/config.js";
import { detailOf, transportOf, type McpScope, type McpServer, type McpTransport } from "../mcp/types.js";
import type { RuntimeRegistry } from "../bot/registry.js";

const MAX_CONFIG_BYTES = 1024 * 1024;
const SAFE_SERVER_NAME = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_MCP_ARGS = 64;
const MAX_MCP_ENV = 32;

export interface MobileMcpConfigEntry {
  name: string;
  scope: McpScope;
  enabled: boolean;
  transport: McpTransport;
}

export interface MobileMcpConfigChange extends MobileMcpConfigEntry {
  restartRequired: boolean;
}

export type MobileMcpConfigDraft = {
  name: string;
  scope: McpScope;
} & (
  | { transport: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { transport: "http"; url: string; bearerTokenEnvVar?: string }
);

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

function checkedConfigPath(cwd: string, scope: McpScope, createDirectory: boolean): { path: string; projectRoot?: string } {
  if (scope === "global") return { path: globalMcpPath() };
  let projectRoot: string;
  try { projectRoot = realpathSync.native(cwd); }
  catch { throw new Error("Папка проекта для MCP недоступна"); }
  const directory = join(projectRoot, ".codex");
  if (existsSync(directory)) {
    let metadata;
    try { metadata = lstatSync(directory); }
    catch { throw new Error("Не удалось проверить папку настроек MCP проекта"); }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("Папка настроек MCP проекта должна находиться внутри проекта");
    let actualDirectory: string;
    try { actualDirectory = realpathSync.native(directory); }
    catch { throw new Error("Не удалось проверить папку настроек MCP проекта"); }
    if (!isPathWithinRoot(projectRoot, actualDirectory)) throw new Error("Папка настроек MCP выходит за пределы проекта");
  } else if (createDirectory) {
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("Не удалось создать папку настроек MCP проекта");
    }
    return checkedConfigPath(projectRoot, scope, false);
  }
  return { path: workspaceMcpPath(projectRoot), projectRoot };
}

function checkedConfigText(path: string, scope: McpScope, projectRoot?: string): { text: string; existed: boolean } {
  if (!existsSync(path)) return { text: "", existed: false };
  let metadata;
  try { metadata = lstatSync(path); }
  catch { throw new Error("Не удалось проверить файл конфигурации MCP"); }
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("Файл конфигурации MCP должен быть обычным файлом");
  let actualPath: string;
  try { actualPath = realpathSync.native(path); }
  catch { throw new Error("Не удалось проверить файл конфигурации MCP"); }
  if (scope === "workspace" && (!projectRoot || !isPathWithinRoot(projectRoot, actualPath))) throw new Error("Файл конфигурации MCP выходит за пределы проекта");
  let actualMetadata;
  try { actualMetadata = statSync(actualPath); }
  catch { throw new Error("Не удалось проверить файл конфигурации MCP"); }
  if (scope === "workspace" && actualMetadata.nlink > 1) throw new Error("Файл конфигурации MCP связан с путём за пределами проекта");
  if (actualMetadata.size > MAX_CONFIG_BYTES) throw new Error("Файл конфигурации MCP слишком велик для мобильного изменения");
  try { return { text: readFileSync(actualPath, "utf8"), existed: true }; }
  catch { throw new Error("Не удалось прочитать файл конфигурации MCP"); }
}

function validateMcpDraft(input: unknown): MobileMcpConfigDraft {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Не заданы параметры MCP-сервера");
  const draft = input as Record<string, unknown>;
  if (typeof draft.name !== "string" || !SAFE_SERVER_NAME.test(draft.name)) throw new Error("Неверное имя MCP-сервера");
  if (draft.scope !== "global" && draft.scope !== "workspace") throw new Error("Выберите область MCP-сервера");
  if (draft.transport === "stdio") {
    if (typeof draft.command !== "string" || !draft.command.trim() || draft.command.length > 512 || /[\u0000-\u001f\u007f]/.test(draft.command)) {
      throw new Error("Команда MCP должна быть непустой строкой до 512 символов без управляющих символов");
    }
    const args = draft.args === undefined ? [] : draft.args;
    if (!Array.isArray(args) || args.length > MAX_MCP_ARGS || args.some((arg) => typeof arg !== "string" || arg.length > 4096 || /[\u0000-\u001f\u007f]/.test(arg))) {
      throw new Error(`Аргументы MCP должны быть строками (не более ${MAX_MCP_ARGS}, каждый до 4096 символов)`);
    }
    const env = draft.env === undefined ? {} : draft.env;
    if (!env || typeof env !== "object" || Array.isArray(env) || Object.keys(env).length > MAX_MCP_ENV) throw new Error(`Переменные MCP должны быть объектом (не более ${MAX_MCP_ENV})`);
    for (const [name, value] of Object.entries(env)) {
      if (!SAFE_ENV_NAME.test(name) || typeof value !== "string" || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new Error("Проверьте имена и значения переменных MCP");
      }
    }
    return { name: draft.name, scope: draft.scope, transport: "stdio", command: draft.command.trim(), args: [...args] as string[], env: { ...env as Record<string, string> } };
  }
  if (draft.transport === "http") {
    if (typeof draft.url !== "string" || draft.url.length > 2048 || /[\u0000-\u001f\u007f]/.test(draft.url)) throw new Error("Неверный адрес MCP");
    let url: URL;
    try { url = new URL(draft.url); }
    catch { throw new Error("Неверный адрес MCP"); }
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.hash) {
      throw new Error("Адрес MCP должен использовать HTTPS (HTTP допускается только для localhost) и не содержать логин, пароль или фрагмент");
    }
    if (draft.bearerTokenEnvVar !== undefined && (typeof draft.bearerTokenEnvVar !== "string" || !SAFE_ENV_NAME.test(draft.bearerTokenEnvVar))) {
      throw new Error("Неверное имя переменной для токена MCP");
    }
    return {
      name: draft.name, scope: draft.scope, transport: "http", url: url.toString(),
      ...(draft.bearerTokenEnvVar ? { bearerTokenEnvVar: draft.bearerTokenEnvVar } : {}),
    };
  }
  throw new Error("Выберите поддерживаемый тип MCP-сервера");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function mcpDraftToml(draft: MobileMcpConfigDraft): string {
  const rows = [`[mcp_servers.${draft.name}]`];
  if (draft.transport === "stdio") {
    rows.push(`command = ${tomlString(draft.command)}`);
    if (draft.args?.length) rows.push(`args = [${draft.args.map(tomlString).join(", ")}]`);
    const entries = Object.entries(draft.env ?? {});
    if (entries.length) rows.push(`env = { ${entries.map(([name, value]) => `${name} = ${tomlString(value)}`).join(", ")} }`);
  } else {
    rows.push(`url = ${tomlString(draft.url)}`);
    if (draft.bearerTokenEnvVar) rows.push(`bearer_token_env_var = ${tomlString(draft.bearerTokenEnvVar)}`);
  }
  return rows.join("\n") + "\n";
}

function writeMobileConfig(path: string, original: string, originalExisted: boolean, next: string, scope: McpScope, projectRoot?: string): void {
  if (Buffer.byteLength(next, "utf8") > MAX_CONFIG_BYTES) throw new Error("Файл конфигурации MCP превысит допустимый размер");
  const latest = checkedConfigText(path, scope, projectRoot);
  if (latest.existed !== originalExisted || latest.text !== original) throw new Error("Конфигурация MCP изменилась. Обновите список и повторите действие");
  const temporary = `${path}.mobile-${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, next, { encoding: "utf8", flag: "wx", mode: 0o600 });
    // Recheck the project directory just before replacing the target.
    if (scope === "workspace" && projectRoot) checkedConfigPath(projectRoot, scope, false);
    const latestAgain = checkedConfigText(path, scope, projectRoot);
    if (latestAgain.existed !== latest.existed || latestAgain.text !== latest.text) throw new Error("Конфигурация MCP изменилась. Обновите список и повторите действие");
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* already moved or removed */ }
    if (error instanceof Error && error.message.startsWith("Конфигурация MCP изменилась")) throw error;
    throw new Error("Не удалось безопасно сохранить конфигурацию MCP");
  }
}

/** Add a local stdio or remote HTTP server to Codex config without returning commands, URLs or secrets to the browser. */
export function addMobileMcpConfigServer(cwd: string, input: unknown): MobileMcpConfigChange {
  if (typeof cwd !== "string" || !cwd.trim() || cwd.length > 1200) throw new Error("Неверная папка проекта для MCP");
  const draft = validateMcpDraft(input);
  if (configuredServers(cwd).some((server) => server.name === draft.name)) throw new Error("MCP-сервер с таким именем уже существует");
  const target = checkedConfigPath(cwd, draft.scope, true);
  if (draft.scope === "global") {
    try { mkdirSync(dirname(target.path), { recursive: true, mode: 0o700 }); }
    catch { throw new Error("Не удалось подготовить глобальную папку настроек MCP"); }
  }
  const current = checkedConfigText(target.path, draft.scope, target.projectRoot);
  if (parseMcpServers(current.text)[draft.name]) throw new Error("MCP-сервер с таким именем уже существует");
  const next = `${current.text}${current.text ? (current.text.endsWith("\n") ? "\n" : "\n\n") : ""}${mcpDraftToml(draft)}`;
  writeMobileConfig(target.path, current.text, current.existed, next, draft.scope, target.projectRoot);
  return { name: draft.name, scope: draft.scope, enabled: true, transport: draft.transport, restartRequired: true };
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
