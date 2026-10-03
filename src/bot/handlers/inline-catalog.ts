import { type Bot, type Context, InlineKeyboard } from "grammy";
import { basename } from "node:path";
import { REASONING_LEVELS } from "../../app/types.js";
import { reasoningLabel } from "../../app/reasoning.js";
import { listMcpServers } from "../../mcp/config.js";
import type { BotDeps } from "../deps.js";
import { homeKeyboard } from "../menu/keyboard.js";
import { compactLabel, INLINE_PAGE_SIZE, pageWindow } from "../menu/paging.js";
import { openMainMenu } from "../menu/main.js";

const TOKEN = "([a-f0-9]{16})";

export function reasoningKeyboard(current: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  REASONING_LEVELS.forEach((level, i) => {
    const mark = level === current ? "\u2705 " : "\u25CB ";
    kb.text(`${mark}${reasoningLabel(level)}`, `reason:${level}`);
    if (i % 2 === 1) kb.row();
  });
  if (REASONING_LEVELS.length % 2) kb.row();
  return kb.text("\u{1F3E0} Главное меню", "ui:home");
}

export async function showReasoning(ctx: Context, deps: BotDeps): Promise<void> {
  await deps.ephemeral.open(ctx);
  const rt = deps.registry.get(ctx.chat!.id);
  const text = `\u{1F9E0} Уровень рассуждений\nСейчас: ${reasoningLabel(rt.reasoning)}\nВыберите уровень для следующих запросов.`;
  await deps.ephemeral.reply(ctx, text, { reply_markup: reasoningKeyboard(rt.reasoning) });
}

export async function showSettings(ctx: Context, deps: BotDeps): Promise<void> {
  await deps.ephemeral.open(ctx);
  const chatId = ctx.chat!.id;
  const rt = deps.registry.get(chatId);
  const session = rt.sessionId ? deps.store.get(rt.sessionId)?.title ?? rt.sessionId.slice(0, 8) : "Не запущен";
  const project = rt.projectName || (rt.cwd ? basename(rt.cwd) : "Не выбран");
  const lines = [
    "\u2699\uFE0F Настройки",
    `Модель: ${compactLabel(rt.model || deps.acp.currentModelId || "По умолчанию", 50)}`,
    `Уровень рассуждений: ${reasoningLabel(rt.reasoning)}`,
    `Проект: ${compactLabel(project, 50)}`,
    `Сеанс: ${compactLabel(session, 50)}`,
    `Доступ: ${deps.cfg.trustAllTools ? "полный доступ" : "к рабочим папкам"}`,
    `Подтверждение действий: ${deps.cfg.trustAllTools ? "выключено" : "по запросу"}`,
  ];
  if (deps.cfg.trustAllTools) {
    lines.push("\n\u26A0\uFE0F Включён полный доступ. Чтобы снова подтверждать действия отдельно, установите CODEX_TRUST_ALL_TOOLS=false.");
  }
  const kb = new InlineKeyboard()
    .text("\u{1F916} Модель", "m:model")
    .text("\u{1F9E0} Рассуждения", "m:reasoning")
    .row()
    .text("\u{1F9E9} MCP", "m:mcp")
    .row()
    .text("\u{1F3E0} Главное меню", "ui:home");
  await deps.ephemeral.reply(ctx, lines.join("\n"), { reply_markup: kb });
}

export async function showSkills(ctx: Context, deps: BotDeps): Promise<void> {
  await deps.acp.refreshInventories();
  const entries = deps.acp.availableSkills.filter((skill) => skill.enabled !== false);
  const token = deps.menuCache.setSkills(ctx.chat!.id, entries);
  await deps.ephemeral.open(ctx);
  await renderSkillsPage(ctx, deps, token, 0);
}

async function renderSkillsPage(ctx: Context, deps: BotDeps, token: string, requestedPage: number): Promise<void> {
  const chatId = ctx.chat!.id;
  const entries = deps.menuCache.getSkills(chatId, token);
  if (!entries) return void ctx.answerCallbackQuery({ text: "Срок действия списка навыков истёк. Откройте его снова." });
  const { text, kb } = skillsPage(entries, requestedPage, token);
  await deps.ephemeral.reply(ctx, text, { reply_markup: kb });
}

export function skillsPage(
  entries: Array<{ name: string; description?: string; enabled?: boolean; path?: string }>,
  requestedPage: number,
  token: string,
): { text: string; kb: InlineKeyboard } {
  const { page, pages, start, end } = pageWindow(entries.length, requestedPage);
  const kb = new InlineKeyboard();
  const lines = [`\u{1F6E0} Навыки \u00B7 ${entries.length}`, ""];
  for (let i = start; i < end; i++) {
    const skill = entries[i]!;
    lines.push(`\u2022 ${compactLabel(skill.name, 42)}`);
    kb.text(compactLabel(skill.name, 32), `sk:i:${token}:${i}:${page}`).row();
  }
  if (pages > 1) {
    if (page > 0) kb.text("\u25C0", `sk:p:${token}:${page - 1}`);
    kb.text(`${page + 1}/${pages}`, "noop");
    if (page < pages - 1) kb.text("\u25B6", `sk:p:${token}:${page + 1}`);
    kb.row();
  }
  if (entries.length === 0) lines.push("Codex не сообщил о включённых навыках.");
  kb.text("\u{1F501} Обновить", "skill:refresh").row().text("\u{1F3E0} Главное меню", "ui:home");
  return { text: lines.join("\n"), kb };
}

async function showSkillInfo(ctx: Context, deps: BotDeps, token: string, index: number, page: number): Promise<void> {
  const skill = deps.menuCache.getSkill(ctx.chat!.id, token, index);
  if (!skill) return void ctx.answerCallbackQuery({ text: "Срок действия этой кнопки истёк. Откройте список навыков снова." });
  await ctx.answerCallbackQuery();
  const description = skill.description?.trim();
  const body = description
    ? description.length > 1400 ? `${description.slice(0, 1399)}\u2026` : description
    : "У Codex нет описания этого навыка.";
  const kb = new InlineKeyboard()
    .text("\u2B05 К навыкам", `sk:p:${token}:${page}`)
    .text("\u{1F3E0} Главное меню", "ui:home");
  await deps.ephemeral.reply(ctx, `\u{1F6E0} ${compactLabel(skill.name, 64)}\n\n${body}`, { reply_markup: kb });
}

export async function showModels(ctx: Context, deps: BotDeps): Promise<void> {
  await deps.acp.refreshInventories();
  const token = deps.menuCache.setModels(ctx.chat!.id, deps.acp.availableModels);
  await deps.ephemeral.open(ctx);
  await renderModelsPage(ctx, deps, token, 0);
}

async function renderModelsPage(ctx: Context, deps: BotDeps, token: string, requestedPage: number): Promise<void> {
  const chatId = ctx.chat!.id;
  const entries = deps.menuCache.getModels(chatId, token);
  if (!entries) return void ctx.answerCallbackQuery({ text: "Срок действия списка моделей истёк. Откройте его снова." });
  const rt = deps.registry.get(chatId);
  const current = rt.model || deps.acp.currentModelId;
  const { text, kb } = modelPage(entries, requestedPage, token, current);
  await deps.ephemeral.reply(ctx, text, { reply_markup: kb });
}

export function modelPage(
  entries: Array<{ modelId: string; name: string; description?: string }>,
  requestedPage: number,
  token: string,
  current?: string,
): { text: string; kb: InlineKeyboard } {
  if (entries.length === 0) {
    const kb = new InlineKeyboard().text("\u{1F501} Обновить", "model:refresh").row().text("\u{1F3E0} Главное меню", "ui:home");
    return { text: "\u{1F916} Модели\nCodex не сообщил о доступных моделях.", kb };
  }
  const { page, pages, start, end } = pageWindow(entries.length, requestedPage);
  const kb = new InlineKeyboard();
  const lines = [`\u{1F916} Модели \u00B7 ${entries.length}`, ""];
  for (let i = start; i < end; i++) {
    const model = entries[i]!;
    const selected = model.modelId === current;
    lines.push(`${selected ? "\u2705" : "\u25CB"} ${compactLabel(model.name, 38)} \u00B7 ${compactLabel(model.modelId, 40)}`);
    kb.text(`${selected ? "\u2705 " : ""}${compactLabel(model.name, 32)}`, `model:set:${token}:${i}`).row();
  }
  if (pages > 1) {
    if (page > 0) kb.text("\u25C0", `model:page:${token}:${page - 1}`);
    kb.text(`${page + 1}/${pages}`, "noop");
    if (page < pages - 1) kb.text("\u25B6", `model:page:${token}:${page + 1}`);
    kb.row();
  }
  kb.text("Использовать модель Codex по умолчанию", `model:clear:${token}`).row();
  kb.text("\u{1F501} Обновить", "model:refresh").row().text("\u{1F3E0} Главное меню", "ui:home");
  return { text: lines.join("\n"), kb };
}

export async function showStatus(ctx: Context, deps: BotDeps, refresh = false): Promise<void> {
  const chatId = ctx.chat!.id;
  if (refresh) await deps.acp.refreshInventories();
  await deps.statusPanel.refresh(chatId);
  await deps.ephemeral.open(ctx);
  const rt = deps.registry.get(chatId);
  const session = rt.sessionId ? deps.store.get(rt.sessionId)?.title ?? rt.sessionId.slice(0, 8) : "Не запущен";
  const project = rt.projectName || (rt.cwd ? basename(rt.cwd) : "Не выбран");
  const configuredMcp = listMcpServers(rt.cwd);
  const enabledMcp = configuredMcp.filter((server) => !server.disabled).length;
  const skills = deps.acp.availableSkills.filter((skill) => skill.enabled !== false).length;
  const lines = [
    `${deps.acp.isConnected ? "\u{1F7E2} Codex подключён" : "\u{1F534} Codex не подключён"}`,
    `\u{1F4C1} ${compactLabel(project, 48)}`,
    `\u{1F4AC} ${compactLabel(session, 48)}`,
    `\u{1F916} Модель: ${compactLabel(rt.model || deps.acp.currentModelId || "По умолчанию", 48)}`,
    `\u{1F9E0} ${reasoningLabel(rt.reasoning)}`,
    `\u{1F512} Доступ: ${deps.cfg.trustAllTools ? "полный" : "к рабочим папкам"}`,
    `Серверы MCP: обнаружено ${deps.acp.availableMcpServers.length} \u00B7 включено в настройках ${enabledMcp}`,
    `Навыки: ${skills}`,
    `Очередь: ${rt.queueLength}`,
  ];
  const kb = new InlineKeyboard().text("\u{1F501} Обновить", "status:refresh");
  if (rt.isBusy) kb.text("\u{1F6D1} Остановить", "m:stop");
  kb.row().text("\u{1F3E0} Главное меню", "ui:home");
  await deps.ephemeral.reply(ctx, lines.join("\n"), { reply_markup: kb });
}

export function registerInlineCatalog(bot: Bot, deps: BotDeps): void {
  bot.callbackQuery(new RegExp(`^sk:p:${TOKEN}:(\\d+)$`), async (ctx) => {
    const token = ctx.match![1]!;
    if (!deps.menuCache.getSkills(ctx.chat!.id, token)) {
      await ctx.answerCallbackQuery({ text: "Срок действия списка навыков истёк. Откройте его снова." });
      return;
    }
    await ctx.answerCallbackQuery();
    await renderSkillsPage(ctx, deps, token, Number(ctx.match![2]));
  });
  bot.callbackQuery(new RegExp(`^sk:i:${TOKEN}:(\\d+):(\\d+)$`), (ctx) =>
    showSkillInfo(ctx, deps, ctx.match![1]!, Number(ctx.match![2]), Number(ctx.match![3])),
  );
  bot.callbackQuery("skill:refresh", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showSkills(ctx, deps);
  });

  bot.callbackQuery(new RegExp(`^model:page:${TOKEN}:(\\d+)$`), async (ctx) => {
    const token = ctx.match![1]!;
    if (!deps.menuCache.getModels(ctx.chat!.id, token)) {
      await ctx.answerCallbackQuery({ text: "Срок действия списка моделей истёк. Откройте его снова." });
      return;
    }
    await ctx.answerCallbackQuery();
    await renderModelsPage(ctx, deps, token, Number(ctx.match![2]));
  });
  bot.callbackQuery(new RegExp(`^model:set:${TOKEN}:(\\d+)$`), async (ctx) => {
    const model = deps.menuCache.getModel(ctx.chat!.id, ctx.match![1]!, Number(ctx.match![2]));
    if (!model) {
      await ctx.answerCallbackQuery({ text: "Срок действия списка моделей истёк. Откройте его снова.", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: `Выбираю модель ${compactLabel(model.name, 50)}…` });
    const result = await deps.registry.get(ctx.chat!.id).setModelPref(model.modelId);
    if (!result.ok) {
      await deps.ephemeral.reply(ctx, `Не удалось выбрать модель: ${result.error}`, { reply_markup: homeKeyboard() });
      return;
    }
    await openMainMenu(ctx, deps);
  });
  bot.callbackQuery(new RegExp(`^model:clear:${TOKEN}$`), async (ctx) => {
    if (!deps.menuCache.getModels(ctx.chat!.id, ctx.match![1]!)) {
      await ctx.answerCallbackQuery({ text: "Срок действия списка моделей истёк. Откройте его снова." });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Выбрана модель Codex по умолчанию" });
    await deps.registry.get(ctx.chat!.id).setModelPref("");
    await openMainMenu(ctx, deps);
  });
  bot.callbackQuery("model:refresh", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showModels(ctx, deps);
  });
  bot.callbackQuery("status:refresh", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showStatus(ctx, deps, true);
  });
}
