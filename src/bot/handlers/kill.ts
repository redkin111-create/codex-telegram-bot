/**
 * /killall — terminate all active Codex sessions running on this PC (the ones
 * holding a live session lock), excluding the bot's own agent process. Guarded
 * by an inline confirmation since it kills processes.
 */
import { type Bot, type Context, InlineKeyboard } from "grammy";
import { killPid } from "../../sessions/process.js";
import type { SessionMeta } from "../../sessions/types.js";
import type { BotDeps } from "../deps.js";

function targets(deps: BotDeps): SessionMeta[] {
  const self = deps.acp.pid;
  return deps.store.listActive().filter((s) => s.lockPid && s.lockPid !== self);
}

export async function showKillConfirm(ctx: Context, deps: BotDeps): Promise<void> {
  await deps.ephemeral.open(ctx);
  const active = targets(deps);
  if (active.length === 0) {
    await deps.ephemeral.reply(ctx, "\u2705 Нет других активных сеансов Codex для остановки.");
    return;
  }
  const list = active
    .slice(0, 12)
    .map((s) => `\u2022 ${s.title.slice(0, 40)} (pid ${s.lockPid})`)
    .join("\n");
  const kb = new InlineKeyboard()
    .text(`\u{1F6D1} Остановить (${active.length})`, "killall:confirm")
    .text("Отмена", "killall:cancel");
  await deps.ephemeral.reply(
    ctx,
    `\u{1F6D1} Остановить активные сеансы (${active.length})?\n${list}\n\nТекущий сеанс бота не затрагивается.`,
    { reply_markup: kb },
  );
}

export function registerKill(bot: Bot, deps: BotDeps): void {
  bot.command("killall", (ctx) => showKillConfirm(ctx, deps));

  bot.callbackQuery("killall:cancel", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Действие отменено.").catch(() => {});
  });

  bot.callbackQuery("killall:confirm", async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = targets(deps);
    let killed = 0;
    for (const s of active) {
      if (s.lockPid && killPid(s.lockPid)) killed++;
    }
    await ctx.editMessageText(`\u{1F6D1} Остановлено сеансов: ${killed} из ${active.length}.`).catch(() => {});
  });
}
