/**
 * Transient-prompt retry policy + the user-facing copy that goes with it.
 *
 * Policy: when a prompt fails with a *transient* agent error (e.g. "high volume
 * of traffic" / -32603 "Internal error") **before any output streamed**, wait
 * and retry with an exponential backoff that starts at 6s and doubles up to a
 * 60s (1 minute) cap, then gives up with a short summary. Detailed diagnostics
 * remain in local logs; Telegram receives only a concise retry/failure notice.
 */

/** First backoff delay (ms). */
export const RETRY_BASE_MS = 6_000;
/** Maximum backoff delay (ms) — "up to 1 minute". */
export const RETRY_CAP_MS = 60_000;

/**
 * Backoff delays (ms) preceding each retry, doubling from {@link RETRY_BASE_MS}
 * and capped at {@link RETRY_CAP_MS}. The schedule stops once it hits the cap,
 * and never exceeds `maxRetries` entries.
 *
 * `maxRetries >= 5` ⇒ `[6000, 12000, 24000, 48000, 60000]`.
 */
export function backoffSchedule(maxRetries: number): number[] {
  const out: number[] = [];
  let delay = RETRY_BASE_MS;
  for (let i = 0; i < maxRetries; i++) {
    out.push(Math.min(delay, RETRY_CAP_MS));
    if (delay >= RETRY_CAP_MS) break;
    delay *= 2;
  }
  return out;
}

/** Human-friendly seconds label, e.g. 6000 → "6s", 90000 → "1m 30s". */
export function fmtSeconds(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m} мин. ${rem} с` : `${m} мин.`;
}

/**
 * Message shown when an attempt fails but another retry is scheduled.
 */
export function formatRetryNotice(
  _error: Error,
  nextAttempt: number,
  totalAttempts: number,
  waitMs: number,
): string {
  return [
    "\u23F3 Codex временно не смог продолжить работу.",
    "",
    `\u{1F501} Повтор через ${fmtSeconds(waitMs)} \u2014 попытка ${nextAttempt} из ${totalAttempts}…`,
  ].join("\n");
}

/** Keep blocking errors useful without forwarding stack traces or multiline tool output. */
export function briefErrorMessage(error: Error): string {
  const line = error.message.split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ").trim();
  if (!line) return "причина не указана";
  return line.length > 280 ? `${line.slice(0, 277)}…` : line;
}

/** Final summary shown after all retries are exhausted (or retry was unsafe). */
export function formatErrorSummary(error: Error, elapsed: string, attempts: number, transient: boolean): string {
  const retryCount = attempts > 1 ? ` после ${attempts} попыток` : "";
  const reason = briefErrorMessage(error);
  const tip = transient
    ? "\n\n\u{1F4A1} Попробуйте другую модель в меню или укажите её командой /model <название>. Либо повторите запрос позже."
    : "";
  return `\u274C Не удалось завершить задачу${retryCount} (${elapsed}).\nПричина: ${reason}${tip}`;
}
