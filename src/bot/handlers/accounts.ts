/**
 * /accounts — manage several Codex logins and switch between them.
 *
 * Codex keeps a single active login on disk (`$CODEX_HOME/auth.json`), so this
 * menu lets you snapshot the current login as a named account, import an
 * existing login, and swap the active identity in one tap (which copies the
 * saved auth.json back and restarts the Codex agent so sessions re-bind under
 * the new account).
 *
 * All logins are process-global (one machine, one active auth.json), so the
 * list is shared across chats. Switching is serialised with the shared agent and
 * refused while a prompt is in flight.
 */
import { type Bot, type Context, InlineKeyboard } from "grammy";
import { AuthService } from "../../app/auth-service.js";
import type { StoredAccount } from "../../app/accounts.js";
import { UNSUPPORTED_LOGIN_HELP } from "../../app/codex-credentials.js";
import { createLogger } from "../../logger.js";
import type { BotDeps } from "../deps.js";
import { briefErrorMessage } from "../prompt-retry.js";

const log = createLogger("accounts");

function accountLine(a: StoredAccount, active: boolean): string {
  const mark = active ? "\u2705 " : "\u{1F464} ";
  const type = a.accountType ? ` \u00B7 ${a.accountType}` : "";
  const region = a.region ? ` \u00B7 ${a.region}` : "";
  return `${mark}${a.label}${type}${region}`;
}

/** Build the accounts surface (text + inline keyboard). */
async function view(deps: BotDeps, note?: string): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const list = deps.accounts.list();
  // The currently active login (may not be saved yet) + whether the CLI accepts it.
  const acct = await deps.usage.account().catch(() => undefined);
  const activeKey = acct?.email || acct?.key; // match key (email or api-key fingerprint)
  const activeLabel = acct?.email || acct?.accountType; // human-friendly (masked for api keys)
  const active = activeKey ? list.find((a) => (a.email || a.key) === activeKey)?.id : undefined;
  const loggedIn = await deps.usage.isLoggedIn().catch(() => false);

  const lines = ["\u{1F465} Аккаунты Codex", ""];
  // Always surface who you're signed in as — including an unsaved login.
  if (activeLabel && !active) {
    lines.push(`\u{1F7E2} Выполнен вход: ${activeLabel}${loggedIn ? "" : " (в Codex вход не выполнен)"}`);
    if (loggedIn) lines.push("  \u2514 Аккаунт ещё не сохранён. Нажмите «\u{1F4BE} Сохранить текущий аккаунт».");
    lines.push("");
  }
  if (list.length === 0) {
    lines.push("Сохранённых аккаунтов пока нет.", "", "Сохраните текущий аккаунт или добавьте его командой /reauth.");
  } else {
    for (const a of list) lines.push(accountLine(a, a.id === active));
  }
  const rotate = deps.accounts.autoRotateEnabled();
  lines.push(
    "",
    `\u{1F501} Переключать аккаунт при ошибках: ${rotate ? "ВКЛ" : "ВЫКЛ"}`,
    rotate
      ? "  \u2514 Если задача завершится с ошибкой, бот один раз попробует другие аккаунты."
      : "  \u2514 Задачи продолжат выполняться с текущего аккаунта.",
  );
  if (note) lines.push("", note);

  const kb = new InlineKeyboard();
  for (const a of list) {
    const sw = a.id === active ? `\u2705 ${trim(a.label)} (текущий)` : `\u{1F504} ${trim(a.label)}`;
    kb.text(sw, a.id === active ? "acct:noop" : `acct:switch:${a.id}`)
      .text("\u270F\uFE0F", `acct:rename:${a.id}`)
      .text("\u{1F5D1}", `acct:del:${a.id}`)
      .row();
  }
  kb.text("\u{1F4BE} Сохранить текущий аккаунт", "acct:save").text("\u270F\uFE0F Сохранить как…", "acct:saveas").row();
  kb.text("\u{1F4E5} Импортировать", "acct:import").text("\u{1F511} Войти…", "acct:login").row();
  kb.text(`\u{1F501} Автопереключение: ${deps.accounts.autoRotateEnabled() ? "ВКЛ" : "ВЫКЛ"}`, "acct:rotate").row();
  kb.text("\u2716 Закрыть", "acct:close");
  return { text: lines.join("\n"), keyboard: kb };
}

function trim(s: string, n = 22): string {
  return s.length > n ? `${s.slice(0, n - 1)}\u2026` : s;
}

export async function showAccounts(ctx: Context, deps: BotDeps): Promise<void> {
  const { text, keyboard } = await view(deps);
  await deps.ephemeral.open(ctx);
  await deps.ephemeral.reply(ctx, text, { reply_markup: keyboard });
}

/** Re-render the surface in place after an action. */
async function rerender(ctx: Context, deps: BotDeps, note?: string): Promise<void> {
  const { text, keyboard } = await view(deps, note);
  await ctx.editMessageText(text, { reply_markup: keyboard }).catch(() => {});
}

/** Guard: switching/importing touches the shared agent + global credentials. */
function busyReason(deps: BotDeps): string | undefined {
  if (deps.acp.hasInflightPrompt()) return "\u23F3 Codex занят. Повторите, когда задача завершится, или сначала отправьте /cancel.";
  return undefined;
}

export function registerAccounts(bot: Bot, deps: BotDeps): void {
  const auth = new AuthService(deps.cfg.codexCliPath);
  /** Chats awaiting a typed account name: "save" a new one or "rename" an id. */
  const pending = new Map<number, { mode: "save" | "rename"; id?: string; promptId?: number }>();

  const promptName = async (ctx: Context, mode: "save" | "rename", id?: string): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const ask =
      mode === "save"
        ? "\u270F\uFE0F Отправьте название для текущего аккаунта, например «Работа» или «Личный»."
        : "\u270F\uFE0F Отправьте новое название аккаунта.";
    const msgId = await deps.ephemeral.reply(ctx, ask);
    pending.set(chatId, { mode, id, promptId: msgId });
  };

  // Capture the typed name. Registered before the prompt catch-all, so a name
  // reply feeds this flow instead of becoming a Codex prompt.
  bot.on("message:text", async (ctx, next) => {
    const chatId = ctx.chat.id;
    const p = pending.get(chatId);
    if (!p) return next();
    const text = ctx.message.text;
    if (text.startsWith("/")) return next(); // a command cancels the naming
    pending.delete(chatId);
    await ctx.deleteMessage().catch(() => {}); // drop the typed name from history
    const name = text.trim().slice(0, 60);
    let note: string;
    try {
      if (p.mode === "rename" && p.id) {
        const meta = deps.accounts.rename(p.id, name);
        note = meta ? `\u270F\uFE0F Новое название: ${meta.label}` : "Этот аккаунт уже не сохранён.";
      } else if (!(await deps.usage.isLoggedIn())) {
        note = `\u274C ${UNSUPPORTED_LOGIN_HELP}`;
      } else {
        const acct = await deps.usage.account().catch(() => undefined);
        const saved = await deps.accounts.captureCurrent(acct, name);
        note = `\u{1F4BE} Сохранено: ${saved.label}`;
      }
    } catch (e) {
      note = `\u274C ${briefErrorMessage(e as Error)}`;
    }
    await deps.ephemeral.open(ctx);
    const { text: t, keyboard } = await view(deps, note);
    await deps.ephemeral.reply(ctx, t, { reply_markup: keyboard });
  });

  bot.command("accounts", (ctx) => showAccounts(ctx, deps));

  bot.callbackQuery("acct:noop", (ctx) => ctx.answerCallbackQuery({ text: "Этот аккаунт уже выбран" }));

  bot.callbackQuery("acct:saveas", async (ctx) => {
    await ctx.answerCallbackQuery();
    await promptName(ctx, "save");
  });

  bot.callbackQuery("acct:rotate", async (ctx) => {
    const on = deps.accounts.setAutoRotate();
    await ctx.answerCallbackQuery({ text: `Автопереключение ${on ? "включено" : "выключено"}` });
    await rerender(ctx, deps, on ? "\u{1F501} Автопереключение включено." : "\u{1F501} Автопереключение выключено.");
  });

  bot.callbackQuery(/^acct:rename:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await promptName(ctx, "rename", ctx.match![1]!);
  });

  bot.callbackQuery("acct:close", async (ctx) => {
    await ctx.answerCallbackQuery();
    await deps.ephemeral.drop(ctx);
  });

  bot.callbackQuery("acct:save", async (ctx) => {
    if (!(await deps.usage.isLoggedIn())) {
      await ctx.answerCallbackQuery({ text: "В Codex не выполнен вход", show_alert: true });
      return void rerender(ctx, deps, `\u274C ${UNSUPPORTED_LOGIN_HELP}`);
    }
    try {
      const acct = await deps.usage.account().catch(() => undefined);
      const saved = await deps.accounts.captureCurrent(acct);
      await ctx.answerCallbackQuery({ text: `Сохранено: ${saved.label}` });
      await rerender(ctx, deps, `\u{1F4BE} Сохранено: ${saved.label}`);
    } catch (e) {
      await ctx.answerCallbackQuery({ text: briefErrorMessage(e as Error).slice(0, 190), show_alert: true });
    }
  });

  bot.callbackQuery("acct:login", async (ctx) => {
    await ctx.answerCallbackQuery();
    await rerender(ctx, deps, "\u{1F511} Выполните вход командой /reauth (через ChatGPT или ключ API), затем нажмите «Сохранить текущий аккаунт».");
  });

  bot.callbackQuery("acct:import", async (ctx) => {
    const reason = busyReason(deps);
    if (reason) return void ctx.answerCallbackQuery({ text: reason, show_alert: true });
    await ctx.answerCallbackQuery({ text: "Импортирую…" });
    await ctx.editMessageText("\u{1F4E5} Импортирую текущий аккаунт Codex…").catch(() => {});
    const res = await auth.importExisting();
    if (!res.ok) return void rerender(ctx, deps, `\u274C ${briefErrorMessage(new Error(res.error ?? "Не удалось импортировать аккаунт."))}`);
    try {
      await deps.acp.restart();
    } catch (e) {
      return void rerender(ctx, deps, `\u26A0\uFE0F Аккаунт импортирован, но Codex не удалось перезапустить: ${briefErrorMessage(e as Error)}`);
    }
    // Confirm codex actually accepts the imported login before saving it.
    if (!(await deps.usage.isLoggedIn())) {
      return void rerender(ctx, deps, `\u274C ${UNSUPPORTED_LOGIN_HELP}`);
    }
    const acct = await deps.usage.account().catch(() => undefined);
    let note = "\u2705 Текущий аккаунт Codex импортирован.";
    try {
      const saved = await deps.accounts.captureCurrent(acct);
      note = `\u2705 Импортирован и сохранён аккаунт ${saved.label}.`;
    } catch {
      /* capture is best-effort */
    }
    await rerender(ctx, deps, note);
  });

  bot.callbackQuery(/^acct:switch:(.+)$/, async (ctx) => {
    const id = ctx.match![1]!;
    const reason = busyReason(deps);
    if (reason) return void ctx.answerCallbackQuery({ text: reason, show_alert: true });
    await ctx.answerCallbackQuery({ text: "Переключаю…" });
    try {
      // Don't lose the current login: snapshot it before overwriting (dedupes).
      await deps.accounts.captureCurrent(await deps.usage.account().catch(() => undefined)).catch(() => {});
      const meta = deps.accounts.get(id);
      if (!meta) throw new Error("Этот аккаунт уже не сохранён.");
      await ctx.editMessageText(`\u{1F504} Переключаюсь на ${meta.label} и перезапускаю Codex…`).catch(() => {});
      const loggedIn = await deps.accountRotator.runExclusive(id, () => deps.usage.isLoggedIn());
      const note = loggedIn
        ? `\u2705 Выбран аккаунт ${meta.label}. Сеанс подключится при следующем сообщении.`
        : `\u26A0\uFE0F Выбран аккаунт ${meta.label}, но Codex сообщает, что вход не выполнен. ${UNSUPPORTED_LOGIN_HELP}`;
      await rerender(ctx, deps, note);
    } catch (e) {
      log.warn("account switch failed:", (e as Error).message);
      await rerender(ctx, deps, `\u274C ${briefErrorMessage(e as Error)}`);
    }
  });

  bot.callbackQuery(/^acct:del:(.+)$/, async (ctx) => {
    const id = ctx.match![1]!;
    const meta = deps.accounts.get(id);
    await deps.accounts.forget(id);
    await ctx.answerCallbackQuery({ text: meta ? `Удалён аккаунт ${meta.label}` : "Аккаунт удалён" });
    await rerender(ctx, deps);
  });
}
