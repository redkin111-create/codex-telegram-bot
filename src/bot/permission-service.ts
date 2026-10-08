/**
 * PermissionService — turns Codex exec/patch approval requests into inline
 * Approve/Deny buttons. It names the session that needs approval, keeps the
 * prompt visible while honoring notification sound settings, and — when the
 * request belongs to a *background* session — adds a "🔀 Switch to it" button. The Allow/Deny
 * buttons resolve the request in place, without switching.
 */
import type { Api } from "grammy";
import { InlineKeyboard } from "grammy";
import type { PermissionOutcome, RequestPermissionParams } from "../acp/types.js";
import { describeRequestedPermissions } from "../acp/approvals.js";
import { createLogger } from "../logger.js";
import type { SettingsStore } from "../app/settings-store.js";
import { notificationShouldBeLoud } from "../app/notifications.js";
import type { RuntimeRegistry } from "./registry.js";

const log = createLogger("permissions");
const TIMEOUT_MS = 10 * 60 * 1000;

const KIND_ICON: Record<string, string> = {
  read: "\u{1F4D6}",
  edit: "\u270F\uFE0F",
  execute: "\u{1F4BB}",
  delete: "\u{1F5D1}\uFE0F",
  move: "\u{1F4E6}",
  fetch: "\u{1F310}",
};
const KIND_LABEL: Record<string, string> = {
  read: "Чтение", edit: "Изменение", execute: "Запуск команды",
  delete: "Удаление", move: "Перемещение", fetch: "Загрузка",
};

interface Pending {
  resolve: (o: PermissionOutcome) => void;
  options: RequestPermissionParams["options"];
  chatId: number;
  sessionId: string;
  messageId?: number;
  timer: NodeJS.Timeout;
}

export class PermissionService {
  private readonly pending = new Map<string, Pending>();
  private seq = 0;

  constructor(
    private readonly api: Api,
    private readonly registry: RuntimeRegistry,
    private readonly settings?: SettingsStore,
    private readonly globalQuiet = false,
  ) {}

  /** Handle a permission request: ask the owning chat, or auto-allow if none. */
  async handle(params: RequestPermissionParams): Promise<PermissionOutcome> {
    const permissionDetails = params.permissions ? describeRequestedPermissions(params.permissions) : undefined;
    if (params.permissions && !permissionDetails) return deny();
    const desc = this.registry.describeSession(params.sessionId);
    const chatId = desc.chatId;
    if (chatId === undefined) return deny(); // unattended work must never approve itself

    const reqId = String(++this.seq);
    const isForeground = !desc.subagent && this.registry.get(chatId).sessionId === params.sessionId;
    // A "Switch to it" button only makes sense for a real, controlled background
    // session — never for the foreground, and never for a subagent (which the
    // chat doesn't control directly).
    const canSwitch = desc.controlled && !isForeground;
    const label = desc.subagent
      ? desc.subagentName || "subagent"
      : desc.projectName || "Сеанс Codex";

    const kb = new InlineKeyboard();
    const options = params.permissions
      ? [
          { optionId: "grant", name: "Разрешить один раз", kind: "allow_once" },
          { optionId: "deny", name: "Отклонить", kind: "reject_once" },
        ]
      : params.options;
    options.forEach((o, i) => kb.text(buttonLabel(o), `perm:${reqId}:${i}`));
    kb.row();
    if (canSwitch) kb.text(`\u{1F500} Перейти к ${label}`, `permsw:${reqId}`);

    let messageId: number | undefined;
    try {
      const msg = await this.api.sendMessage(
        chatId,
        describe(params, { label: isForeground ? undefined : label, subagent: desc.subagent, canSwitch, permissionDetails }),
        {
          reply_markup: kb,
          disable_notification: !notificationShouldBeLoud(
            this.settings?.get(chatId).notifications?.mode ?? "all",
            this.globalQuiet,
            "approval",
          ),
        },
      );
      messageId = msg.message_id;
    } catch (e) {
      log.warn("failed to send permission prompt:", (e as Error).message);
      return deny();
    }

    return new Promise<PermissionOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        void this.api.editMessageText(chatId, messageId!, "\u231B Время ожидания истекло. Действие отклонено.").catch(() => {});
        resolve({ outcome: { outcome: "cancelled" } });
      }, TIMEOUT_MS);
      this.pending.set(reqId, { resolve, options, chatId, sessionId: params.sessionId, messageId, timer });
    });
  }

  /** Resolve a pending request from a button tap; returns the chosen label. */
  resolveChoice(reqId: string, index: number, chatId: number): string | undefined {
    const p = this.pending.get(reqId);
    if (!p || p.chatId !== chatId) return undefined;
    clearTimeout(p.timer);
    this.pending.delete(reqId);
    const opt = p.options[index];
    if (!opt) {
      p.resolve({ outcome: { outcome: "cancelled" } });
      return undefined;
    }
    p.resolve({ outcome: { outcome: "selected", optionId: opt.optionId } });
    return optionLabel(opt.name);
  }

  /** The session a pending request belongs to (for the Switch button). */
  sessionFor(reqId: string, chatId: number): string | undefined {
    const pending = this.pending.get(reqId);
    return pending?.chatId === chatId ? pending.sessionId : undefined;
  }
}

function describe(
  params: RequestPermissionParams,
  ctx: { label?: string; subagent: boolean; canSwitch: boolean; permissionDetails?: string[] },
): string {
  const tc = params.toolCall;
  const kind = (tc?.kind || "other").toLowerCase();
  const icon = KIND_ICON[kind] ?? "\u{1F527}";
  const title = tc?.title || KIND_LABEL[kind] || kind;
  const raw = (tc?.rawInput || {}) as Record<string, unknown>;
  const cmd = typeof raw.command === "string" ? raw.command : undefined;
  const path = typeof raw.path === "string" ? raw.path : undefined;
  const detail = params.permissions
    ? `\n\n${ctx.permissionDetails?.map((line) => `• ${line}`).join("\n") ?? ""}${params.reason ? `\n\nПричина: ${params.reason}` : ""}\n\nДоступ будет действовать только для этого запроса.`
    : cmd ? `\n\n$ ${cmd}` : path ? `\n\n${path}` : "";
  const who = ctx.subagent
    ? `\u{1F916}\u{1F510} Дополнительному агенту «${ctx.label}» нужно разрешение на действие:`
    : ctx.label
      ? `\u{1F510} Сеансу «${ctx.label}» нужно разрешение на действие:`
      : "\u{1F510} Codex запрашивает разрешение на действие:";
  const tail = ctx.canSwitch
    ? "\n\nРазрешите действие здесь или нажмите \u{1F500}, чтобы перейти к этому сеансу."
    : ctx.subagent
      ? "\n\nРазрешить дополнительному агенту продолжить?"
      : "\n\nРазрешить действие?";
  return `${who}\n${icon} ${title}${detail}${tail}`;
}

function buttonLabel(o: { name: string; kind?: string }): string {
  const k = `${o.kind ?? ""} ${o.name}`.toLowerCase();
  const icon = /reject|deny|no|cancel/.test(k) ? "\u26D4" : /\b(always|all)\b/.test(k) ? "\u2705\u267E\uFE0F" : "\u2705";
  return `${icon} ${optionLabel(o.name)}`;
}

function optionLabel(name: string): string {
  const k = name.toLowerCase();
  if (/reject|deny|no|cancel/.test(k)) return "Отклонить";
  if (/\b(always|all)\b/.test(k)) return "Всегда разрешать";
  if (/allow|approve|yes|once|session/.test(k)) return "Разрешить";
  return name;
}

function deny(): PermissionOutcome {
  return { outcome: { outcome: "cancelled" } };
}
