/**
 * Control commands: /start /help /status /new /cancel /btw /flush.
 */
import type { Bot } from "grammy";
import { textPrompt } from "../../app/types.js";
import type { BotDeps } from "../deps.js";
import { HELP_TEXT } from "../commands.js";
import { compactKeyboard } from "../menu/keyboard.js";
import { openMainMenu } from "../menu/main.js";
import { refreshMenu } from "../menu/refresh.js";
import { extractReplyContext } from "../reply-context.js";
import { showNewSessionConfirmation } from "./sessions.js";
import { showStatus } from "./inline-catalog.js";

export function registerControl(bot: Bot, deps: BotDeps): void {
  bot.command("start", async (ctx) => {
    const agent = deps.acp.agentInfo;
    const lines = [
      "\u{1F44B} Добро пожаловать! Я связываю Telegram с Codex на этом компьютере.",
      agent?.name ? `Подключено: ${agent.name} ${agent.version ?? ""}`.trim() : "",
      "",
      "Нажмите «☰ Меню», чтобы увидеть действия. Пока я работаю, здесь будет статус",
      "(его можно открыть в меню: «Статус»). Просто отправьте сообщение, чтобы начать.",
    ].filter(Boolean);
    await ctx.reply(lines.join("\n"), { reply_markup: compactKeyboard() });
    await deps.statusPanel.refresh(ctx.chat.id);
  });

  bot.command("menu", async (ctx) => {
    await openMainMenu(ctx, deps);
    await deps.statusPanel.refresh(ctx.chat.id);
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(HELP_TEXT);
  });

  bot.command("status", (ctx) => showStatus(ctx, deps));

  bot.command("new", async (ctx) => {
    await showNewSessionConfirmation(ctx, deps);
  });

  bot.command("cancel", async (ctx) => {
    const rt = deps.registry.get(ctx.chat.id);
    const cancelled = await rt.cancel();
    await ctx.reply(cancelled ? "\u23F9 Останавливаю текущую задачу…" : "Сейчас ничего не выполняется.");
  });

  bot.command("btw", async (ctx) => {
    const text = (ctx.match || "").toString().trim();
    if (!text) {
      await ctx.reply("Напишите задачу после команды: /btw <что нужно сделать>");
      return;
    }
    const rt = deps.registry.get(ctx.chat.id);
    // Run it right away when idle; otherwise queue it to run automatically the
    // moment the current turn finishes (can't interrupt an in-flight agent turn).
    const result = await deps.registry.submitPrompt(ctx.chat.id, textPrompt(text, undefined, extractReplyContext(ctx)));
    if (result.kind === "submitted" && result.outcome === "queued") {
      await ctx.reply(
        `📥 Добавлено в очередь · позиция ${result.runtime.queueLength}`,
      );
    } else if (result.kind === "submitted") {
      await ctx.reply("\u25B6\uFE0F Принято, выполняю…");
    }
  });

  bot.command("flush", async (ctx) => {
    const rt = deps.registry.get(ctx.chat.id);
    if (rt.queueLength === 0) {
      await ctx.reply("Очередь пуста.");
      return;
    }
    if (rt.isBusy) {
      await ctx.reply(`\u23F3 В очереди: ${rt.queueLength}. Сообщения выполнятся после текущей задачи.`);
      return;
    }
    await ctx.reply("\u25B6\uFE0F Продолжаю очередь по порядку…");
    rt.resumeQueue();
  });
}
