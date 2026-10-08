/**
 * Session forking helpers — "logical fork" of a Codex session.
 *
 * A fork is a fresh session in the same project, *primed* with the recent
 * transcript of the session it continues, so the conversation survives when the
 * original can't be used: its exclusive lock is held by another window, or it
 * got throttled / exhausted / stuck mid-turn. Used by:
 *   • lost-session recovery (a persisted session we can't reload), and
 *   • auto-fork-on-error (a transient prompt failure with no streamed output).
 */
import { SessionStore } from "../sessions/store.js";
import { buildTranscript, readHistory } from "../sessions/history.js";

/** Read a compact transcript of a session's recent history from disk, or "". */
export function recentTranscript(sessionsDir: string, sessionId: string, entries = 24): string {
  try {
    const hist = readHistory(new SessionStore(sessionsDir).jsonlPath(sessionId), entries);
    return hist.length > 0 ? buildTranscript(hist) : "";
  } catch {
    return "";
  }
}

/** Priming preamble injected as context into a forked (linked) continuation. */
export function buildPriming(transcript: string): string {
  return [
    "Ты продолжаешь разговор, который всё ещё открыт в другом окне на этом компьютере.",
    "Это связанное продолжение. Ниже приведена недавняя история разговора для контекста.",
    "Продолжай с того же места.",
    "",
    "=== НЕДАВНЯЯ ИСТОРИЯ ===",
    transcript,
    "=== КОНЕЦ ИСТОРИИ ===",
  ].join("\n");
}
