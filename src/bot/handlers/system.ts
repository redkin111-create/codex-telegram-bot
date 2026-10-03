/**
 * System commands: /queue /clearqueue /model /restart.
 */
import type { Bot } from "grammy";
import type { BotDeps } from "../deps.js";
import { briefErrorMessage } from "../prompt-retry.js";

export function registerSystem(bot: Bot, deps: BotDeps): void {
  bot.command("queue", async (ctx) => {
    const rt = deps.registry.get(ctx.chat.id);
    if (rt.queueLength === 0) {
      await ctx.reply("Очередь пуста. Отправьте сообщение, пока бот занят, или используйте /btw <текст>.");
      return;
    }
    await ctx.reply(`\u{1F4E5} В очереди сообщений: ${rt.queueLength}. Они выполнятся после текущей задачи. Чтобы запустить сразу, используйте /flush.`);
  });

  bot.command("clearqueue", async (ctx) => {
    const rt = deps.registry.get(ctx.chat.id);
    const n = rt.clearQueue();
    await ctx.reply(n > 0 ? `\u{1F5D1} Удалено сообщений из очереди: ${n}.` : "Очередь уже пуста.");
  });

  bot.command("model", async (ctx) => {
    const modelId = (ctx.match || "").toString().trim();
    const rt = deps.registry.get(ctx.chat.id);
    if (!modelId) {
      await ctx.reply("Укажите модель: /model <название>. Изменение затронет текущий сеанс.");
      return;
    }
    if (!rt.sessionId) {
      await ctx.reply("Сначала начните сеанс: отправьте сообщение или выберите папку командой /projects.");
      return;
    }
    try {
      await deps.acp.setModel(rt.sessionId, modelId);
      await ctx.reply(`\u2705 Для этого сеанса выбрана модель \`${modelId}\`.`, { parse_mode: "Markdown" });
    } catch (err) {
      await ctx.reply(`\u274C Не удалось сменить модель: ${briefErrorMessage(err as Error)}`);
    }
  });

  bot.command("restart", async (ctx) => {
    await ctx.reply("\u{1F501} Перезапускаю Codex…");
    try {
      await deps.acp.restart();
      await ctx.reply("\u2705 Codex перезапущен. Сеанс подключится снова при следующем сообщении.");
    } catch (err) {
      await ctx.reply(`\u274C Не удалось перезапустить Codex: ${briefErrorMessage(err as Error)}`);
    }
  });
}
