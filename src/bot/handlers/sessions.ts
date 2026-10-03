/**
 * /sessions — list recent Codex sessions and connect to one.
 * /active   — list sessions currently running on this PC.
 * /unwatch  — stop following a live session.
 *
 * Each session is shown as its own card (status, project + path, times, history
 * size, context %), with Connect (resume, or fork if the session is locked/live),
 * 📜 History (static view), and 📡 Watch (live read-only follow) buttons.
 */
import { type Bot, type Context, InlineKeyboard } from "grammy";
import { basename } from "node:path";
import type { BotDeps } from "../deps.js";
import { readHistory } from "../../sessions/history.js";
import type { SessionMeta } from "../../sessions/types.js";
import { homeKeyboard } from "../menu/keyboard.js";
import { compactLabel, INLINE_PAGE_SIZE, pageWindow } from "../menu/paging.js";
import { openMainMenu } from "../menu/main.js";
import { refreshMenu } from "../menu/refresh.js";
import { showHistory } from "./history.js";
import { buildSessionCard, relTime } from "./session-card.js";

/** Compact picker: one editable message, six sessions per page. */
const PAGE_SIZE = INLINE_PAGE_SIZE;
const UUID = "([0-9a-fA-F-]{36})";

export async function showSessions(ctx: Context, deps: BotDeps, query?: string): Promise<void> {
  const q = (query ?? "").trim().toLowerCase();
  let metas = deps.store.list(q ? 400 : 200);
  if (q) {
    metas = metas.filter((m) => `${m.title} ${m.cwd} ${m.sessionId}`.toLowerCase().includes(q));
  }
  if (metas.length === 0) {
    await deps.ephemeral.open(ctx);
    const kb = new InlineKeyboard().text("\u{1F195} New session", "s:new").row().text("\u{1F3E0} Main menu", "ui:home");
    await deps.ephemeral.reply(ctx, q ? `No sessions match "${compactLabel(q, 80)}".` : "No saved Codex sessions found.", { reply_markup: kb });
    return;
  }
  deps.menuCache.setSessions(ctx.chat!.id, metas, q ? `Sessions matching "${q}"` : "Recent sessions");
  await renderSessionPage(ctx, deps, 0);
}

/** Render one page of session cards: header + up to PAGE_SIZE cards + nav footer. */
async function renderSessionPage(ctx: Context, deps: BotDeps, page: number): Promise<void> {
  await deps.ephemeral.open(ctx);
  const cached = deps.menuCache.getSessions(ctx.chat!.id);
  if (!cached) return;
  const currentId = deps.registry.get(ctx.chat!.id).sessionId;
  const { text, keyboard } = sessionPage(cached.metas, cached.heading, page, cached.token, currentId);
  await deps.ephemeral.reply(ctx, text, { reply_markup: keyboard });
}

export function sessionPage(
  metas: SessionMeta[],
  heading: string,
  requestedPage: number,
  token: string,
  currentId?: string,
): { text: string; keyboard: InlineKeyboard } {
  const { page: p, pages, start, end } = pageWindow(metas.length, requestedPage, PAGE_SIZE);
  const kb = new InlineKeyboard();
  for (let i = start; i < end; i++) {
    const m = metas[i]!;
    const marker = m.sessionId === currentId ? "\u2705" : "\u25CB";
    const project = m.cwd ? basename(m.cwd) : "project unknown";
    kb.text(`${marker} ${compactLabel(m.title, 30)} \u00B7 ${compactLabel(project, 16)}`, `s:${token}:${i}`).row();
  }
  if (pages > 1) {
    if (p > 0) kb.text("\u25C0", `sp:${token}:${p - 1}`);
    kb.text(`${p + 1}/${pages}`, "noop");
    if (p < pages - 1) kb.text("\u25B6", `sp:${token}:${p + 1}`);
    kb.row();
  }
  kb.text("\u{1F195} New session", "s:new").row().text("\u{1F3E0} Main menu", "ui:home");
  const lines = [`\u{1F4AC} ${compactLabel(heading, 56)} \u00B7 ${metas.length}`, ""];
  for (const m of metas.slice(start, end)) {
    const marker = m.sessionId === currentId ? "\u2705" : "\u25CB";
    const project = m.cwd ? basename(m.cwd) : "project unknown";
    lines.push(`${marker} ${compactLabel(m.title, 34)} \u00B7 ${compactLabel(project, 18)} \u00B7 ${relTime(m.updatedAt)}`);
  }
  return { text: lines.join("\n"), keyboard: kb };
}

/** Detail card shown after choosing a session; opening it remains an explicit action. */
export function selectionCard(meta: SessionMeta, token: string, index: number, selfPid?: number) {
  const card = buildSessionCard(meta, { openLabel: "\u{1F517} Open", selfPid });
  card.keyboard.row()
    .text("\u2B05 Back to Sessions", `sp:${token}:${Math.floor(index / PAGE_SIZE)}`)
    .text("\u{1F3E0} Main Menu", "ui:home");
  return card;
}

export function registerSessions(bot: Bot, deps: BotDeps): void {
  bot.command("sessions", (ctx) => showSessions(ctx, deps, ctx.match?.toString()));

  bot.command("active", async (ctx) => {
    const metas = deps.store.listActive();
    if (metas.length === 0) {
      await deps.ephemeral.open(ctx);
      await deps.ephemeral.reply(ctx, "No sessions are currently running on this PC.");
      return;
    }
    deps.menuCache.setSessions(ctx.chat!.id, metas, "Live sessions running now");
    await renderSessionPage(ctx, deps, 0);
  });

  bot.callbackQuery(/^sp:([a-f0-9]{16}):(\d+)$/, async (ctx) => {
    const cached = deps.menuCache.getSessions(ctx.chat!.id, ctx.match![1]);
    if (!cached) return void ctx.answerCallbackQuery({ text: "This list expired. Open Sessions again." });
    await ctx.answerCallbackQuery();
    await renderSessionPage(ctx, deps, Number(ctx.match![2]));
  });

  bot.callbackQuery(/^s:([a-f0-9]{16}):(\d+)$/, async (ctx) => {
    const token = ctx.match![1]!;
    const index = Number(ctx.match![2]);
    const meta = deps.menuCache.getSession(ctx.chat!.id, token, index);
    if (!meta || !deps.store.get(meta.sessionId)) {
      await ctx.answerCallbackQuery({ text: "This session is no longer available. Refresh Sessions.", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Session details" });
    const card = selectionCard(meta, token, index, deps.acp.pid);
    await deps.ephemeral.reply(ctx, card.text, { reply_markup: card.keyboard });
  });

  bot.callbackQuery("s:new", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Starting a new session\u2026" });
    const rt = deps.registry.get(ctx.chat!.id);
    try {
      await deps.registry.controller(ctx.chat!.id).addNew(rt.cwd, rt.projectName);
      await openMainMenu(ctx, deps);
    } catch (err) {
      await deps.ephemeral.reply(ctx, `\u274C Could not start session: ${(err as Error).message}`, { reply_markup: homeKeyboard() });
    }
  });

  bot.command("unwatch", async (ctx) => {
    const rt = deps.registry.get(ctx.chat.id);
    await ctx.reply(rt.stopWatch() ? "\u{1F6D1} Stopped watching." : "Not watching anything.");
  });

  bot.callbackQuery(new RegExp(`^sess:${UUID}$`), async (ctx) => {
    const id = ctx.match![1]!;
    const meta = deps.store.get(id);
    if (!meta) {
      await ctx.answerCallbackQuery({ text: "Session not found." });
      return;
    }
    await ctx.answerCallbackQuery();
    await deps.ephemeral.clear(ctx.chat!.id); // remove the session cards
    const fgCwd = deps.registry.get(ctx.chat!.id).cwd;
    const cwd = meta.cwd || fgCwd;
    const projectName = basename(meta.cwd || fgCwd) || "session";
    const prior = readHistory(deps.store.jsonlPath(id), 24);
    try {
      const { result, alreadyControlled } = await deps.registry
        .controller(ctx.chat!.id)
        .addAttach(id, cwd, projectName, prior);
      await ctx.reply(alreadyControlled ? `\u{1F500} Switched to ${meta.title}` : connectMessage(result, meta));
      await refreshMenu(ctx, deps, `\u{1F4C2} ${meta.title}`);
      await showHistory(deps, ctx.chat!.id, id, meta);
    } catch (err) {
      await ctx.reply(`\u274C Could not connect: ${(err as Error).message}`);
    }
  });

  bot.callbackQuery(new RegExp(`^hist:${UUID}$`), async (ctx) => {
    const id = ctx.match![1]!;
    await ctx.answerCallbackQuery();
    const meta = deps.store.get(id);
    await showHistory(deps, ctx.chat!.id, id, meta);
  });

  bot.callbackQuery(new RegExp(`^watch:${UUID}$`), async (ctx) => {
    const id = ctx.match![1]!;
    await ctx.answerCallbackQuery();
    const meta = deps.store.get(id);
    const rt = deps.registry.get(ctx.chat!.id);
    rt.startWatch(deps.store.jsonlPath(id));
    await ctx.reply(
      `\u{1F4E1} Watching live: ${meta?.title ?? id.slice(0, 8)}\nNew activity streams here. Send /unwatch to stop.`,
    );
  });
}

function connectMessage(result: "resumed" | "forked", meta: SessionMeta): string {
  if (result === "resumed") {
    return `\u2705 Resumed: ${meta.title}\n${meta.cwd}\n\nSend a message to continue.`;
  }
  return [
    `\u26A0\uFE0F ${meta.title} is live on your PC right now, so Codex keeps it locked.`,
    `I opened a linked continuation here in the same project with its recent context.`,
    `${meta.cwd}`,
    ``,
    `Send a message to keep going \u2014 or tap \u{1F4E1} to watch the original live.`,
  ].join("\n");
}
