/**
 * Control commands: /start /help /status /new /cancel /btw /flush.
 */
import type { Bot } from "grammy";
import { basename } from "node:path";
import { textPrompt } from "../../app/types.js";
import type { BotDeps } from "../deps.js";
import { HELP_TEXT } from "../commands.js";
import { compactKeyboard } from "../menu/keyboard.js";
import { openMainMenu } from "../menu/main.js";
import { refreshMenu } from "../menu/refresh.js";
import { extractReplyContext } from "../reply-context.js";

export function registerControl(bot: Bot, deps: BotDeps): void {
  bot.command("start", async (ctx) => {
    const rt = deps.registry.get(ctx.chat.id);
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

  bot.command("status", async (ctx) => {
    const rt = deps.registry.get(ctx.chat.id);
    const lines = [
      "\u{1F4CA} Статус",
      `Проект: ${rt.projectName ?? (basename(rt.cwd) || rt.cwd)}`,
      `Папка: ${rt.cwd}`,
      `Сеанс: ${rt.sessionId ?? "ещё не создан"}`,
      `Состояние: ${rt.isBusy ? "\u23F3 выполняется" : "\u2705 ожидание"}`,
      `Сообщений в очереди: ${rt.queueLength}`,
    ];
    const subagents = deps.registry.subagentSummaryForChat(ctx.chat.id);
    if (subagents) lines.push(`Дополнительные агенты: ${subagents}`);
    await ctx.reply(lines.join("\n"));
  });

  bot.command("new", async (ctx) => {
    const rt = deps.registry.get(ctx.chat.id);
    try {
      await deps.registry.controller(ctx.chat.id).addNew(rt.cwd, rt.projectName);
      await refreshMenu(ctx, deps, `\u2728 Новый сеанс запущен в ${rt.projectName ?? rt.cwd}`);
    } catch (err) {
      await ctx.reply(`\u274C Не удалось начать сеанс: ${(err as Error).message}`);
    }
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
    const outcome = await rt.submit(textPrompt(text, undefined, extractReplyContext(ctx)));
    if (outcome === "queued") {
      await ctx.reply(
        `\u{1F4E5} Добавлено в очередь (место ${rt.queueLength}). Выполню после текущей задачи.`,
      );
    } else {
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
    // Idle: drain the queue by submitting an empty trigger that flushes.
    await ctx.reply("\u25B6\uFE0F Выполняю сообщения из очереди…");
    const drained = rt.drainQueueToPrompt();
    if (drained) await rt.submit(drained);
  });
}
