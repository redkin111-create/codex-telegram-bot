/** Full-fidelity Telegram delivery for Codex watch/replay reports.
 *
 * Telegram messages have a 4096-character limit. Never silently slice the
 * agent's report: send readable numbered pages, and attach the original UTF-8
 * Markdown as a document when the report is long.
 */
import { type Api, GrammyError, InputFile } from "grammy";
import { createLogger } from "../logger.js";

const log = createLogger("watch-report");
const PAGE_CHARS = 3500;
const MAX_INLINE_PAGES = 8;
const MAX_DOCUMENT_BYTES = 45 * 1024 * 1024;

export function splitReportText(text: string, limit = PAGE_CHARS): string[] {
  if (!text) return [];
  if (limit < 4) throw new RangeError("Report page limit is too small");
  const pages: string[] = [];
  let remaining = text;
  while (remaining) {
    if (remaining.length <= limit) {
      pages.push(remaining);
      break;
    }
    let end = limit;
    const boundary = remaining.lastIndexOf("\n", limit - 1);
    if (boundary > limit / 2) end = boundary + 1;
    // Do not break a UTF-16 surrogate pair (emoji).
    if (end < remaining.length &&
        /[\uD800-\uDBFF]/.test(remaining[end - 1]!) &&
        /[\uDC00-\uDFFF]/.test(remaining[end]!)) end--;
    pages.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  return pages;
}

async function telegramSend<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof GrammyError) || error.error_code !== 429 || attempt >= 3) throw error;
      const wait = (error.parameters?.retry_after ?? 1) * 1000 + 250;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

export interface WatchReportOptions {
  /** Entire report with no part removed or summarized. */
  title?: string;
  silent?: boolean;
}

/** Send a complete report. Long reports are also available as a .md document.
 * For extremely long ones, show a preview plus the complete document instead
 * of flooding the chat with hundreds of Telegram messages. */
export async function sendCompleteWatchReport(
  api: Api, chatId: number, report: string, options: WatchReportOptions = {},
): Promise<void> {
  if (!report.trim()) return;
  const title = options.title ?? "🤖 Отчёт Codex";
  const extra = { disable_notification: options.silent ?? true };
  const pages = splitReportText(report);
  const canAttach = Buffer.byteLength(report, "utf8") <= MAX_DOCUMENT_BYTES;
  const pagesToSend = canAttach && pages.length > MAX_INLINE_PAGES ? pages.slice(0, 1) : pages;
  let sent = 0;
  try {
    for (let i = 0; i < pagesToSend.length; i++) {
      const heading = pages.length === 1 ? title : `${title} · ${i + 1}/${pages.length}`;
      await telegramSend(() => api.sendMessage(chatId, `${heading}\n\n${pagesToSend[i]}`, extra));
      sent++;
    }
  } catch (error) {
    log.warn("Telegram report page delivery failed:", (error as Error).message);
    if (!canAttach) throw error; // cannot promise that the full report was delivered
  }
  if (canAttach && (pages.length > 2 || sent < pagesToSend.length)) {
    const note = pages.length > MAX_INLINE_PAGES
      ? "📄 Полный отчёт вложен файлом: в сообщении выше только начало."
      : "📄 Полный исходный отчёт в Markdown:";
    await telegramSend(() => api.sendDocument(
      chatId,
      new InputFile(Buffer.from(report, "utf8"), "codex-full-report.md"),
      { caption: note, ...extra },
    ));
  }
}
