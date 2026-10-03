/** Inline inspection and safe, explicit control of Codex MCP configuration. */
import { type Bot, type Context, InlineKeyboard } from "grammy";
import type { BotDeps } from "../deps.js";
import { listMcpServers, setMcpDisabled } from "../../mcp/config.js";
import { probeAll } from "../../mcp/probe.js";
import type { McpProbeResult, McpServer } from "../../mcp/types.js";
import type { CodexMcpServerStatus } from "../../acp/codex-protocol.js";
import { compactLabel, INLINE_PAGE_SIZE, pageWindow } from "../menu/paging.js";

const PAGE_SIZE = INLINE_PAGE_SIZE;
const TOKEN = "([a-f0-9]{16})";

interface McpSnapshot {
  token: string;
  cwd: string;
  list: McpServer[];
}

const snapshots = new Map<number, McpSnapshot>();

function snapshot(chatId: number, deps: BotDeps): McpSnapshot {
  const cwd = deps.registry.get(chatId).cwd;
  const current = { token: deps.menuCache.createToken(), cwd, list: listMcpServers(cwd) };
  snapshots.set(chatId, current);
  return current;
}

export function snapshotMatches(current: Pick<McpSnapshot, "token" | "cwd"> | undefined, token: string, cwd: string): boolean {
  return current?.token === token && sameWorkspace(current.cwd, cwd);
}

function currentSnapshot(chatId: number, token: string, cwd: string): McpSnapshot | undefined {
  const current = snapshots.get(chatId);
  return snapshotMatches(current, token, cwd) ? current : undefined;
}

function sameWorkspace(a: string, b: string): boolean {
  return a.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase() === b.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
}

function trunc(s: string, n: number): string {
  return compactLabel(s, n);
}

const TRANSPORT_ICON: Record<string, string> = { http: "\u{1F310}", stdio: "\u{1F5A5}\uFE0F", unknown: "\u2753" };

export function mainPanel(
  list: McpServer[],
  live: CodexMcpServerStatus[],
  page: number,
  token: string,
): { text: string; kb: InlineKeyboard } {
  const enabled = list.filter((s) => !s.disabled);
  const disabled = list.length - enabled.length;
  const { page: p, pages, start, end } = pageWindow(list.length, page, PAGE_SIZE);
  const liveByName = new Map(live.map((status) => [status.name, status]));
  const lines = [
    `\u{1F9E9} Серверы MCP \u00B7 ${list.length}`,
    `\u2705 включено: ${enabled.length} \u00B7 \u26D4 выключено: ${disabled}`,
    "",
  ];
  for (const server of list.slice(start, end)) {
    const status = liveByName.get(server.name);
    const resourceCount = (status?.resources?.length ?? 0) + (status?.resourceTemplates?.length ?? 0);
    const loaded = status
      ? `подключён \u00B7 инструментов: ${Object.keys(status.tools ?? {}).length} \u00B7 ресурсов: ${resourceCount}${authSummary(status.authStatus)}`
      : server.disabled ? "выключен" : "нет данных от Codex";
    const scope = server.scope === "workspace" ? " \u00B7 проект" : "";
    lines.push(`${server.disabled ? "\u26D4" : status ? "\u{1F7E2}" : "\u{1F7E1}"} ${TRANSPORT_ICON[server.transport] ?? ""} ${trunc(server.name, 28)}${scope} \u00B7 ${loaded}`);
  }
  const configuredNames = new Set(list.map((server) => server.name));
  const liveOnly = live.filter((status) => !configuredNames.has(status.name));
  if (liveOnly.length > 0 && (p === 0 || list.length === 0)) {
    lines.push("", `Обнаружены Codex \u00B7 ${liveOnly.length}`);
    for (const status of liveOnly.slice(0, PAGE_SIZE)) {
      const resources = (status.resources?.length ?? 0) + (status.resourceTemplates?.length ?? 0);
      lines.push(`\u{1F7E2} ${trunc(status.name, 28)} \u00B7 инструментов: ${Object.keys(status.tools ?? {}).length} \u00B7 ресурсов: ${resources}${authSummary(status.authStatus)}`);
    }
    if (liveOnly.length > PAGE_SIZE) lines.push(`\u2026 и ещё ${liveOnly.length - PAGE_SIZE}`);
  }
  if (list.length === 0) {
    if (liveOnly.length === 0) lines.push("Серверы MCP не настроены и не обнаружены.");
  }
  const kb = new InlineKeyboard();
  if (pages > 1) {
    if (p > 0) kb.text("\u25C0", `mcp:page:${token}:${p - 1}`);
    kb.text(`${p + 1}/${pages}`, "noop");
    if (p < pages - 1) kb.text("\u25B6", `mcp:page:${token}:${p + 1}`);
    kb.row();
  }
  kb.text("\u{1F9EA} Проверить связь", `mcp:health:${token}`).text("\u{1F527} Управление", `mcp:tog:${token}:0`).row();
  kb.text("\u{1F501} Обновить", "mcp:refresh");
  if (list.length > 0) kb.text("\u{1F504} Перезапустить Codex", `mcp:restart:${token}`);
  kb.row().text("\u{1F3E0} Главное меню", "ui:home");
  return { text: lines.join("\n"), kb };
}

function togglePanel(list: McpServer[], token: string, page: number): { text: string; kb: InlineKeyboard } {
  const { page: p, pages, start, end } = pageWindow(list.length, page, PAGE_SIZE);
  const kb = new InlineKeyboard();
  list.slice(start, end).forEach((server, offset) => {
    const index = start + offset;
    const label = `${server.disabled ? "\u2705 Включить" : "\u26D4 Выключить"} ${trunc(server.name, 24)}`;
    kb.text(label, `mcp:set:${token}:${index}`).row();
  });
  if (pages > 1) {
    if (p > 0) kb.text("\u25C0", `mcp:tog:${token}:${p - 1}`);
    kb.text(`${p + 1}/${pages}`, "noop");
    if (p < pages - 1) kb.text("\u25B6", `mcp:tog:${token}:${p + 1}`);
    kb.row();
  }
  kb.text("\u2B05 К серверам MCP", "mcp:refresh").text("\u{1F3E0} Меню", "ui:home");
  const text = list.length
    ? `\u{1F527} Управление серверами MCP \u00B7 ${list.length}\nНажмите, чтобы включить или выключить сервер. Чтобы изменения вступили в силу, перезапустите Codex.`
    : "Нет настроенных серверов MCP для управления.";
  return { text, kb };
}

export async function showMcp(ctx: Context, deps: BotDeps): Promise<void> {
  await deps.acp.refreshInventories();
  const current = snapshot(ctx.chat!.id, deps);
  const { text, kb } = mainPanel(current.list, deps.acp.availableMcpServers, 0, current.token);
  await deps.ephemeral.open(ctx);
  await deps.ephemeral.reply(ctx, text, { reply_markup: kb });
}

export function formatProbeResult(result: McpProbeResult): string {
  if (result.ok) return `\u2705 ${trunc(result.name, 26)} \u00B7 ${result.ms ?? 0} мс`;
  const raw = result.error ?? "";
  let reason = "Не удалось подключиться";
  if (/^timeout/i.test(raw)) reason = "Истекло время ожидания";
  else if (/^HTTP\s+\d{3}/i.test(raw)) reason = `HTTP ${/^HTTP\s+(\d{3})/i.exec(raw)?.[1]}`;
  else if (/^(spawn failed|no command configured)/i.test(raw)) reason = "Команда недоступна";
  else if (/^process exited \(code -?\d+\)/i.test(raw)) reason = `Процесс завершился (${/^process exited \((code -?\d+)\)/i.exec(raw)?.[1]})`;
  else if (/^server error/i.test(raw)) reason = "Сервер отклонил запрос";
  return `\u274C ${trunc(result.name, 26)} \u00B7 ${reason}`;
}

function authSummary(status: unknown): string {
  if (typeof status !== "string") return "";
  const normalized = status.toLowerCase();
  if (/unauth|not[_ -]?auth|needs?[_ -]?auth|expired|pending/.test(normalized)) return " \u00B7 требуется вход";
  if (/auth|connected|ready|^ok$/.test(normalized)) return " \u00B7 вход выполнен";
  return "";
}

export function healthCheckKeyboard(token: string): InlineKeyboard {
  return new InlineKeyboard().text("\u{1F501} Проверить ещё раз", `mcp:recheck:${token}`).row()
    .text("\u2B05 К серверам MCP", "mcp:refresh").text("\u{1F3E0} Меню", "ui:home");
}

async function runHealthCheck(ctx: Context, deps: BotDeps, list: McpServer[], token: string): Promise<void> {
  const enabled = list.filter((server) => !server.disabled);
  if (enabled.length === 0) {
    await ctx.editMessageText("Нет включённых серверов MCP для проверки.", {
      reply_markup: new InlineKeyboard().text("\u2B05 К серверам MCP", "mcp:refresh").text("\u{1F3E0} Меню", "ui:home"),
    }).catch(() => {});
    return;
  }
  const header = `\u{1F9EA} Проверяю серверы MCP: ${enabled.length}…`;
  await ctx.editMessageText(header).catch(() => {});
  let lastEdit = 0;
  const results = await probeAll(
    enabled,
    { timeoutMs: deps.cfg.mcpProbeTimeoutMs, concurrency: deps.cfg.mcpProbeConcurrency },
    (_result, done, total) => {
      const now = Date.now();
      if (now - lastEdit < 1200 && done < total) return;
      lastEdit = now;
      void ctx.editMessageText(`${header}\n\nПроверено: ${done}/${total}`).catch(() => {});
    },
  );
  const ok = results.filter((result) => result.ok).length;
  const sorted = results.slice().sort((a, b) => Number(a.ok) - Number(b.ok) || a.name.localeCompare(b.name));
  const rows = sorted.slice(0, 36).map(formatProbeResult);
  if (sorted.length > rows.length) rows.push(`… и ещё серверов: ${sorted.length - rows.length}`);
  const text = `\u{1F9EA} Проверка серверов MCP \u00B7 подключено: ${ok} из ${results.length}\n\n${rows.join("\n")}`;
  await ctx.editMessageText(text, { reply_markup: healthCheckKeyboard(token) }).catch(() => {});
}

export function registerMcp(bot: Bot, deps: BotDeps): void {
  bot.command("mcp", (ctx) => showMcp(ctx, deps));
  bot.callbackQuery("mcp:noop", (ctx) => ctx.answerCallbackQuery());

  bot.callbackQuery("mcp:refresh", async (ctx) => {
    await ctx.answerCallbackQuery();
    await deps.acp.refreshInventories();
    const current = snapshot(ctx.chat!.id, deps);
    const { text, kb } = mainPanel(current.list, deps.acp.availableMcpServers, 0, current.token);
    await ctx.editMessageText(text, { reply_markup: kb }).catch(() => {});
  });

  bot.callbackQuery(new RegExp(`^mcp:page:${TOKEN}:(\\d+)$`), async (ctx) => {
    const current = currentSnapshot(ctx.chat!.id, ctx.match![1]!, deps.registry.get(ctx.chat!.id).cwd);
    if (!current) return void ctx.answerCallbackQuery({ text: "Срок действия списка MCP истёк. Откройте его снова." });
    await ctx.answerCallbackQuery();
    const { text, kb } = mainPanel(current.list, deps.acp.availableMcpServers, Number(ctx.match![2]), current.token);
    await ctx.editMessageText(text, { reply_markup: kb }).catch(() => {});
  });

  bot.callbackQuery(new RegExp(`^mcp:tog:${TOKEN}:(\\d+)$`), async (ctx) => {
    const current = currentSnapshot(ctx.chat!.id, ctx.match![1]!, deps.registry.get(ctx.chat!.id).cwd);
    if (!current) return void ctx.answerCallbackQuery({ text: "Срок действия списка MCP истёк. Откройте его снова." });
    await ctx.answerCallbackQuery();
    const { text, kb } = togglePanel(current.list, current.token, Number(ctx.match![2]));
    await ctx.editMessageText(text, { reply_markup: kb }).catch(() => {});
  });

  bot.callbackQuery(new RegExp(`^mcp:set:${TOKEN}:(\\d+)$`), async (ctx) => {
    const current = currentSnapshot(ctx.chat!.id, ctx.match![1]!, deps.registry.get(ctx.chat!.id).cwd);
    const server = current?.list[Number(ctx.match![2])];
    if (!server) return void ctx.answerCallbackQuery({ text: "Срок действия списка MCP истёк. Откройте его снова." });
    const result = setMcpDisabled(server, !server.disabled);
    if (!result.ok) return void ctx.answerCallbackQuery({ text: "Не удалось изменить настройки MCP. Проверьте файл настроек Codex.", show_alert: true });
    await ctx.answerCallbackQuery({ text: result.disabled ? `Выключен: ${trunc(server.name, 48)}` : `Включён: ${trunc(server.name, 48)}` });
    const updated = snapshot(ctx.chat!.id, deps);
    const page = Math.floor(Number(ctx.match![2]) / PAGE_SIZE);
    const { text, kb } = togglePanel(updated.list, updated.token, page);
    await ctx.editMessageText(text, { reply_markup: kb }).catch(() => {});
  });

  bot.callbackQuery(new RegExp(`^mcp:health:${TOKEN}$`), async (ctx) => {
    const current = currentSnapshot(ctx.chat!.id, ctx.match![1]!, deps.registry.get(ctx.chat!.id).cwd);
    if (!current) return void ctx.answerCallbackQuery({ text: "Срок действия списка MCP истёк. Откройте его снова." });
    await ctx.answerCallbackQuery({ text: "Проверяю серверы MCP…" });
    await runHealthCheck(ctx, deps, current.list, current.token);
  });

  bot.callbackQuery(new RegExp(`^mcp:recheck:${TOKEN}$`), async (ctx) => {
    const cwd = deps.registry.get(ctx.chat!.id).cwd;
    if (!currentSnapshot(ctx.chat!.id, ctx.match![1]!, cwd)) {
      return void ctx.answerCallbackQuery({ text: "Срок действия списка MCP истёк. Откройте его снова." });
    }
    const current = snapshot(ctx.chat!.id, deps);
    if (!sameWorkspace(current.cwd, cwd)) {
      return void ctx.answerCallbackQuery({ text: "Рабочая папка изменилась. Откройте MCP снова." });
    }
    await ctx.answerCallbackQuery({ text: "Проверяю текущие настройки MCP…" });
    await runHealthCheck(ctx, deps, current.list, current.token);
  });

  bot.callbackQuery(new RegExp(`^mcp:restart:${TOKEN}$`), async (ctx) => {
    const current = currentSnapshot(ctx.chat!.id, ctx.match![1]!, deps.registry.get(ctx.chat!.id).cwd);
    if (!current) return void ctx.answerCallbackQuery({ text: "Срок действия списка MCP истёк. Откройте его снова." });
    if (deps.acp.hasInflightPrompt()) {
      await ctx.answerCallbackQuery({ text: "Дождитесь завершения текущей задачи Codex перед перезапуском.", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Перезапускаю Codex…" });
    await ctx.editMessageText("\u{1F504} Перезапускаю Codex, чтобы применить изменения MCP…").catch(() => {});
    try {
      await deps.acp.restart();
      await deps.acp.refreshInventories();
      const updated = snapshot(ctx.chat!.id, deps);
      const { text, kb } = mainPanel(updated.list, deps.acp.availableMcpServers, 0, updated.token);
      await ctx.editMessageText(`\u2705 Codex перезапущен.\n\n${text}`, { reply_markup: kb }).catch(() => {});
    } catch {
      await ctx.editMessageText("\u274C Не удалось перезапустить Codex. Подробности есть в локальном журнале.", {
        reply_markup: new InlineKeyboard().text("\u2B05 К серверам MCP", "mcp:refresh").text("\u{1F3E0} Меню", "ui:home"),
      }).catch(() => {});
    }
  });
}
