/** Telegram's compact reply bar and the inline Codex control panel. */
import { type Bot, type Context, InlineKeyboard } from "grammy";
import { reasoningLabel } from "../../app/reasoning.js";
import type { ReasoningEffort } from "../../app/types.js";
import type { BotDeps } from "../deps.js";
import { BAR_LABELS, compactKeyboard, MENU_BTN, RUNNING_BTN, STOP_BTN } from "../menu/keyboard.js";
import { openMainMenu } from "../menu/main.js";
import { registerInlineCatalog, showModels, showReasoning, showSettings, showSkills, showStatus } from "./inline-catalog.js";
import { showMcp } from "./mcp.js";
import { showProjects } from "./projects.js";
import { showRunning } from "./running.js";
import { showAccounts } from "./accounts.js";
import { showNewSessionConfirmation, showSessions } from "./sessions.js";
import { showDiagnostics } from "./diagnostics.js";
import { showTasks } from "./tasks.js";
import { showUsage } from "./usage.js";
import { showNotificationSettings } from "./notifications.js";

export function registerMenu(bot: Bot, deps: BotDeps): void {
  bot.hears(BAR_LABELS, async (ctx) => {
    deps.wizard.abort(ctx.chat.id);
    switch (ctx.message?.text) {
      case MENU_BTN:
        return openMainMenu(ctx, deps);
      case RUNNING_BTN:
        return showRunning(ctx, deps);
      case STOP_BTN: {
        const rt = deps.registry.get(ctx.chat.id);
        return void ctx.reply((await rt.cancel()) ? "\u23F9 Останавливаю…" : "Сейчас ничего не выполняется.");
      }
    }
  });

  bot.callbackQuery(/^m:(\w+)$/, (ctx) => dispatchMenu(ctx, deps, ctx.match![1]!));
  bot.callbackQuery("ui:home", async (ctx) => {
    await ctx.answerCallbackQuery();
    await openMainMenu(ctx, deps);
  });
  bot.callbackQuery("ui:back", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showMore(ctx, deps);
  });

  bot.callbackQuery(/^agent:set:(\d+)$/, async (ctx) => {
    const mode = deps.acp.availableModes[Number(ctx.match![1])];
    if (!mode) return void ctx.answerCallbackQuery({ text: "Кнопка устарела. Откройте «Ещё» → «Режим» ещё раз." });
    await deps.registry.get(ctx.chat!.id).setAgentPref(mode.id);
    await confirm(ctx, deps, `\u{1F916} Режим: ${mode.name}`);
  });

  bot.callbackQuery(/^reason:(minimal|low|medium|high|max)$/, async (ctx) => {
    const level = ctx.match![1] as ReasoningEffort;
    deps.registry.get(ctx.chat!.id).setReasoningPref(level);
    await confirm(ctx, deps, `\u{1F9E0} Уровень рассуждений: ${reasoningLabel(level)}`);
  });

  registerInlineCatalog(bot, deps);
}

async function dispatchMenu(ctx: Context, deps: BotDeps, action: string): Promise<void> {
  const chatId = ctx.chat!.id;
  const rt = deps.registry.get(chatId);
  switch (action) {
    case "close":
      await ctx.answerCallbackQuery();
      return void ctx.deleteMessage().catch(() => {});
    case "hidebar":
      await ctx.answerCallbackQuery();
      await ctx.deleteMessage().catch(() => {});
      return void ctx.reply("\u{1F648} Панель скрыта. Чтобы вернуть её, отправьте /menu.", {
        reply_markup: { remove_keyboard: true },
      });
    case "showbar":
      await ctx.answerCallbackQuery();
      return void ctx.reply("\u2328\uFE0F Панель восстановлена.", { reply_markup: compactKeyboard() });
    case "project":
      await ctx.answerCallbackQuery();
      return showProjects(ctx, deps);
    case "sessions":
      await ctx.answerCallbackQuery();
      return showSessions(ctx, deps);
    case "running":
      await ctx.answerCallbackQuery();
      return showRunning(ctx, deps);
    case "tasks":
      await ctx.answerCallbackQuery();
      return showTasks(ctx, deps);
    case "agent":
      await ctx.answerCallbackQuery();
      return showAgentMenu(ctx, deps);
    case "model":
      await ctx.answerCallbackQuery();
      return showModels(ctx, deps);
    case "reasoning":
      await ctx.answerCallbackQuery();
      return showReasoning(ctx, deps);
    case "settings":
      await ctx.answerCallbackQuery();
      return showSettings(ctx, deps);
    case "notifications":
      await ctx.answerCallbackQuery();
      return showNotificationSettings(ctx, deps);
    case "security":
      await ctx.answerCallbackQuery();
      return showSecurity(ctx, deps);
    case "diagnostics":
      await ctx.answerCallbackQuery();
      return showDiagnostics(ctx, deps);
    case "skills":
      await ctx.answerCallbackQuery();
      return showSkills(ctx, deps);
    case "status":
      await ctx.answerCallbackQuery();
      return showStatus(ctx, deps);
    case "usage":
      await ctx.answerCallbackQuery();
      return showUsage(ctx, deps);
    case "accounts":
      await ctx.answerCallbackQuery();
      return showAccounts(ctx, deps);
    case "mcp":
      await ctx.answerCallbackQuery();
      return showMcp(ctx, deps);
    case "more":
      await ctx.answerCallbackQuery();
      return showMore(ctx, deps);
    case "new":
      await ctx.answerCallbackQuery();
      return showNewSessionConfirmation(ctx, deps);
    case "stop":
      return void ctx.answerCallbackQuery({ text: (await rt.cancel()) ? "Останавливаю…" : "Сейчас ничего не выполняется" });
    default:
      return void ctx.answerCallbackQuery({ text: "Неизвестное действие. Откройте меню командой /menu." });
  }
}

async function showMore(ctx: Context, deps: BotDeps): Promise<void> {
  await deps.ephemeral.open(ctx);
  const kb = new InlineKeyboard()
    .text("\u{1F9E9} MCP", "m:mcp").text("\u{1F6E0} Навыки", "m:skills")
    .row()
    .text("\u{1F4C5} Задачи", "m:tasks").text("\u{1F465} Аккаунты", "m:accounts")
    .row()
    .text("\u{1F4B3} Лимиты", "m:usage").text("\u{1F512} Безопасность", "m:security")
    .row()
    .text("🔔 Уведомления", "m:notifications")
    .row()
    .text("\u2699\uFE0F Настройки", "m:settings").text("\u{1F4CA} Статус", "m:status")
    .row()
    .text("\u{1F9ED} Активные сеансы", "m:running").text("\u{1F648} Панель", "m:hidebar")
    .row()
    .text("\u{1F3E5} Диагностика", "m:diagnostics")
    .row()
    .text("\u{1F3E0} Главное меню", "ui:home");
  await deps.ephemeral.reply(ctx, "Ещё", { reply_markup: kb });
}

async function showSecurity(ctx: Context, deps: BotDeps): Promise<void> {
  await deps.ephemeral.open(ctx);
  const text = [
    "🔐 Безопасность",
    `Sandbox: ${deps.cfg.trustAllTools ? "полный доступ" : "только рабочие папки"}`,
    `Подтверждения: ${deps.cfg.trustAllTools ? "выключены" : "для внешних папок и сети"}`,
    `Доверять всем инструментам: ${deps.cfg.trustAllTools ? "ВКЛ" : "ВЫКЛ"}`,
    `Разрешённые пользователи: ${deps.cfg.allowedUsers.size > 0 ? "настроены" : "не настроены"}`,
  ].join("\n");
  await deps.ephemeral.reply(ctx, text, { reply_markup: new InlineKeyboard().text("⬅ Ещё", "ui:back").text("🏠 Меню", "ui:home") });
}

async function confirm(ctx: Context, deps: BotDeps, text: string): Promise<void> {
  await ctx.answerCallbackQuery({ text });
  await deps.statusPanel.refresh(ctx.chat!.id);
  await openMainMenu(ctx, deps);
}

async function showAgentMenu(ctx: Context, deps: BotDeps): Promise<void> {
  const rt = deps.registry.get(ctx.chat!.id);
  await ensureReady(ctx, rt);
  await deps.ephemeral.open(ctx);
  const modes = deps.acp.availableModes.slice(0, 60);
  if (modes.length === 0) {
    await deps.ephemeral.reply(ctx, `Текущий режим: ${rt.agent || "по умолчанию"}\nВ этой версии Codex нет доступных режимов совместной работы.`, {
      reply_markup: new InlineKeyboard().text("\u{1F3E0} Главное меню", "ui:home"),
    });
    return;
  }
  const kb = new InlineKeyboard();
  modes.forEach((m, i) => kb.text(`${m.id === rt.agent ? "\u2705 " : ""}${m.name}`, `agent:set:${i}`).row());
  kb.text("\u{1F3E0} Главное меню", "ui:home");
  await deps.ephemeral.reply(ctx, `Текущий режим: ${rt.agent || "по умолчанию"}\nВыберите режим:`, { reply_markup: kb });
}

async function ensureReady(ctx: Context, rt: { prepare: () => Promise<void> }): Promise<void> {
  await ctx.replyWithChatAction("typing").catch(() => {});
  await rt.prepare().catch(() => {});
}
