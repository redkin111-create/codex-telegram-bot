/** Browse, resume, and watch Codex sessions, globally or within one project. */
import { type Bot, type Context, InlineKeyboard } from "grammy";
import { basename } from "node:path";
import type { ProjectEntry } from "../../projects/manager.js";
import { sameProjectPath } from "../../projects/manager.js";
import { readHistory } from "../../sessions/history.js";
import type { SessionMeta } from "../../sessions/types.js";
import type { BotDeps } from "../deps.js";
import { INLINE_PAGE_SIZE, pageWindow, compactLabel } from "../menu/paging.js";
import { refreshMenu } from "../menu/refresh.js";
import { showHistory } from "./history.js";
import { buildSessionCard, relTime } from "./session-card.js";

const PAGE_SIZE = INLINE_PAGE_SIZE;
const UUID = "([0-9a-fA-F-]{36})";

export async function showSessions(ctx: Context, deps: BotDeps, query?: string, project?: ProjectEntry): Promise<void> {
  const chatId = ctx.chat!.id;
  deps.menuCache.setSelectedProject(chatId, project);
  const q = (query ?? "").trim().toLowerCase();
  let metas = deps.store.list(500);
  // list() refreshes the session index, so registry cleanup checks Codex's
  // current files without touching any Codex-owned data.
  deps.telegramSessions.prune((id) => Boolean(deps.store.get(id)));
  if (project) metas = metas.filter((meta) => meta.cwd && sameProjectPath(meta.cwd, project.path));
  if (q) metas = metas.filter((m) => `${m.title} ${m.cwd} ${m.sessionId}`.toLowerCase().includes(q));
  const heading = project ? `Сеансы · ${project.name}` : q ? `Сеансы по запросу «${q}»` : "Все сеансы Codex";
  deps.menuCache.setSessions(chatId, metas, heading, project);
  await renderSessionPage(ctx, deps, 0);
}

/** Confirmation is required before any interactive `thread/start` call. */
export async function showNewSessionConfirmation(ctx: Context, deps: BotDeps, project?: ProjectEntry): Promise<void> {
  const chatId = ctx.chat!.id;
  const rt = deps.registry.get(chatId);
  const target = project ?? {
    name: rt.projectName || basename(rt.cwd) || "Codex",
    path: rt.cwd,
    lastUsed: Date.now(),
  };
  const token = deps.menuCache.beginSessionStart(chatId, target);
  await deps.ephemeral.open(ctx);
  await deps.ephemeral.reply(ctx,
    `🆕 Создать новую сессию Codex через Telegram?\n\nПроект: ${target.name}\nСессия будет сохранена в хранилище Codex.\n⚠ Она может не отображаться в боковой панели Codex Desktop.`,
    { reply_markup: new InlineKeyboard().text("✅ Создать", `s:create:${token}`).row().text("⬅ Отмена", `s:cancel:${token}`) },
  );
}

/** The only interactive path that starts a user-requested new thread. */
export async function createConfirmedSession(deps: BotDeps, chatId: number, token: string) {
  const target = deps.menuCache.consumeSessionStart(chatId, token);
  if (target === false || target === undefined) return undefined;
  const runtime = await deps.registry.controller(chatId).addNew(target.path, target.name);
  return { runtime, target };
}

async function renderSessionPage(ctx: Context, deps: BotDeps, page: number): Promise<void> {
  await deps.ephemeral.open(ctx);
  const cached = deps.menuCache.getSessions(ctx.chat!.id);
  if (!cached) return;
  const currentId = deps.registry.get(ctx.chat!.id).sessionId;
  const { text, keyboard } = sessionPage(
    cached.metas, cached.heading, page, cached.token, currentId,
    (id) => Boolean(deps.telegramSessions.get(id)), Boolean(cached.project),
  );
  await deps.ephemeral.reply(ctx, text, { reply_markup: keyboard });
}

export function sessionPage(
  metas: SessionMeta[], heading: string, requestedPage: number, token: string,
  currentId?: string, isTelegramCreated: (id: string) => boolean = () => false,
  projectScoped = false,
): { text: string; keyboard: InlineKeyboard } {
  const { page: p, pages, start, end } = pageWindow(metas.length, requestedPage, PAGE_SIZE);
  const kb = new InlineKeyboard();
  for (let i = start; i < end; i++) {
    const meta = metas[i]!;
    const current = meta.sessionId === currentId ? "✅ " : "";
    const origin = isTelegramCreated(meta.sessionId) ? "📱" : "🖥";
    const project = meta.cwd ? basename(meta.cwd) : "проект не указан";
    kb.text(`${current}${origin} ${compactLabel(meta.title, 30)} · ${compactLabel(project, 16)}`, `s:${token}:${i}`).row();
  }
  if (pages > 1) {
    if (p > 0) kb.text("◀", `sp:${token}:${p - 1}`);
    kb.text(`${p + 1}/${pages}`, "noop");
    if (p < pages - 1) kb.text("▶", `sp:${token}:${p + 1}`);
    kb.row();
  }
  kb.text("🆕 Новая сессия Telegram", "s:new").row();
  if (projectScoped) {
    kb.text("🌐 Все сеансы", "s:all").text("⬅ Проекты", "p:menu").row();
  }
  kb.text("🏠 Главное меню", "ui:home");

  const lines = [`💬 ${compactLabel(heading, 56)} · ${metas.length}`, ""];
  if (metas.length === 0) lines.push(projectScoped ? "В этом проекте пока нет сеансов Codex." : "Сохранённых сеансов Codex не найдено.");
  for (const meta of metas.slice(start, end)) {
    const current = meta.sessionId === currentId ? "✅ " : "";
    const origin = isTelegramCreated(meta.sessionId) ? "📱" : "🖥";
    const project = meta.cwd ? basename(meta.cwd) : "проект не указан";
    lines.push(`${current}${origin} ${compactLabel(meta.title, 34)} · ${compactLabel(project, 18)} · ${relTime(meta.updatedAt)}`);
  }
  return { text: lines.join("\n"), keyboard: kb };
}

export function selectionCard(meta: SessionMeta, token: string, index: number, selfPid?: number, telegramCreated = false) {
  const card = buildSessionCard(meta, { openLabel: "▶️ Продолжить", selfPid, origin: telegramCreated ? "telegram" : "existing" });
  card.text += "\nСообщения здесь продолжат ту же переписку Codex.";
  card.keyboard.row()
    .text("⬅ К списку сеансов", `sp:${token}:${Math.floor(index / PAGE_SIZE)}`)
    .text("🏠 Главное меню", "ui:home");
  return card;
}

export function registerSessions(bot: Bot, deps: BotDeps): void {
  bot.command("sessions", (ctx) => showSessions(ctx, deps, ctx.match?.toString()));
  bot.command("active", async (ctx) => {
    const metas = deps.store.listActive();
    if (metas.length === 0) {
      await deps.ephemeral.open(ctx);
      await deps.ephemeral.reply(ctx, "Сейчас на этом компьютере нет запущенных сеансов.");
      return;
    }
    deps.menuCache.setSessions(ctx.chat!.id, metas, "Сеансы, запущенные сейчас");
    await renderSessionPage(ctx, deps, 0);
  });

  bot.callbackQuery(/^sp:([a-f0-9]{16}):(\d+)$/, async (ctx) => {
    const cached = deps.menuCache.getSessions(ctx.chat!.id, ctx.match![1]);
    if (!cached) return void ctx.answerCallbackQuery({ text: "Срок действия списка истёк. Откройте сеансы ещё раз." });
    await ctx.answerCallbackQuery();
    await renderSessionPage(ctx, deps, Number(ctx.match![2]));
  });

  bot.callbackQuery(/^s:([a-f0-9]{16}):(\d+)$/, async (ctx) => {
    const token = ctx.match![1]!;
    const index = Number(ctx.match![2]);
    const meta = deps.menuCache.getSession(ctx.chat!.id, token, index);
    if (!meta || !deps.store.get(meta.sessionId)) {
      await ctx.answerCallbackQuery({ text: "Сеанс больше недоступен. Обновите список сеансов.", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Информация о сеансе" });
    const card = selectionCard(meta, token, index, deps.acp.pid, Boolean(deps.telegramSessions.get(meta.sessionId)));
    await deps.ephemeral.reply(ctx, card.text, { reply_markup: card.keyboard });
  });

  bot.callbackQuery("s:new", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showNewSessionConfirmation(ctx, deps, deps.menuCache.getSessions(ctx.chat!.id)?.project);
  });
  bot.callbackQuery(/^s:create:([a-f0-9]{16})$/, async (ctx) => {
    const chatId = ctx.chat!.id;
    const pending = deps.menuCache.getPendingSessionStart(chatId, ctx.match![1]!);
    if (!pending) return void ctx.answerCallbackQuery({ text: "Подтверждение устарело. Нажмите «Новая сессия» ещё раз.", show_alert: true });
    await ctx.answerCallbackQuery({ text: "Создаю сессию…" });
    try {
      const created = await createConfirmedSession(deps, chatId, ctx.match![1]!);
      if (!created) return;
      const { runtime: rt, target } = created;
      await ctx.reply(`✅ Новая сессия Codex создана через Telegram.\n📁 ${target.name}\n🆔 ${rt.sessionId?.slice(0, 8) ?? "готово"}`);
      await refreshMenu(ctx, deps, `📱 Новая сессия · ${target.name}`);
    } catch (err) {
      await ctx.reply(`❌ Не удалось создать сессию: ${(err as Error).message}`);
    }
  });
  bot.callbackQuery(/^s:cancel:([a-f0-9]{16})$/, async (ctx) => {
    if (!deps.menuCache.cancelSessionStart(ctx.chat!.id, ctx.match![1]!)) {
      return void ctx.answerCallbackQuery({ text: "Это подтверждение уже закрыто." });
    }
    await ctx.answerCallbackQuery({ text: "Создание отменено." });
    await ctx.editMessageText("Создание новой сессии отменено.", {
      reply_markup: new InlineKeyboard().text("⬅ Проекты", "p:menu").text("🏠 Меню", "ui:home"),
    }).catch(() => {});
  });
  bot.callbackQuery("s:all", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showSessions(ctx, deps);
  });

  bot.command("unwatch", async (ctx) => {
    const rt = deps.registry.get(ctx.chat.id);
    await ctx.reply(rt.stopWatch() ? "🛑 Слежение остановлено." : "Слежение не включено.");
  });

  bot.callbackQuery(new RegExp(`^sess:${UUID}$`), async (ctx) => {
    const id = ctx.match![1]!;
    const meta = deps.store.get(id);
    if (!meta) return void ctx.answerCallbackQuery({ text: "Сеанс не найден." });
    await ctx.answerCallbackQuery();
    await deps.ephemeral.clear(ctx.chat!.id);
    const fgCwd = deps.registry.get(ctx.chat!.id).cwd;
    const cwd = meta.cwd || fgCwd;
    const projectName = basename(meta.cwd || fgCwd) || "session";
    const prior = readHistory(deps.store.jsonlPath(id), 24);
    try {
      const { result, alreadyControlled } = await deps.registry.controller(ctx.chat!.id).addAttach(id, cwd, projectName, prior);
      await ctx.reply(alreadyControlled ? `🔀 Переключено на «${meta.title}»` : connectMessage(result, meta));
      await refreshMenu(ctx, deps, `📂 ${meta.title}`);
      await showHistory(deps, ctx.chat!.id, id, meta);
    } catch (err) {
      await ctx.reply(`❌ Не удалось продолжить этот сеанс: ${(err as Error).message}`);
    }
  });

  bot.callbackQuery(new RegExp(`^hist:${UUID}$`), async (ctx) => {
    const id = ctx.match![1]!;
    await ctx.answerCallbackQuery();
    await showHistory(deps, ctx.chat!.id, id, deps.store.get(id));
  });

  bot.callbackQuery(new RegExp(`^watch:${UUID}$`), async (ctx) => {
    const id = ctx.match![1]!;
    await ctx.answerCallbackQuery();
    const meta = deps.store.get(id);
    deps.registry.get(ctx.chat!.id).startWatch(deps.store.jsonlPath(id));
    await ctx.reply(`📡 Слежу за сеансом: ${meta?.title ?? id.slice(0, 8)}\nНовые события будут появляться здесь. Чтобы остановить, отправьте /unwatch.`);
  });
}

function connectMessage(result: "resumed" | "forked", meta: SessionMeta): string {
  if (result === "resumed") return `✅ Тот же сеанс «${meta.title}» продолжен.\n${meta.cwd}\n\nОтправьте сообщение, чтобы продолжить работу.`;
  return `⚠️ Codex сообщил, что этот сеанс уже выполняется или заблокирован. Создан связанный сеанс с недавним контекстом.\n${meta.cwd}\n\nМожно продолжить здесь или следить за исходным сеансом.`;
}
