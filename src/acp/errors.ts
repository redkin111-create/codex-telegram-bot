/**
 * Error classification for Codex turn/RPC failures: a rich error type that
 * preserves the JSON-RPC code/data, plus heuristics for "is this transient
 * (safe to retry)?" and "is this a context-window exhaustion?" — used by the
 * bot runtime's retry / auto-fork / resume logic.
 */

/** JSON-RPC error codes that usually mean "transient backend hiccup". */
const TRANSIENT_CODES = new Set([-32603, -32500, -32000, -32001, 500, 502, 503, 504, 429]);
const TRANSIENT_RE =
  /internal error|high volume|experiencing|overloaded|temporar|unavailable|rate.?limit|too many requests|try again|capacity|dispatch failure|response stream|stream (?:closed|disconnected|error)|connection (?:reset|closed|refused|error)|reset by peer|broken pipe|socket hang ?up|econnreset|econnrefused|enotfound|eai_again|etimedout|\b50[234]\b|\b429\b|backpressure|server is busy/i;

const CONTEXT_EXHAUSTED_RE =
  /context (?:length|window|limit|size|overflow)|maximum context|input (?:is )?too long|prompt (?:is )?too long|too many (?:input )?tokens|token limit|exceeds? (?:the )?(?:maximum|context|token)|reduce the (?:length|size)|context.{0,24}exhaust/i;

/** Error that preserves the agent's JSON-RPC error code and data payload. */
export class AcpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AcpError";
  }
}

/** Heuristic: is this turn failure likely transient and safe to retry? */
export function isTransientAcpError(err: Error): boolean {
  const code = (err as AcpError).code;
  if (typeof code === "number" && TRANSIENT_CODES.has(code)) return true;
  return TRANSIENT_RE.test(err.message);
}

/** Heuristic: did this failure come from an exhausted context window? */
export function isContextExhaustedError(err: Error): boolean {
  return CONTEXT_EXHAUSTED_RE.test(err.message);
}

/** Compact, log/Telegram-safe stringification of an error's data payload. */
export function shortJson(v: unknown): string {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > 300 ? `${s.slice(0, 300)}\u2026` : s;
  } catch {
    return String(v);
  }
}

/** Build a rich AcpError from a JSON-RPC error object. */
export function toAcpError(error: { code: number; message: string; data?: unknown }): AcpError {
  const codeStr = typeof error.code === "number" ? ` [${error.code}]` : "";
  const detail = error.data === undefined ? "" : ` — ${shortJson(error.data)}`;
  return new AcpError(`${error.message || "Codex error"}${codeStr}${detail}`, error.code, error.data);
}
