/** Per-chat controls for completion and background Telegram notifications. */
import { type Bot, type Context, InlineKeyboard } from "grammy";
import { notificationPreset, type NotificationPreset } from "../../app/notifications.js";
import type { BotDeps } from "../deps.js";

type ToggleKey = "completion" | "error" | "backgroundCompletion" | "progress";

export function registerNotifications(bot: Bot, deps: BotDeps): void {
  bot.callbackQuery(/^notify:toggle:(completion|error|backgroundCompletion|progress)$/, async (ctx) => {
    const key = ctx.match![1] as ToggleKey;
    const current = deps.settings.get(ctx.chat!.id).notifications!;
    deps.settings.update(ctx.chat!.id, {
      notifications: { ...current, [key]: !current[key], mode: "custom" },
    });
    await ctx.answerCallbackQuery();
    await showNotificationSettings(ctx, deps, false);
  });
  bot.callbackQuery(/^notify:preset:(all|attention|quiet)$/, async (ctx) => {
    const preset = ctx.match![1] as NotificationPreset;
    deps.settings.update(ctx.chat!.id, { notifications: notificationPreset(preset) });
    await ctx.answerCallbackQuery({ text: "Настройки уведомлений сохранены." });
    await showNotificationSettings(ctx, deps, false);
  });
}

export async function showNotificationSettings(ctx: Context, deps: BotDeps, open = true): Promise<void> {
  if (open) await deps.ephemeral.open(ctx);
  const prefs = deps.settings.get(ctx.chat!.id).notifications!;
  const mode = prefs.mode === "all" ? "Все важные"
    : prefs.mode === "attention" ? "Только когда нужно внимание"
      : prefs.mode === "quiet" ? "Тихий" : "Настроен вручную";
  const lines = [
    "🔔 Уведомления",
    `${mark(prefs.completion)} Завершение задачи`,
    "✅ Требуется подтверждение · всегда",
    `${mark(prefs.error)} Ошибка`,
    `${mark(prefs.backgroundCompletion)} Фоновый сеанс завершён`,
    `${mark(prefs.progress)} Промежуточный прогресс`,
    "",
    `Режим: ${mode}`,
    "Потоковый ответ foreground-сеанса показывается независимо от настройки завершения.",
  ];
  const keyboard = new InlineKeyboard()
    .text(`${mark(prefs.completion)} Завершение`, "notify:toggle:completion")
    .text(`${mark(prefs.error)} Ошибки`, "notify:toggle:error").row()
    .text(`${mark(prefs.backgroundCompletion)} Фон`, "notify:toggle:backgroundCompletion")
    .text(`${mark(prefs.progress)} Прогресс`, "notify:toggle:progress").row()
    .text("✅ Все важные", "notify:preset:all")
    .text("🔕 Только внимание", "notify:preset:attention").row()
    .text("🔇 Тихий", "notify:preset:quiet").row()
    .text("⬅ Ещё", "ui:back").text("🏠 Меню", "ui:home");
  await deps.ephemeral.reply(ctx, lines.join("\n"), { reply_markup: keyboard });
}

function mark(value: boolean): string {
  return value ? "✅" : "○";
}
