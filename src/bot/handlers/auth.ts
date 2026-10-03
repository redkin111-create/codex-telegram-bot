/**
 * /reauth — re-authenticate Codex. Shows a login-method picker (ChatGPT, API
 * key, or import an existing login), then drives logout → login → agent restart
 * on a single, self-animated status message. Inline buttons drive the flow:
 *   • ChatGPT / API key / Import — pick how to log in
 *   • Cancel        — abort the picker or the in-flight login
 *   • Back / Change method — return to the picker
 *   • Retry         — re-run the last method on the same message
 *   • Restart agent — retry just the agent restart after a restart failure
 *
 * Guarded: refused while a prompt is in flight (logging out would break the
 * running turn) and serialised per chat so two runs can't overlap.
 */
import type { Bot } from "grammy";
import type { BotDeps } from "../deps.js";
import { type LoginMethod, ReauthController } from "../reauth-controller.js";

export function registerReauth(bot: Bot, deps: BotDeps): void {
  const controller = new ReauthController(
    deps.api,
    deps.acp,
    deps.cfg.codexCliPath,
    () => deps.usage.account(),
    () => deps.usage.isLoggedIn(),
  );

  // API-key text capture. Registered before the catch-all message handler so
  // the reply feeds the reauth flow instead of becoming a prompt.
  bot.on("message:text", async (ctx, next) => {
    const chatId = ctx.chat.id;
    if (!controller.awaitingApiKeyInput(chatId)) return next();
    const text = ctx.message.text;
    if (text.startsWith("/")) return next(); // let a command through; picker stays
    await controller.submitApiKeyInput(chatId, text);
    // Best-effort: delete the message carrying the secret key.
    await ctx.api.deleteMessage(chatId, ctx.message.message_id).catch(() => {});
  });

  bot.command("reauth", async (ctx) => {
    if (controller.isBusy(ctx.chat.id)) {
      await ctx.reply("\u{1F510} Вход уже выполняется.");
      return;
    }
    await controller.chooseMethod(ctx.chat.id);
  });

  bot.callbackQuery(/^reauth:method:(chatgpt|apikey|import)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (chatId !== undefined && messageId !== undefined) {
      await controller.pickMethod(chatId, messageId, ctx.match![1] as LoginMethod);
    }
  });

  bot.callbackQuery("reauth:choose-back", async (ctx) => {
    await ctx.answerCallbackQuery();
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (chatId !== undefined && messageId !== undefined) await controller.chooseMethod(chatId, messageId);
  });

  bot.callbackQuery("reauth:choose-cancel", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Отменено" });
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (chatId !== undefined && messageId !== undefined) await controller.cancelChoice(chatId, messageId);
  });

  bot.callbackQuery("reauth:cancel", async (ctx) => {
    const chatId = ctx.chat?.id;
    const ok = chatId !== undefined && controller.cancel(chatId);
    await ctx.answerCallbackQuery({ text: ok ? "Останавливаю…" : "Нечего отменять" });
  });

  bot.callbackQuery("reauth:retry", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Повторяю…" });
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (chatId !== undefined && messageId !== undefined) await controller.retry(chatId, messageId);
  });

  bot.callbackQuery("reauth:restart", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Перезапускаю Codex…" });
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (chatId !== undefined && messageId !== undefined) await controller.restartAgent(chatId, messageId);
  });
}
