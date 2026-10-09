/**
 * /history — show the latest messages of the current (or a chosen) session.
 */
import type { Bot } from "grammy";
import { basename } from "node:path";
import type { BotDeps } from "../deps.js";
import { readConversationHistory } from "../../sessions/history.js";
import type { SessionMeta } from "../../sessions/types.js";
import { sendCompleteWatchReport } from "../watch-report.js";
import { safeSessionTitle } from "../catalog.js";

const ROLE_ICON: Record<string, string> = {
  user: "\u{1F464}",
  assistant: "\u{1F916}",
};

export function registerHistory(bot: Bot, deps: BotDeps): void {
  bot.command("history", async (ctx) => {
    const rt = deps.registry.get(ctx.chat.id);
    if (!rt.sessionId) {
      await ctx.reply("Нет активного сеанса. Откройте /sessions или сначала отправьте сообщение.");
      return;
    }
    const meta = deps.store.get(rt.sessionId);
    await showHistory(deps, ctx.chat.id, rt.sessionId, meta);
  });
}

/** Render and send the recent history of a session. */
export async function showHistory(
  deps: BotDeps,
  chatId: number,
  sessionId: string,
  meta?: SessionMeta,
  count = 16,
): Promise<void> {
  const entries = readConversationHistory(deps.store.jsonlPath(sessionId), count);
  if (entries.length === 0) {
    await deps.api.sendMessage(chatId, "История этого сеанса пока пуста.");
    return;
  }
  const title = safeSessionTitle(meta?.title) || "Сеанс Codex";
  const proj = meta?.projectName || (meta?.cwd ? basename(meta.cwd) : "");
  const header = `\u{1F4DC} **История** \u2014 ${title}${proj ? ` (${proj})` : ""}`;

  const body = entries
    .map((e) => {
      const icon = ROLE_ICON[e.role] ?? "\u2022";
      return `${icon} ${e.text}`;
    })
    .join("\n\n");

  await sendCompleteWatchReport(deps.api, chatId, `${header}\n\n${body}`, { title: "📜 История Codex" });
}
