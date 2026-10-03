/** Safe project discovery and project-to-session navigation. */
import { type Context, InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import { basename } from "node:path";
import { recentProjects, sameProjectPath, type ProjectEntry } from "../../projects/manager.js";
import type { BotDeps } from "../deps.js";
import { compactLabel, pageWindow } from "../menu/paging.js";
import { showSessions } from "./sessions.js";

const FETCH = 500;

export function projectPage(
  list: ProjectEntry[], page: number, token: string, kind: "p" | "w", currentPath?: string,
): InlineKeyboard {
  const { page: p, pages, start, end } = pageWindow(list.length, page);
  const kb = new InlineKeyboard();
  list.slice(start, end).forEach((entry, i) => {
    const selected = currentPath && sameProjectPath(entry.path, currentPath);
    const callback = kind === "w" ? `wiz:p:${token}:${start + i}` : `p:${token}:${start + i}`;
    kb.text(`${selected ? "✅" : "○"} 📁 ${compactLabel(entry.name, 28)}`, callback).row();
  });
  if (pages > 1) {
    if (p > 0) kb.text("◀", `pp:${kind}:${token}:${p - 1}`);
    kb.text(`${p + 1}/${pages}`, "noop");
    if (p < pages - 1) kb.text("▶", `pp:${kind}:${token}:${p + 1}`);
    kb.row();
  }
  if (kind === "p") {
    kb.text("🕘 Недавние", "p:recent").text("📁 Все проекты", "p:all").row()
      .text("🔎 Поиск", "p:search").text("⬅ Проекты", "p:menu").row()
      .text("🏠 Меню", "ui:home");
  } else {
    kb.text("✖ Отмена", "wiz:cancel");
  }
  return kb;
}

/** Shared picker for the scheduled-task wizard; it contains only recent or allowed projects. */
export async function sendProjectMenu(
  ctx: Context,
  deps: BotDeps,
  prefix: string,
  title: string,
  entries?: ProjectEntry[],
  reuseLatest = false,
): Promise<void> {
  const chatId = ctx.chat!.id;
  if (!reuseLatest) await deps.ephemeral.open(ctx);
  const list = dedupeProjects(entries ?? discoverProjects(deps));
  const token = deps.menuCache.setProjects(chatId, list);
  const kind = prefix === "wiz:proj:" ? "w" : "p";
  const keyboard = list.length
    ? projectPage(list, 0, token, kind, deps.registry.get(chatId).cwd)
    : new InlineKeyboard().text(kind === "w" ? "✖ Отмена" : "⬅ Проекты", kind === "w" ? "wiz:cancel" : "p:menu");
  const text = list.length ? `${title}\nПроектов: ${list.length}` : `${title}\nПодходящих проектов пока нет.`;
  if (reuseLatest) await deps.ephemeral.editLatest(chatId, text, { reply_markup: keyboard });
  else await deps.ephemeral.reply(ctx, text, { reply_markup: keyboard });
}

export async function showProjects(ctx: Context, deps: BotDeps, query?: string, reuseLatest = false): Promise<void> {
  const arg = (query ?? "").trim();
  if (!arg) {
    await deps.ephemeral.open(ctx);
    const kb = new InlineKeyboard()
      .text("🕘 Недавние проекты Codex", "p:recent").row()
      .text("📁 Все разрешённые проекты", "p:all").row()
      .text("🔎 Поиск", "p:search").row()
      .text("🏠 Главное меню", "ui:home");
    await deps.ephemeral.reply(ctx, "📁 Проекты\nВыберите источник проектов:", { reply_markup: kb });
    return;
  }

  const create = /^new\s+(.+)$/i.exec(arg);
  if (create) {
    try {
      const entry = deps.projects.create(create[1]!);
      await selectProject(ctx, deps, entry);
    } catch {
      await deps.ephemeral.open(ctx);
      await deps.ephemeral.reply(ctx, "❌ Не удалось создать проект. Проверьте PROJECT_ROOTS и название папки.");
    }
    return;
  }

  if (looksLikePath(arg)) {
    const entries = recentProjects(deps.store.list(FETCH), FETCH);
    const allowed = deps.projects.resolveAllowedPath(arg, entries.map((entry) => entry.path));
    if (!allowed) {
      await deps.ephemeral.open(ctx);
      await deps.ephemeral.reply(ctx, "⛔ Этот путь не разрешён. Выбирайте недавний проект Codex или папку из PROJECT_ROOTS.");
      return;
    }
    await selectProject(ctx, deps, { path: allowed, name: basename(allowed) || allowed, lastUsed: Date.now() });
    return;
  }

  const q = arg.toLocaleLowerCase();
  const found = dedupeProjects(discoverProjects(deps))
    .filter((entry) => entry.name.toLocaleLowerCase().includes(q) || entry.path.toLocaleLowerCase().includes(q));
  await sendProjectMenu(ctx, deps, "proj:", `Проекты по запросу «${compactLabel(arg, 70)}»:`, found, reuseLatest);
}

export function registerProjects(bot: Bot, deps: BotDeps): void {
  bot.command(["projects", "project"], (ctx) => showProjects(ctx, deps, ctx.match?.toString()));

  bot.on("message:text", async (ctx, next) => {
    const text = ctx.message.text.trim();
    const isSearchInput = deps.menuCache.consumeProjectSearch(ctx.chat.id);
    if (!isSearchInput || text.startsWith("/") || ["☰ Меню", "🧭 Активные", "⏹ Стоп"].includes(text)) return next();
    await ctx.deleteMessage().catch(() => {});
    await showProjects(ctx, deps, text, true);
  });

  bot.callbackQuery("noop", (ctx) => ctx.answerCallbackQuery());
  bot.callbackQuery("p:menu", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showProjects(ctx, deps);
  });
  bot.callbackQuery("p:recent", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendProjectMenu(ctx, deps, "proj:", "🕘 Недавние проекты Codex", recentProjects(deps.store.list(FETCH), FETCH));
  });
  bot.callbackQuery("p:all", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!deps.projects.hasRoots) {
      await deps.ephemeral.open(ctx);
      await deps.ephemeral.reply(ctx, "Список всех проектов отключён: задайте явный PROJECT_ROOTS. Недавние проекты Codex доступны отдельно.", {
        reply_markup: new InlineKeyboard().text("🕘 Недавние проекты", "p:recent").row().text("⬅ Проекты", "p:menu"),
      });
      return;
    }
    await sendProjectMenu(ctx, deps, "proj:", "📁 Все проекты из PROJECT_ROOTS", deps.projects.list(FETCH));
  });

  bot.callbackQuery(/^pp:(p|w):([a-f0-9]{16}):(\d+)$/, async (ctx) => {
    const token = ctx.match![2]!;
    const list = deps.menuCache.getProjects(ctx.chat!.id, token);
    if (!list) return void ctx.answerCallbackQuery({ text: "Срок действия списка истёк. Откройте проекты ещё раз." });
    await ctx.answerCallbackQuery();
    const kind = ctx.match![1] as "p" | "w";
    const keyboard = projectPage(list, Number(ctx.match![3]), token, kind, deps.registry.get(ctx.chat!.id).cwd);
    await ctx.editMessageReplyMarkup({ reply_markup: keyboard }).catch(() => {});
  });

  bot.callbackQuery(/^p:([a-f0-9]{16}):(\d+)$/, async (ctx) => {
    const entry = deps.menuCache.getProject(ctx.chat!.id, Number(ctx.match![2]), ctx.match![1]);
    if (!entry) return void ctx.answerCallbackQuery({ text: "Срок действия списка истёк. Откройте проекты ещё раз.", show_alert: true });
    await ctx.answerCallbackQuery();
    await selectProject(ctx, deps, entry);
  });

  bot.callbackQuery("p:search", async (ctx) => {
    deps.menuCache.beginProjectSearch(ctx.chat!.id);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("🔎 Отправьте название проекта для поиска. Поиск охватывает историю Codex и PROJECT_ROOTS; запрос действует 2 минуты.", {
      reply_markup: new InlineKeyboard().text("Отмена", "p:search:cancel").text("🏠 Меню", "ui:home"),
    }).catch(() => {});
  });
  bot.callbackQuery("p:search:cancel", async (ctx) => {
    deps.menuCache.clearProjectSearch(ctx.chat!.id);
    await ctx.answerCallbackQuery();
    await showProjects(ctx, deps);
  });
}

export async function selectProject(ctx: Context, deps: BotDeps, project: ProjectEntry): Promise<void> {
  deps.menuCache.setSelectedProject(ctx.chat!.id, project);
  await showSessions(ctx, deps, undefined, project);
}

function discoverProjects(deps: BotDeps): ProjectEntry[] {
  return [
    ...recentProjects(deps.store.list(FETCH), FETCH),
    ...deps.projects.list(FETCH),
  ];
}

function dedupeProjects(entries: ProjectEntry[]): ProjectEntry[] {
  const projects: ProjectEntry[] = [];
  for (const entry of entries) {
    const index = projects.findIndex((old) => sameProjectPath(old.path, entry.path));
    if (index === -1) projects.push(entry);
    else if (entry.lastUsed > projects[index]!.lastUsed) projects[index] = entry;
  }
  return projects.sort((a, b) => b.lastUsed - a.lastUsed || a.name.localeCompare(b.name));
}

function looksLikePath(value: string): boolean {
  return /[\\/]/.test(value) || /^[a-z]:/i.test(value) || value.startsWith("~");
}
