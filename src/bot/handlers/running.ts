/**
 * /running — the sessions this chat controls. Tap one to switch to it; on
 * switch you see a header + the target's unread messages (what happened while
 * you were away) or its recent history the first time.
 */
import { type Bot, type Context, InlineKeyboard } from "grammy";
import type { RunningSession, SwitchResult } from "../chat-controller.js";
import type { BotDeps } from "../deps.js";
import type { HistoryEntry } from "../../sessions/types.js";
import { conversationEntries, jsonlMtimeMs, readFirstPrompt } from "../../sessions/history.js";
import { progressBar } from "../../render/progress.js";
import { sameProjectPath } from "../../projects/manager.js";
import { loadCodexProjects, safeSessionTitle } from "../catalog.js";
import { cleanSessionPrompt } from "../../sessions/title.js";
import { refreshMenu } from "../menu/refresh.js";
import { sendMarkdownDoc } from "../telegram-io.js";

const UUID = "([0-9a-fA-F-]{36})";
const ROLE_ICON: Record<string, string> = {
  user: "\u{1F464}",
  assistant: "\u{1F916}",
};
const ENTRY_MAX = 700;
/** Max session cards to send for one /running (avoids flooding the chat). */
const CARD_LIMIT = 12;
export const RUNNING_COMMANDS = ["running", "active"] as const;

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
}

/** Compact "time ago" label from an elapsed-milliseconds value. */
function timeAgo(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 45) return "только что";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин. назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч. назад`;
  return `${Math.round(h / 24)} дн. назад`;
}

/** Reduce a stored first prompt to a clean one-liner: drop the leading reasoning
 *  directive and any fork-priming preamble, then collapse whitespace. */
export function cleanPrompt(raw: string): string {
  return safeSessionTitle(cleanSessionPrompt(raw)) ?? "";
}

/** A useful session label even before Codex has saved a title or first prompt. */
export function runningSessionTitle(projectName: string, prompt: string, storedTitle = "", codexTitle = ""): string {
  const title = safeSessionTitle(codexTitle) || cleanPrompt(prompt) || cleanPrompt(storedTitle);
  return title ? `“${trunc(title, 120)}”` : `Сеанс · ${projectName}`;
}

/** Build a rich card (plain text, no MarkdownV2) + buttons for one controlled
 *  session: Switch / History / Close. */
function buildRunningCard(s: RunningSession, deps: BotDeps, now: number): { text: string; kb: InlineKeyboard } {
  const dot = s.foreground ? "\u25B6\uFE0F" : s.busy ? "\u{1F7E0}" : "\u26AA";
  const state = s.foreground ? "текущий" : s.busy ? "выполняется" : "ожидание";

  let when = "новый";
  let prompt = "";
  let storedTitle = "";
  if (s.sessionId) {
    const path = deps.store.jsonlPath(s.sessionId);
    const mtime = jsonlMtimeMs(path);
    if (mtime) when = timeAgo(now - mtime);
    prompt = cleanPrompt(readFirstPrompt(path));
    storedTitle = deps.store.get(s.sessionId)?.title ?? "";
  }

  const meta = [when, state];
  if (s.busy) meta.push("\u23F3");
  if (s.unread > 0) meta.push(`${s.unread} \u{1F4EC} непрочитано`);
  if (s.queueLength > 0) meta.push(`📥 очередь ${s.queueLength}${s.queuePaused ? " · пауза" : ""}`);

  const lines = [
    `${dot} ${s.projectName}`,
    `\u{1F4AC} ${runningSessionTitle(s.projectName, prompt, storedTitle, s.sessionTitle)}`,
    `\u{1F552} ${meta.join(" \u00B7 ")}`,
  ];
  if (s.progress !== undefined) lines.push(`\u{1F4C8} ${progressBar(s.progress)}`);
  const kb = new InlineKeyboard();
  if (!s.sessionId) {
    kb.text("\u23F3 Запускается…", "run:noop");
    return { text: lines.join("\n"), kb };
  }
  if (s.foreground) kb.text("\u25B6\uFE0F Текущий", "run:noop");
  else kb.text("\u{1F500} Переключиться", `run:switch:${s.sessionId}`);
  kb.text("\u{1F4DC} История", `hist:${s.sessionId}`).text("\u2716 Закрыть", `run:close:${s.sessionId}`);
  if (s.queueLength > 0) kb.row().text(`📥 Очередь · ${s.queueLength}`, `q:view:${s.sessionId}`);
  return { text: lines.join("\n"), kb };
}

export async function showRunning(ctx: Context, deps: BotDeps): Promise<void> {
  await deps.ephemeral.open(ctx);
  const [projects, threads] = await Promise.all([
    loadCodexProjects(deps.acp),
    deps.acp.listThreads({
      limit: 500,
      sortKey: "recency_at",
      sortDirection: "desc",
      sourceKinds: ["cli", "vscode", "appServer"],
    }).catch(() => []),
  ]);
  const titles = new Map(threads.flatMap((thread) => {
    const title = safeSessionTitle(thread.name, thread.preview);
    return title ? [[thread.id, title] as const] : [];
  }));
  const list = dedupeBySession(deps.registry.controller(ctx.chat!.id).list()).map((session) => {
    const project = projects.find((item) => (item.roots ?? [item.path]).some((root) => sameProjectPath(root, session.cwd)));
    return {
      ...session,
      ...(project ? { projectName: project.name } : {}),
      sessionTitle: session.sessionId ? titles.get(session.sessionId) : undefined,
    };
  });
  if (list.length === 0) {
    await deps.ephemeral.reply(ctx, "Пока нет сеансов для управления. Выберите проект или отправьте /new, чтобы начать.");
    return;
  }
  const now = Date.now();
  const shown = list.slice(0, CARD_LIMIT);
  await deps.ephemeral.reply(ctx, `\u{1F9ED} Сеансы этого чата (${list.length}). Нажмите «Переключиться» на нужной карточке:`);
  for (const s of shown) {
    const { text, kb } = buildRunningCard(s, deps, now);
    await deps.ephemeral.reply(ctx, text, { reply_markup: kb });
  }
  if (list.length > shown.length) {
    await deps.ephemeral.reply(ctx, `…и ещё ${list.length - shown.length}.`);
  }
}

/** Collapse any cards that share a session id (defensive — the controller
 *  already prunes duplicate runtimes, but never show the same session twice). */
function dedupeBySession(list: RunningSession[]): RunningSession[] {
  const seen = new Set<string>();
  return list.filter((s) => {
    if (!s.sessionId) return true;
    if (seen.has(s.sessionId)) return false;
    seen.add(s.sessionId);
    return true;
  });
}

/** Switch the chat to a session and show its summary + unread. */
export async function switchAndShow(ctx: Context, deps: BotDeps, sessionId: string): Promise<void> {
  const res = await deps.registry.controller(ctx.chat!.id).switchTo(sessionId);
  if (!res) {
    await ctx.reply("Сеанс не найден — возможно, он уже закрыт.");
    return;
  }
  await deliverSwitch(ctx, deps, res);
}

export function registerRunning(bot: Bot, deps: BotDeps): void {
  bot.command([...RUNNING_COMMANDS], (ctx) => showRunning(ctx, deps));

  bot.callbackQuery("run:noop", (ctx) => ctx.answerCallbackQuery({ text: "Это уже текущий сеанс" }));

  bot.callbackQuery(new RegExp(`^run:switch:${UUID}$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    await deps.ephemeral.clear(ctx.chat!.id); // remove the /running cards; 🔀 Switched stays
    await switchAndShow(ctx, deps, ctx.match![1]!);
  });

  bot.callbackQuery(new RegExp(`^run:close:${UUID}$`), async (ctx) => {
    const id = ctx.match![1]!;
    const closed = await deps.registry.controller(ctx.chat!.id).close(id);
    if (!closed) {
      await ctx.answerCallbackQuery({
        text: "Нельзя закрыть выполняющийся сеанс или сеанс с очередью.",
        show_alert: true,
      });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Сеанс закрыт" });
    await ctx.deleteMessage().catch(() => {}); // remove just this card
  });
}

async function deliverSwitch(ctx: Context, deps: BotDeps, res: SwitchResult): Promise<void> {
  const proj = res.projectName ?? "сеанс";
  if (res.alreadyForeground) {
    await ctx.reply(`Уже открыт проект «${proj}».`);
    return;
  }
  const working = res.busy ? " \u00B7 \u23F3 задача ещё выполняется, обновления будут приходить сюда" : "";
  await refreshMenu(ctx, deps, `\u{1F500} Переключено на «${proj}»${working}`);

  const entries = conversationEntries(res.unread);
  if (entries.length === 0) {
    if (!res.busy) await ctx.reply(res.firstView ? "Предыдущих сообщений здесь нет." : "\u2705 Пока вас не было, новых сообщений не появилось.");
    return;
  }
  const header = res.firstView
    ? `\u{1F4DC} **Недавняя история** \u2014 ${proj}`
    : `\u{1F4EC} **Сообщения, появившиеся в ваше отсутствие: ${entries.length}** \u2014 ${proj}`;
  const body = entries.map(fmtEntry).join("\n\n");
  await sendMarkdownDoc(deps.api, ctx.chat!.id, `${header}\n\n${body}`);

  // Replay how the session's last turn ended (Done + file summary) — this isn't
  // in the .jsonl, so it's the footer you'd have seen had you been watching.
  if (!res.busy && res.rt.lastTurnSummary) {
    await ctx.reply(res.rt.lastTurnSummary);
  }
}

function fmtEntry(e: HistoryEntry): string {
  const icon = ROLE_ICON[e.role] ?? "\u2022";
  const text = e.text.length > ENTRY_MAX ? e.text.slice(0, ENTRY_MAX) + " \u2026" : e.text;
  return `${icon} ${text}`;
}
