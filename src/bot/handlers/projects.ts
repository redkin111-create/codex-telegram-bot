/**
 * /projects (alias /project) — browse, search, open any folder, or create.
 *   /projects                list/pick projects (freshest first)
 *   /projects <query>        filter projects by name
 *   /projects <path>         open any existing folder (e.g. C:\x, /home/x, ~/x);
 *                            errors if the path doesn't exist (never created)
 *   /projects new <name>     create a folder under the first root + open it;
 *                            errors if it already exists
 * Exposes a reusable project menu used by the menu button and the task wizard.
 */
import { type Context, InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ProjectEntry } from "../../projects/manager.js";
import type { BotDeps } from "../deps.js";
import { homeKeyboard } from "../menu/keyboard.js";
import { compactLabel, INLINE_PAGE_SIZE, pageWindow } from "../menu/paging.js";
import { openMainMenu } from "../menu/main.js";
import { refreshMenu } from "../menu/refresh.js";

const FETCH = 300; // how many projects to load before paging

/** Build the inline keyboard for one page of projects + a Prev/Next nav row. */
export function projectPage(
  list: ProjectEntry[],
  page: number,
  token: string,
  kind: "p" | "w",
  currentPath?: string,
): InlineKeyboard {
  const { page: p, pages, start, end } = pageWindow(list.length, page);
  const kb = new InlineKeyboard();
  list.slice(start, end).forEach((entry, i) => {
    const selected = currentPath && samePath(entry.path, currentPath);
    const label = `${selected ? "\u2705" : "\u25CB"} \u{1F4C1} ${compactLabel(entry.name, 28)}`;
    const callback = kind === "w" ? `wiz:p:${token}:${start + i}` : `p:${token}:${start + i}`;
    kb.text(label, callback).row();
  });
  if (pages > 1) {
    if (p > 0) kb.text("\u25C0", `pp:${kind}:${token}:${p - 1}`);
    kb.text(`${p + 1}/${pages}`, "noop");
    if (p < pages - 1) kb.text("\u25B6", `pp:${kind}:${token}:${p + 1}`);
    kb.row();
  }
  if (kind === "p") kb.text("\u{1F50E} Search", "p:search").text("\u{1F3E0} Menu", "ui:home");
  else kb.text("\u2716 Cancel", "wiz:cancel");
  return kb;
}

/** Send a project picker. `prefix` is the callback-data prefix (e.g. "proj:"). */
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
  const list = sortByRecency(entries ?? deps.projects.list(FETCH), deps);
  const token = deps.menuCache.setProjects(chatId, list);
  const currentPath = deps.registry.get(chatId).cwd;
  if (list.length === 0) {
    const kind = prefix === "wiz:proj:" ? "w" : "p";
    const kb = kind === "w"
      ? new InlineKeyboard().text("\u2716 Cancel", "wiz:cancel")
      : new InlineKeyboard().text("\u{1F50E} Search", "p:search").text("\u{1F3E0} Menu", "ui:home");
    const text = "No matching projects. Try /projects new <name> to create one.";
    if (reuseLatest) await deps.ephemeral.editLatest(chatId, text, { reply_markup: kb });
    else await deps.ephemeral.reply(ctx, text, { reply_markup: kb });
    return;
  }
  const kind = prefix === "wiz:proj:" ? "w" : "p";
  const text = `${title}\n${list.length} project(s)`;
  const extra = { reply_markup: projectPage(list, 0, token, kind, currentPath) };
  if (reuseLatest) await deps.ephemeral.editLatest(chatId, text, extra);
  else await deps.ephemeral.reply(ctx, text, extra);
}

/** Refine project order with Codex session recency: a project's effective
 *  "last used" is the latest of its directory mtime and the newest session
 *  opened in it, so the project you worked in most recently floats to the top. */
function sortByRecency(entries: ProjectEntry[], deps: BotDeps): ProjectEntry[] {
  const recencyByCwd = new Map<string, number>();
  for (const s of deps.store.list(300)) {
    const key = normCwd(s.cwd);
    if (!key) continue;
    const ms = Date.parse(s.updatedAt);
    if (!Number.isFinite(ms)) continue;
    const prev = recencyByCwd.get(key) ?? 0;
    if (ms > prev) recencyByCwd.set(key, ms);
  }
  return entries
    .map((p) => ({ ...p, lastUsed: Math.max(p.lastUsed, recencyByCwd.get(normCwd(p.path)) ?? 0) }))
    .sort((a, b) => b.lastUsed - a.lastUsed || a.name.localeCompare(b.name));
}

/** Normalise a path for cwd ↔ project matching (case/separator/trailing slash). */
function normCwd(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export async function showProjects(ctx: Context, deps: BotDeps, query?: string, reuseLatest = false): Promise<void> {
  const arg = (query ?? "").trim();

  // Create: /projects new <name>
  const create = /^new\s+(.+)$/i.exec(arg);
  if (create) {
    try {
      const entry = deps.projects.create(create[1]!);
      await deps.registry.controller(ctx.chat!.id).addNew(entry.path, entry.name);
      await refreshMenu(ctx, deps, `\u2705 Created and opened ${entry.name}\n${entry.path} \u2014 send a message.`);
    } catch (e) {
      await deps.ephemeral.open(ctx);
      await deps.ephemeral.reply(ctx, `\u274C Could not create project: ${(e as Error).message}`);
    }
    return;
  }

  // Switch to an explicit path: /projects C:\path  ·  /projects /home/x  ·  ~/x
  if (arg && looksLikePath(arg)) {
    await openProjectPath(ctx, deps, arg);
    return;
  }

  // Search: /projects <query>
  if (arg) {
    const found = deps.projects.search(arg, FETCH);
    await sendProjectMenu(ctx, deps, "proj:", `Projects matching "${compactLabel(arg, 70)}":`, found, reuseLatest);
    return;
  }

  await sendProjectMenu(ctx, deps, "proj:", "Choose a project:", undefined, reuseLatest);
}

/** True when the argument looks like a filesystem path rather than a name. */
function looksLikePath(s: string): boolean {
  return /[\\/]/.test(s) || /^[a-zA-Z]:/.test(s) || s.startsWith("~");
}

/** Open a session in an explicit folder (any path, even outside PROJECT_ROOTS).
 *  The folder must already exist — we never create it here. */
async function openProjectPath(ctx: Context, deps: BotDeps, raw: string): Promise<void> {
  const dir = resolvePath(raw);
  if (!deps.projects.isDirectory(dir)) {
    await deps.ephemeral.open(ctx);
    await deps.ephemeral.reply(
      ctx,
      `\u274C Path not found: ${dir}\nI won't create it \u2014 use \`/projects new <name>\` to make a new project.`,
    );
    return;
  }
  await deps.ephemeral.open(ctx);
  const name = basename(dir) || dir;
  try {
    await deps.registry.controller(ctx.chat!.id).addNew(dir, name);
    await refreshMenu(ctx, deps, `\u{1F4C1} Now working in ${name}\n${dir} \u2014 send a message.`);
  } catch (e) {
    await deps.ephemeral.reply(ctx, `\u274C Could not open ${dir}: ${(e as Error).message}`);
  }
}

/** Resolve `~` and normalise a user-supplied path (e.g. `c://lucru` → `C:\lucru`). */
function resolvePath(p: string): string {
  let s = p.trim();
  if (s === "~") s = homedir();
  else if (s.startsWith("~/") || s.startsWith("~\\")) s = join(homedir(), s.slice(2));
  return resolve(s);
}

export function registerProjects(bot: Bot, deps: BotDeps): void {
  bot.command(["projects", "project"], (ctx) => showProjects(ctx, deps, ctx.match?.toString()));

  // Project search is an explicit two-minute text prompt; its message is removed
  // after use so the project picker remains the only navigation surface.
  bot.on("message:text", async (ctx, next) => {
    const text = ctx.message.text.trim();
    const isSearchInput = deps.menuCache.consumeProjectSearch(ctx.chat.id);
    if (!isSearchInput || text.startsWith("/") || ["\u2630 Menu", "\u{1F9ED} Running", "\u23F9 Stop"].includes(text)) {
      await next();
      return;
    }
    await ctx.deleteMessage().catch(() => {});
    await showProjects(ctx, deps, text, true);
  });

  // Page-indicator buttons do nothing but acknowledge the tap.
  bot.callbackQuery("noop", (ctx) => ctx.answerCallbackQuery());

  // Project picker pagination uses a short snapshot token so delayed buttons
  // cannot accidentally select an item from a newer project list.
  bot.callbackQuery(/^pp:(p|w):([a-f0-9]{16}):(\d+)$/, async (ctx) => {
    const token = ctx.match![2]!;
    const list = deps.menuCache.getProjects(ctx.chat!.id, token);
    if (!list) return void ctx.answerCallbackQuery({ text: "This list expired. Open Projects again." });
    await ctx.answerCallbackQuery();
    const kind = ctx.match![1] as "p" | "w";
    const currentPath = deps.registry.get(ctx.chat!.id).cwd;
    const kb = projectPage(list, Number(ctx.match![3]), token, kind, currentPath);
    await ctx.editMessageReplyMarkup({ reply_markup: kb }).catch(() => {});
  });

  bot.callbackQuery(/^p:([a-f0-9]{16}):(\d+)$/, async (ctx) => {
    const token = ctx.match![1]!;
    const index = Number(ctx.match![2]);
    const entry = deps.menuCache.getProject(ctx.chat!.id, index, token);
    if (!entry) {
      await ctx.answerCallbackQuery({ text: "This list expired. Open Projects again.", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    try {
      await deps.registry.controller(ctx.chat!.id).addNew(entry.path, entry.name);
      await openMainMenu(ctx, deps);
    } catch (err) {
      await deps.ephemeral.reply(ctx, `\u274C Could not open ${compactLabel(entry.name, 32)}: ${(err as Error).message}`, { reply_markup: homeKeyboard() });
    }
  });

  bot.callbackQuery("p:search", async (ctx) => {
    deps.menuCache.beginProjectSearch(ctx.chat!.id);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("\u{1F50E} Send a project name to search. This prompt expires in 2 minutes.", {
      reply_markup: new InlineKeyboard().text("Cancel", "p:search:cancel").text("\u{1F3E0} Menu", "ui:home"),
    }).catch(() => {});
  });

  bot.callbackQuery("p:search:cancel", async (ctx) => {
    deps.menuCache.clearProjectSearch(ctx.chat!.id);
    await ctx.answerCallbackQuery();
    await showProjects(ctx, deps);
  });
}

function samePath(a: string, b: string): boolean {
  return a.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase() === b.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
}
