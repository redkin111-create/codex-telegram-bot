/**
 * Authorization middleware: restricts the bot to ALLOWED_USERS when configured.
 */
import type { Context, NextFunction } from "grammy";
import type { AppConfig } from "../config.js";
import { createLogger } from "../logger.js";

const log = createLogger("auth");

export function createAuthMiddleware(cfg: AppConfig) {
  if (cfg.allowedUsers.size === 0) log.error("ALLOWED_USERS is empty — denying access to all users.");

  return async (ctx: Context, next: NextFunction): Promise<void> => {
    // Remote shell access is never exposed in groups, channels or inline chats.
    // An allowed sender in a group is not sufficient: every group member can
    // read the bot\'s messages, diffs and uploaded files.
    if (ctx.chat?.type !== "private") return;
    const from = ctx.from;
    // Only a genuine USER action is subject to (and worth replying to) the auth
    // gate. Ignore everything else silently — most importantly the bot's OWN
    // updates: the status panel being pinned/unpinned emits a service message
    // whose `from` is THIS bot (is_bot), and replying "⛔ Not authorized" to
    // that (or to any service/no-`from` update) spammed the chat with false
    // rejections. Real unauthorized users still get one clear reply below.
    if (!from || from.is_bot) return;
    const m = ctx.message ?? ctx.editedMessage;
    if (m && (m.pinned_message || m.new_chat_members || m.left_chat_member)) return;

    const userId = String(from.id);
    if (cfg.allowedUsers.has(userId)) {
      await next();
      return;
    }
    log.warn(`blocked unauthorized user ${userId}`);
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: "\u26D4 Нет доступа.", show_alert: true }).catch(() => {});
      return;
    }
    if (ctx.chat) {
      await ctx.reply("\u26D4 Нет доступа. Попросите владельца бота добавить ваш Telegram ID.");
    }
  };
}
