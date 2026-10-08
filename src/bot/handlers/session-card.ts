/**
 * Builds a rich, readable "card" for a single Codex session: a plain-text body
 * (no MarkdownV2 so Windows paths and titles never need escaping) plus an
 * inline keyboard with Connect / History / Watch actions.
 *
 * Callback data is unchanged (`sess:` / `hist:` / `watch:` + UUID) so the
 * existing handlers in sessions.ts keep working.
 */
import { InlineKeyboard } from "grammy";
import { basename } from "node:path";
import { progressBar } from "../../render/progress.js";
import type { SessionMeta } from "../../sessions/types.js";

export interface SessionCardExtras {
  /** Optional label for the action that opens or resumes this session. */
  openLabel?: string;
  /** Context-usage %, when the session is loaded in the current ACP process. */
  contextPct?: number;
  /**
   * PID of the bot's own `codex app-server` process. A session locked by this PID
   * powers the bot itself, so its card omits the Kill button (killing it would
   * take the bot down). Other live sessions get a 🛑 Kill button.
   */
  selfPid?: number;
  /** Latest task-completion % (0–100) for this session, if this chat runs it. */
  progress?: number;
  origin?: "existing" | "telegram";
}

export interface SessionCard {
  text: string;
  keyboard: InlineKeyboard;
}

/** Build the card body + buttons for one session. */
export function buildSessionCard(m: SessionMeta, extra: SessionCardExtras = {}): SessionCard {
  const proj = m.projectName || (m.cwd ? basename(m.cwd.replaceAll("\\", "/")) : "проект не указан");
  const lines = [`💬 ${m.title}`, `📁 ${proj}`, `🕒 ${relTime(m.updatedAt)}`];
  lines.push(extra.origin === "telegram" || m.telegramCreated ? "📱 Сеанс Telegram" : "🖥 Сеанс Codex");
  if (m.active) lines.push("⏳ Выполняется");
  if (typeof extra.contextPct === "number") lines.push(`🧠 Контекст ${Math.round(extra.contextPct)}%`);
  if (typeof extra.progress === "number") lines.push(`📈 ${progressBar(extra.progress)}`);

  const connect = extra.openLabel ?? "▶️ Продолжить";
  const keyboard = new InlineKeyboard()
    .text(connect, `sess:${m.sessionId}`)
    .text("\u{1F4DC} История", `hist:${m.sessionId}`);
  // Codex no longer exposes reliable per-thread on-disk live/lock metadata.
  // Watching the rollout is harmless even when the thread is currently idle.
  keyboard.row().text("📡 Наблюдать", `watch:${m.sessionId}`);


  return { text: lines.join("\n"), keyboard };
}

/** Compact Russian relative time used consistently throughout session lists. */
export function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "неизвестно";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "сейчас";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин.`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч.`;
  const d = Math.floor(h / 24);
  if (d === 1) return "вчера";
  return `${d} дн.`;
}
