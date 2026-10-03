/**
 * ReauthController — drives the whole `/reauth` flow on a SINGLE status message:
 * pick login method → (logout) → login → agent restart. Instead of echoing every
 * spinner frame the CLI emits, it shows one self-animated loader line plus inline
 * controls (a method picker up front, Cancel while running, Retry / Restart agent
 * on failure).
 *
 * Codex authenticates two ways (plus reusing an existing login):
 *   • ChatGPT  → `codex login` prints a URL to approve in a browser (streamed here)
 *   • API key  → `codex login --api-key <key>` (the user sends the key)
 *   • Import   → adopt an existing `$CODEX_HOME/auth.json` already on this machine
 *
 * State is kept per chat so the button callbacks (which arrive on a separate
 * update) can cancel the in-flight login or re-run the flow on the same message.
 */
import { type Api, InlineKeyboard } from "grammy";
import type { AcpClient } from "../acp/client.js";
import { AuthService } from "../app/auth-service.js";
import type { AccountInfo } from "../app/usage.js";
import { createLogger } from "../logger.js";
import { briefErrorMessage } from "./prompt-retry.js";
import { parseDeviceFlow } from "../render/device-flow.js";

const log = createLogger("reauth");

const LOADER = ["▰▱▱▱▱▱▱", "▰▰▱▱▱▱▱", "▰▰▰▱▱▱▱", "▰▰▰▰▱▱▱", "▰▰▰▰▰▱▱", "▰▰▰▰▰▰▱", "▰▰▰▰▰▰▰"];
const ANIM_MS = 2500;
const LOGIN_TIMEOUT_MS = 300_000;

/** Login methods exposed in the picker. */
export type LoginMethod = "chatgpt" | "apikey" | "import";

const METHOD_LABEL: Record<LoginMethod, string> = {
  chatgpt: "ChatGPT",
  apikey: "Ключ API",
  import: "Импортировать аккаунт",
};

type Phase =
  | "choosing"
  | "apikey_input"
  | "logout"
  | "login"
  | "restarting"
  | "done"
  | "failed_login"
  | "failed_restart"
  | "cancelled";
const ACTIVE: ReadonlySet<Phase> = new Set<Phase>(["logout", "login", "restarting"]);

function accountLabel(a: AccountInfo | undefined): string | undefined {
  if (!a) return undefined;
  return a.email || a.accountType;
}

interface ReauthSession {
  chatId: number;
  messageId: number;
  phase: Phase;
  abort?: AbortController;
  anim?: NodeJS.Timeout;
  frame: number;
  url?: string;
  code?: string;
  errorMsg?: string;
  accountLabel?: string;
  lastText?: string;
  method?: LoginMethod;
  /** The OpenAI API key the user sent (only for the `apikey` method). */
  apiKey?: string;
}

export class ReauthController {
  private readonly auth: AuthService;
  private readonly sessions = new Map<number, ReauthSession>();

  constructor(
    private readonly api: Api,
    private readonly acp: AcpClient,
    codexCliPath: string,
    private readonly getAccount?: () => Promise<AccountInfo | undefined>,
    private readonly verifyLogin?: () => Promise<boolean>,
  ) {
    this.auth = new AuthService(codexCliPath);
  }

  isBusy(chatId: number): boolean {
    const s = this.sessions.get(chatId);
    return !!s && ACTIVE.has(s.phase);
  }

  private anyActive(): boolean {
    for (const s of this.sessions.values()) if (ACTIVE.has(s.phase)) return true;
    return false;
  }

  /** Show the login-method picker on a fresh (or reused) status message. */
  async chooseMethod(chatId: number, existingMessageId?: number): Promise<void> {
    if (this.isBusy(chatId)) return;
    let messageId = existingMessageId;
    if (messageId === undefined) {
      const m = await this.api.sendMessage(chatId, "\u{1F510} Вход в Codex…").catch(() => undefined);
      if (!m) return;
      messageId = m.message_id;
    }
    const s: ReauthSession = { chatId, messageId, phase: "choosing", frame: 0 };
    this.sessions.set(chatId, s);
    await this.render(s);
  }

  /** Handle a method choice from the picker. API key needs the key text first. */
  async pickMethod(chatId: number, messageId: number, method: LoginMethod): Promise<void> {
    const s = this.sessions.get(chatId);
    if (!s || s.phase !== "choosing") return;
    s.messageId = messageId;
    s.method = method;
    if (method === "apikey") {
      s.phase = "apikey_input";
      s.errorMsg = undefined;
      s.lastText = undefined;
      await this.render(s);
      return;
    }
    await this.begin(chatId, messageId, method);
  }

  /** True while waiting for the user to type their OpenAI API key. */
  awaitingApiKeyInput(chatId: number): boolean {
    return this.sessions.get(chatId)?.phase === "apikey_input";
  }

  /** Consume the API-key text and kick off the login. */
  async submitApiKeyInput(chatId: number, text: string): Promise<void> {
    const s = this.sessions.get(chatId);
    if (!s || s.phase !== "apikey_input") return;
    const key = text.trim();
    if (!/^sk-[A-Za-z0-9_-]{10,}$/.test(key)) {
      s.errorMsg = "Похоже, это не ключ API OpenAI. Он должен начинаться с `sk-`. Отправьте ключ ещё раз.";
      s.lastText = undefined;
      await this.render(s);
      return;
    }
    s.apiKey = key;
    await this.begin(chatId, s.messageId, "apikey");
  }

  /** Cancel an in-progress picker / key prompt (before any logout happened). */
  async cancelChoice(chatId: number, messageId: number): Promise<void> {
    const s = this.sessions.get(chatId);
    if (s && (s.phase === "choosing" || s.phase === "apikey_input")) this.sessions.delete(chatId);
    await this.api.editMessageText(chatId, messageId, "\u{1F510} Вход отменён.").catch(() => {});
  }

  /** Start (or restart) the flow. Reuses `existingMessageId` for the Retry button. */
  async begin(chatId: number, existingMessageId?: number, method?: LoginMethod): Promise<void> {
    if (this.isBusy(chatId)) return;
    if (this.anyActive()) {
      await this.api
        .sendMessage(chatId, "\u{1F510} В другом чате уже выполняется вход. Попробуйте немного позже.")
        .catch(() => {});
      return;
    }
    if (this.acp.hasInflightPrompt()) {
      await this.api
        .sendMessage(chatId, "\u23F3 Codex занят. Повторите /reauth после завершения задачи или сначала отправьте /cancel.")
        .catch(() => {});
      return;
    }
    let messageId = existingMessageId;
    if (messageId === undefined) {
      const m = await this.api.sendMessage(chatId, "\u{1F510} Выполняю вход в Codex…").catch(() => undefined);
      if (!m) return;
      messageId = m.message_id;
    }
    const prev = this.sessions.get(chatId);
    const s: ReauthSession = { chatId, messageId, phase: "logout", frame: 0, method: method ?? prev?.method, apiKey: prev?.apiKey };
    this.sessions.set(chatId, s);
    void this.run(s);
  }

  cancel(chatId: number): boolean {
    const s = this.sessions.get(chatId);
    if (!s || !ACTIVE.has(s.phase)) return false;
    s.abort?.abort();
    return true;
  }

  async retry(chatId: number, messageId: number): Promise<void> {
    const prev = this.sessions.get(chatId);
    if (prev?.method === "apikey" && !prev.apiKey) {
      // No key retained — reopen the key prompt.
      prev.messageId = messageId;
      prev.phase = "apikey_input";
      prev.errorMsg = undefined;
      prev.lastText = undefined;
      await this.render(prev);
      return;
    }
    await this.begin(chatId, messageId, prev?.method);
  }

  async restartAgent(chatId: number, messageId: number): Promise<void> {
    if (this.isBusy(chatId) || this.anyActive()) return;
    const s: ReauthSession = this.sessions.get(chatId) ?? { chatId, messageId, phase: "restarting", frame: 0 };
    s.messageId = messageId;
    s.phase = "restarting";
    s.errorMsg = undefined;
    this.sessions.set(chatId, s);
    this.startAnim(s);
    await this.render(s);
    try {
      await this.acp.restart();
      s.accountLabel = accountLabel(await this.getAccount?.().catch(() => undefined));
      s.phase = "done";
    } catch (e) {
      s.phase = "failed_restart";
      s.errorMsg = briefErrorMessage(e as Error);
    }
    this.stopAnim(s);
    await this.render(s);
  }

  // ── flow ───────────────────────────────────────────────────────────────────

  private async run(s: ReauthSession): Promise<void> {
    s.abort = new AbortController();
    s.accountLabel = undefined;
    let agentDown = false;
    try {
      // Import: adopt an existing on-disk login. No logout.
      if (s.method === "import") {
        s.phase = "login";
        this.startAnim(s);
        await this.render(s);
        await this.acp.stopAndWait();
        agentDown = true;
        const res = await this.auth.importExisting();
        if (!res.ok) {
          s.phase = "failed_login";
          s.errorMsg = res.error ?? "Не найден аккаунт Codex для импорта.";
          return;
        }
        const up = await this.finishWithRestart(s);
        agentDown = !up;
        return;
      }

      s.phase = "logout";
      this.startAnim(s);
      await this.render(s);
      await this.acp.stopAndWait(); // release the agent before swapping credentials
      agentDown = true;
      await this.auth.logout();
      await this.auth.clearAuth();
      if (s.abort.signal.aborted) {
        s.phase = "cancelled";
        return;
      }

      s.phase = "login";
      s.url = undefined;
      s.code = undefined;
      await this.render(s);

      let result;
      if (s.method === "apikey") {
        result = await this.auth.loginApiKey(s.apiKey ?? "");
      } else {
        let raw = "";
        result = await this.auth.login({
          timeoutMs: LOGIN_TIMEOUT_MS,
          signal: s.abort.signal,
          onOutput: (t) => {
            raw += t;
            this.ingest(s, raw);
          },
        });
      }

      if (result.cancelled || s.abort.signal.aborted) {
        s.phase = "cancelled";
        return;
      }
      if (!result.ok) {
        s.phase = "failed_login";
        s.errorMsg = result.error ?? `Вход не завершён (код завершения: ${result.code ?? "?"}).`;
        return;
      }

      const up = await this.finishWithRestart(s);
      agentDown = !up;
    } catch (e) {
      log.warn("reauth flow failed:", (e as Error).message);
      s.phase = "failed_login";
      s.errorMsg = briefErrorMessage(e as Error);
    } finally {
      s.abort = undefined;
      s.apiKey = undefined; // never retain the secret longer than needed
      this.stopAnim(s);
      if (agentDown && (s.phase === "cancelled" || s.phase === "failed_login")) {
        await this.acp.restart().catch((e) => log.warn("post-reauth agent restart failed:", (e as Error).message));
      }
      await this.render(s);
    }
  }

  /** Restart the agent, verify the login, and settle to done/failed_restart.
   *  Returns whether the agent is up (true unless the restart itself threw). */
  private async finishWithRestart(s: ReauthSession): Promise<boolean> {
    s.phase = "restarting";
    await this.render(s);
    try {
      await this.acp.restart();
      const ok = this.verifyLogin ? await this.verifyLogin().catch(() => false) : true;
      if (!ok) {
        s.phase = "failed_login";
        s.errorMsg = "Codex сообщает, что вход не выполнен. Попробуйте другой способ.";
        return true; // agent restarted fine; the login just didn't take
      }
      s.accountLabel = accountLabel(await this.getAccount?.().catch(() => undefined));
      s.phase = "done";
      return true;
    } catch (e) {
      s.phase = "failed_restart";
      s.errorMsg = briefErrorMessage(e as Error);
      return false;
    }
  }

  private ingest(s: ReauthSession, raw: string): void {
    const p = parseDeviceFlow(raw);
    let changed = false;
    if (p.url && p.url !== s.url) {
      s.url = p.url;
      changed = true;
    }
    if (p.code && p.code !== s.code) {
      s.code = p.code;
      changed = true;
    }
    if (changed) void this.render(s);
  }

  private startAnim(s: ReauthSession): void {
    if (s.anim) return;
    s.anim = setInterval(() => {
      s.frame++;
      void this.render(s);
    }, ANIM_MS);
  }

  private stopAnim(s: ReauthSession): void {
    if (s.anim) {
      clearInterval(s.anim);
      s.anim = undefined;
    }
  }

  // ── rendering ────────────────────────────────────────────────────────────────

  private text(s: ReauthSession): string {
    const loader = LOADER[s.frame % LOADER.length] ?? "";
    switch (s.phase) {
      case "choosing":
        return (
          "\u{1F510} Вход в Codex\nВыберите способ входа:\n\n" +
          "\u{1F4AC} ChatGPT \u2014 откроется ссылка для подтверждения в браузере.\n" +
          "\u{1F511} Ключ API \u2014 отправьте ключ OpenAI вида `sk-...`.\n" +
          "\u{1F4E5} Импорт \u2014 использовать аккаунт Codex, уже сохранённый на этом компьютере."
        );
      case "apikey_input":
        return (
          "\u{1F511} Вход с ключом API OpenAI\n\n" +
          "Отправьте ключ сообщением (он начинается с `sk-`). Он будет использован только для команды " +
          "`codex login --api-key` на этом компьютере и не сохраняется ботом." +
          (s.errorMsg ? `\n\n\u26A0\uFE0F ${briefErrorMessage(new Error(s.errorMsg))}` : "")
        );
      case "logout":
        return `\u{1F510} Вход в Codex…\n\u{1F6AA} Выполняю выход…  ${loader}`;
      case "login": {
        if (s.method === "import") return `\u{1F4E5} Импортирую аккаунт Codex…  ${loader}`;
        if (s.method === "apikey") return `\u{1F511} Вхожу с ключом API…  ${loader}`;
        const lines = ["\u{1F511} Вход через ChatGPT", ""];
        if (s.url) lines.push(`\u{1F517} Откройте ссылку для подтверждения:\n${s.url}`, "");
        if (s.code) lines.push(`\u{1F522} Код подтверждения: ${s.code}`, "");
        if (!s.url && !s.code) lines.push("Начинаю вход…", "");
        else lines.push("Подтвердите вход в браузере. Сообщение обновится автоматически.", "");
        lines.push(`${loader} Ожидаю подтверждения…`);
        return lines.join("\n");
      }
      case "restarting":
        return `\u2705 Вход выполнен.\n\u{1F504} Перезапускаю Codex…  ${loader}`;
      case "done":
        return (
          `\u2705 Вход выполнен${s.accountLabel ? `: ${s.accountLabel}` : ""}, Codex перезапущен.\n` +
          "Сеанс подключится при следующем сообщении." +
          (s.accountLabel ? "" : "\nТекущий аккаунт можно посмотреть командой /usage.")
        );
      case "cancelled":
        return "\u{1F6D1} Вход отменён, аккаунт отключён. Нажмите «Повторить» или выберите другой способ.";
      case "failed_login":
        return (
          `\u274C ${briefErrorMessage(new Error(s.errorMsg ?? "Не удалось выполнить вход."))}\n` +
          "Нажмите «Повторить» или выберите другой способ входа."
        );
      case "failed_restart":
        return `\u26A0\uFE0F Вход выполнен, но не удалось перезапустить Codex: ${briefErrorMessage(new Error(s.errorMsg ?? "неизвестная ошибка"))}.`;
      default:
        return "";
    }
  }

  private keyboard(s: ReauthSession): InlineKeyboard | undefined {
    switch (s.phase) {
      case "choosing":
        return new InlineKeyboard()
          .text("\u{1F4AC} ChatGPT", "reauth:method:chatgpt")
          .row()
          .text("\u{1F511} Ключ API", "reauth:method:apikey")
          .text("\u{1F4E5} Импортировать", "reauth:method:import")
          .row()
          .text("\u274C Отмена", "reauth:choose-cancel");
      case "apikey_input":
        return new InlineKeyboard()
          .text("\u2B05 Назад", "reauth:choose-back")
          .text("\u274C Отмена", "reauth:choose-cancel");
      case "logout":
      case "login":
        return new InlineKeyboard().text("\u274C Отмена", "reauth:cancel");
      case "cancelled":
      case "failed_login":
        return new InlineKeyboard()
          .text("\u{1F501} Повторить", "reauth:retry")
          .text("\u{1F504} Другой способ", "reauth:choose-back");
      case "failed_restart":
        return new InlineKeyboard()
          .text("\u{1F504} Перезапустить Codex", "reauth:restart")
          .text("\u{1F501} Повторить вход", "reauth:retry");
      default:
        return undefined;
    }
  }

  private async render(s: ReauthSession): Promise<void> {
    const text = this.text(s);
    if (text === s.lastText) return;
    s.lastText = text;
    await this.api
      .editMessageText(s.chatId, s.messageId, text, {
        reply_markup: this.keyboard(s),
        link_preview_options: { is_disabled: true },
      })
      .catch(() => {});
  }
}

export { METHOD_LABEL };
