/** View and manage the existing per-session follow-up queue. */
import { type Bot, type Context, InlineKeyboard } from "grammy";
import type { SessionRuntime } from "../session-runtime.js";
import type { BotDeps } from "../deps.js";

const EDIT_TTL_MS = 2 * 60 * 1000;
const PREVIEW_CHARS = 100;
const SESSION_ID = "([0-9a-fA-F-]{36})";

interface PendingEdit {
  sessionId: string;
  itemId: string;
  expiresAt: number;
}

export function registerQueue(bot: Bot, deps: BotDeps): void {
  const edits = new Map<number, PendingEdit>();

  bot.command("queue", async (ctx) => showQueue(ctx, deps));

  // Queue-edit input must be captured before session search and the catch-all
  // prompt handler, so it can never accidentally become a Codex prompt.
  bot.on("message:text", async (ctx, next) => {
    const chatId = ctx.chat.id;
    const pending = edits.get(chatId);
    if (!pending) return next();
    if (Date.now() >= pending.expiresAt) {
      edits.delete(chatId);
      await ctx.deleteMessage().catch(() => {});
      await ctx.reply("⌛ Редактирование очереди истекло. Текст не отправлен в Codex.");
      return;
    }
    const text = ctx.message.text.trim();
    if (!text) {
      await ctx.reply("Введите непустой текст для пункта очереди.");
      return;
    }
    edits.delete(chatId);
    await ctx.deleteMessage().catch(() => {});
    const runtime = deps.registry.runtimeForSession(chatId, pending.sessionId);
    const updated = runtime?.editQueued(pending.itemId, text) ?? false;
    await ctx.reply(updated ? "✅ Пункт очереди изменён." : "Этот пункт уже выполняется или удалён.");
    await showQueue(ctx, deps, pending.sessionId, false);
  });

  bot.callbackQuery("q:open", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showQueue(ctx, deps);
  });
  bot.callbackQuery(new RegExp(`^q:view:${SESSION_ID}$`), async (ctx) => {
    const sessionId = ctx.match![1]!;
    await ctx.answerCallbackQuery();
    await showQueue(ctx, deps, sessionId);
  });
  bot.callbackQuery(new RegExp(`^q:edit:${SESSION_ID}:([a-z0-9]+)$`), async (ctx) => {
    const sessionId = ctx.match![1]!;
    const itemId = ctx.match![2]!;
    const runtime = deps.registry.runtimeForSession(ctx.chat!.id, sessionId);
    if (!runtime?.queuedPrompts.some((entry) => entry.id === itemId)) {
      await ctx.answerCallbackQuery({ text: "Пункт уже выполняется или удалён.", show_alert: true });
      return;
    }
    edits.set(ctx.chat!.id, { sessionId, itemId, expiresAt: Date.now() + EDIT_TTL_MS });
    await ctx.answerCallbackQuery();
    await ctx.reply("✏️ Отправьте новый текст для пункта очереди. Ожидание — 2 минуты.");
  });
  bot.callbackQuery(new RegExp(`^q:del:${SESSION_ID}:([a-z0-9]+)$`), async (ctx) => {
    const runtime = deps.registry.runtimeForSession(ctx.chat!.id, ctx.match![1]!);
    const removed = runtime?.removeQueued(ctx.match![2]!) ?? false;
    await ctx.answerCallbackQuery({ text: removed ? "Пункт удалён." : "Пункт уже выполняется или удалён." });
    await showQueue(ctx, deps, ctx.match![1]!);
  });
  bot.callbackQuery(new RegExp(`^q:clear:${SESSION_ID}$`), async (ctx) => {
    const sessionId = ctx.match![1]!;
    const runtime = deps.registry.runtimeForSession(ctx.chat!.id, sessionId);
    if (!runtime) {
      await ctx.answerCallbackQuery({ text: "Сеанс больше не управляется этим чатом." });
      return;
    }
    const count = runtime.clearQueue();
    const pending = edits.get(ctx.chat!.id);
    if (pending?.sessionId === sessionId) edits.delete(ctx.chat!.id);
    await ctx.answerCallbackQuery({ text: count ? `Удалено пунктов: ${count}` : "Очередь уже пуста." });
    await showQueue(ctx, deps, sessionId);
  });
  bot.callbackQuery(new RegExp(`^q:resume:${SESSION_ID}$`), async (ctx) => {
    const sessionId = ctx.match![1]!;
    const runtime = deps.registry.runtimeForSession(ctx.chat!.id, sessionId);
    const resumed = runtime?.resumeQueue() ?? false;
    await ctx.answerCallbackQuery({ text: resumed ? "Продолжаю очередь." : "Очередь нельзя продолжить сейчас." });
    await showQueue(ctx, deps, sessionId);
  });
}

export async function showQueue(
  ctx: Context,
  deps: BotDeps,
  sessionId?: string,
  open = true,
): Promise<void> {
  const chatId = ctx.chat!.id;
  const runtime = sessionId
    ? deps.registry.runtimeForSession(chatId, sessionId)
    : deps.registry.get(chatId);
  if (!runtime) {
    await ctx.reply("Этот сеанс больше не управляется данным чатом.");
    return;
  }
  if (open) await deps.ephemeral.open(ctx);
  const items = runtime.queuedPrompts;
  const lines = [`📥 Очередь · ${runtime.projectName || "Текущий сеанс"}`];
  if (runtime.isBusy) lines.push("", "Сейчас выполняется:", preview(runtime.activePromptText || "Задача Codex", PREVIEW_CHARS));
  if (runtime.isQueuePaused) lines.push("", `⏸ Очередь приостановлена · осталось ${items.length}`);
  if (items.length === 0) lines.push("", "Очередь пуста.");
  else {
    lines.push("", "Дальше:");
    items.forEach(({ input }, index) => {
      const fileLabels = input.attachmentNames?.length ? `📎 ${input.attachmentNames.join(", ")}` : "";
      const imageLabels = input.images.length ? `🖼 ${input.images.length}` : "";
      const body = input.displayText ?? input.text;
      const detail = [fileLabels, imageLabels, body].filter(Boolean).join(" · ");
      lines.push(`${index + 1}. ${preview(detail || "Сообщение", PREVIEW_CHARS)}`);
    });
  }
  const keyboard = new InlineKeyboard();
  items.forEach(({ id }, index) => {
    keyboard.text(`✏️ ${index + 1}`, `q:edit:${runtime.sessionId}:${id}`)
      .text(`🗑 ${index + 1}`, `q:del:${runtime.sessionId}:${id}`).row();
  });
  if (items.length) keyboard.text("🧹 Очистить очередь", `q:clear:${runtime.sessionId}`).row();
  if (runtime.isQueuePaused && items.length) keyboard.text("▶️ Продолжить очередь", `q:resume:${runtime.sessionId}`).row();
  keyboard.text("⬅ Активные", "m:running").text("🏠 Меню", "ui:home");
  await deps.ephemeral.reply(ctx, lines.join("\n"), { reply_markup: keyboard });
}

function preview(value: string, max: number): string {
  const clean = value.replace(/[\r\n\t]+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}
