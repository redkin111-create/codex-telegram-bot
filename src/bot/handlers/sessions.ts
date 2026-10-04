/** Browse, resume, and watch Codex sessions, globally or within one project. */
import { type Bot, type Context, InlineKeyboard } from "grammy";
import { basename } from "node:path";
import type { ProjectEntry } from "../../projects/manager.js";
import { catalogThreadSessions, includeRegisteredTelegramSessions, isInteractiveThread, listAllCodexThreads, loadCodexProjects, safeSessionTitle, sessionBelongsToProject, threadSourceKind } from "../catalog.js";
import { readConversationHistory, readHistory } from "../../sessions/history.js";
import { cleanSessionPrompt } from "../../sessions/title.js";
import type { SessionMeta } from "../../sessions/types.js";
import type { BotDeps } from "../deps.js";
import { INLINE_PAGE_SIZE, pageWindow, compactLabel } from "../menu/paging.js";
import { refreshMenu } from "../menu/refresh.js";
import { showHistory } from "./history.js";
import { buildSessionCard, relTime } from "./session-card.js";
import { briefErrorMessage } from "../prompt-retry.js";

const PAGE_SIZE = INLINE_PAGE_SIZE;
const UUID = "([0-9a-fA-F-]{36})";
const THREAD_PAGE_SIZE = 100;
const STORE_FALLBACK_LIMIT = 5000;

export async function showSessions(ctx: Context, deps: BotDeps, query?: string, project?: ProjectEntry, reuseLatest = false): Promise<void> {
  const chatId = ctx.chat!.id;
  deps.menuCache.setSelectedProject(chatId, project);
  const q = (query ?? "").trim();
  const registered = deps.telegramSessions.listAll();
  const allowedTelegram = new Map(registered.filter(({ record }) => record.chatId === chatId)
    .map(({ sessionId, record }) => [sessionId, record]));
  const foreignTelegramIds = new Set(registered.filter(({ record }) => record.chatId !== chatId)
    .map(({ sessionId }) => sessionId));
  let metas: SessionMeta[];
  try {
    const options = { limit: THREAD_PAGE_SIZE, sortKey: "recency_at" as const, sortDirection: "desc" as const, ...(q ? { searchTerm: q } : {}) };
    const allThreads = await listAllCodexThreads(deps.acp, options);
    const interactive = allThreads.filter(isInteractiveThread);
    const appServer = allThreads.filter((thread) => threadSourceKind(thread) === "appServer");
    const projects = project ? [project] : await loadCodexProjects(deps.acp);
    metas = catalogThreadSessions(interactive, appServer, allowedTelegram, projects, foreignTelegramIds, (id) => deps.store.get(id));
    metas = includeRegisteredTelegramSessions(
      metas,
      [...allowedTelegram].map(([sessionId, record]) => ({ sessionId, record })),
      (sessionId) => deps.store.get(sessionId),
    );
  } catch {
    // Compatibility path for app-server versions without thread/list.
    metas = deps.store.list(STORE_FALLBACK_LIMIT).flatMap((meta) => {
      const telegram = deps.telegramSessions.get(meta.sessionId);
      if (telegram && telegram.chatId !== chatId) return [];
      const title = safeSessionTitle(meta.title);
      return title ? [{ ...meta, title, telegramCreated: Boolean(telegram) }] : [];
    });
    metas = includeRegisteredTelegramSessions(
      metas,
      [...allowedTelegram].map(([sessionId, record]) => ({ sessionId, record })),
      (sessionId) => deps.store.get(sessionId),
    );
  }
  if (project) {
    metas = metas.filter((meta) => matchesProject(meta, project))
      .map((meta) => ({ ...meta, projectName: meta.projectName || project.name }));
  }
  if (q) {
    const needle = q.toLocaleLowerCase();
    metas = metas.filter((meta) => `${meta.title} ${meta.cwd}`.toLocaleLowerCase().includes(needle));
  }
  const heading = project ? `Сеансы · ${project.name}` : q ? `Переписки · «${q}»` : "Все переписки";
  deps.menuCache.setSessions(chatId, metas, heading, project);
  await renderSessionPage(ctx, deps, 0, reuseLatest);
}

function matchesProject(meta: SessionMeta, project: ProjectEntry): boolean {
  return sessionBelongsToProject(meta, project);
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

export function newSessionConfirmation(name: string): string {
  return `✅ Новый сеанс создан\n📁 ${name}\n📱 Создан через Telegram\n\nОтправьте задачу.`;
}

export async function continueSession(deps: BotDeps, chatId: number, meta: SessionMeta): Promise<string> {
  const foreground = deps.registry.get(chatId);
  const cwd = meta.cwd || foreground.cwd;
  const projectName = meta.projectName || basename(meta.cwd || foreground.cwd) || "проект";
  const prior = readHistory(deps.store.jsonlPath(meta.sessionId), 24);
  const { result } = await deps.registry.controller(chatId).addAttach(meta.sessionId, cwd, projectName, prior);
  return connectMessage(result, meta);
}

async function renderSessionPage(ctx: Context, deps: BotDeps, page: number, reuseLatest = false): Promise<void> {
  if (!reuseLatest) await deps.ephemeral.open(ctx);
  const cached = deps.menuCache.getSessions(ctx.chat!.id);
  if (!cached) return;
  const currentId = deps.registry.get(ctx.chat!.id).sessionId;
  const { text, keyboard } = sessionPage(
    cached.metas, cached.heading, page, cached.token, currentId,
    (id) => Boolean(deps.telegramSessions.get(id)), Boolean(cached.project),
  );
  if (reuseLatest) await deps.ephemeral.editLatest(ctx.chat!.id, text, { reply_markup: keyboard });
  else await deps.ephemeral.reply(ctx, text, { reply_markup: keyboard });
}

export function sessionPage(
  metas: SessionMeta[], heading: string, requestedPage: number, token: string,
  currentId?: string, isTelegramCreated: (id: string) => boolean = () => false,
  projectScoped = false,
): { text: string; keyboard: InlineKeyboard } {
  const visible = metas;
  const { page: p, pages, start, end } = pageWindow(visible.length, requestedPage, PAGE_SIZE);
  const kb = new InlineKeyboard();
  for (let i = start; i < end; i++) {
    const meta = visible[i]!;
    const current = meta.sessionId === currentId ? "✅ " : "";
    const origin = meta.telegramCreated || isTelegramCreated(meta.sessionId) ? "📱" : "🖥";
    const projectName = !projectScoped ? meta.projectName || (meta.cwd ? basename(meta.cwd) : "") : "";
    const projectLabel = projectName ? ` · ${compactLabel(projectName, 18)}` : "";
    const title = compactLabel(meta.title, projectName ? 26 : 40);
    kb.text(`${current}${origin} ${title}${projectLabel} · ${relTime(meta.updatedAt)}`, `s:${token}:${i}`).row();
  }
  if (pages > 1) {
    if (p > 0) kb.text("◀", `sp:${token}:${p - 1}`);
    kb.text(`${p + 1}/${pages}`, "noop");
    if (p < pages - 1) kb.text("▶", `sp:${token}:${p + 1}`);
    kb.row();
  }
  kb.text("🔎 Поиск", "s:search").text("🆕 Новый сеанс", "s:new").row();
  if (projectScoped) kb.text("🌐 Все переписки", "s:all").text("⬅ Проекты", "p:menu").row();
  else kb.text("📁 По проектам", "p:menu").row();
  kb.text("🏠 Главное меню", "ui:home");

  const lines = [`💬 ${compactLabel(heading, 56)}`, `Всего: ${visible.length}`];
  if (visible.length === 0) lines.push(projectScoped ? "В этом проекте пока нет сеансов." : "Переписок не найдено.");
  if (pages > 1) lines[1] = `Всего: ${visible.length} · ${p + 1}/${pages}`;
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

  bot.on("message:text", async (ctx, next) => {
    const chatId = ctx.chat.id;
    const searching = deps.menuCache.consumeSessionSearch(chatId);
    if (!searching || ctx.message.text.startsWith("/") || ["☰ Меню", "🧭 Активные", "⏹ Стоп"].includes(ctx.message.text)) return next();
    const cached = deps.menuCache.getSessions(chatId);
    await ctx.deleteMessage().catch(() => {});
    await showSessions(ctx, deps, ctx.message.text, cached?.project, true);
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
    if (!meta) {
      await ctx.answerCallbackQuery({ text: "Сеанс больше недоступен. Обновите список сеансов.", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Информация о сеансе" });
    const card = selectionCard(meta, token, index, deps.acp.pid, Boolean(deps.telegramSessions.get(meta.sessionId)));
    const latest = readConversationHistory(deps.store.jsonlPath(meta.sessionId), 1)[0];
    if (latest) {
      const message = latest.role === "user" ? cleanSessionPrompt(latest.text) : latest.text.trim();
      if (message) {
        const label = latest.role === "assistant" ? "🤖 Последний ответ Codex" : "👤 Последнее сообщение";
        card.text += `\n\n${label}:\n${message.length > 600 ? `${message.slice(0, 600).trimEnd()}…` : message}`;
      }
    }
    await deps.ephemeral.reply(ctx, card.text, { reply_markup: card.keyboard });
  });

  bot.callbackQuery("s:search", async (ctx) => {
    deps.menuCache.beginSessionSearch(ctx.chat!.id);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("🔎 Отправьте название сеанса для поиска. Поиск действует 2 минуты.", {
      reply_markup: new InlineKeyboard().text("Отмена", "s:search:cancel").text("🏠 Меню", "ui:home"),
    }).catch(() => {});
  });
  bot.callbackQuery("s:search:cancel", async (ctx) => {
    deps.menuCache.clearSessionSearch(ctx.chat!.id);
    await ctx.answerCallbackQuery();
    const cached = deps.menuCache.getSessions(ctx.chat!.id);
    await showSessions(ctx, deps, undefined, cached?.project);
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
      await deps.ephemeral.reply(ctx, newSessionConfirmation(target.name));
      await refreshMenu(ctx, deps, `📱 Новый сеанс · ${target.name}`);
    } catch (err) {
      await ctx.reply(`❌ Не удалось создать сессию: ${briefErrorMessage(err as Error)}`);
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
    const selected = deps.menuCache.getSessionMeta(ctx.chat!.id, id) ?? deps.store.get(id);
    if (!selected) return void ctx.answerCallbackQuery({ text: "Сеанс не найден." });
    const meta = selected;
    await ctx.answerCallbackQuery();
    await deps.ephemeral.clear(ctx.chat!.id);
    try {
      await ctx.reply(await continueSession(deps, ctx.chat!.id, meta));
      await refreshMenu(ctx, deps, `📂 ${meta.title}`);
    } catch (err) {
      await ctx.reply(`❌ Не удалось продолжить этот сеанс: ${briefErrorMessage(err as Error)}`);
    }
  });

  bot.callbackQuery(new RegExp(`^hist:${UUID}$`), async (ctx) => {
    const id = ctx.match![1]!;
    await ctx.answerCallbackQuery();
    await showHistory(deps, ctx.chat!.id, id, deps.menuCache.getSessionMeta(ctx.chat!.id, id) ?? deps.store.get(id));
  });

  bot.callbackQuery(new RegExp(`^watch:${UUID}$`), async (ctx) => {
    const id = ctx.match![1]!;
    await ctx.answerCallbackQuery();
    const meta = deps.menuCache.getSessionMeta(ctx.chat!.id, id) ?? deps.store.get(id);
    deps.registry.get(ctx.chat!.id).startWatch(deps.store.jsonlPath(id));
    await ctx.reply(`📡 Слежу за сеансом: ${meta?.title ?? "Сеанс Codex"}\nНовые события будут появляться здесь. Чтобы остановить, отправьте /unwatch.`);
  });
}

function connectMessage(result: "resumed" | "forked", meta: SessionMeta): string {
  const projectName = meta.projectName || basename(meta.cwd) || "проект";
  if (result === "resumed") return `✅ Сеанс выбран: ${meta.title}\n📁 ${projectName}\n\nОтправьте сообщение.`;
  return `⚠️ Исходный сеанс занят. Codex создал связанный сеанс с недавним контекстом.\n📁 ${projectName}\n\nОтправьте сообщение.`;
}
