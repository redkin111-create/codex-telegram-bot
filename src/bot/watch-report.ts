/**
 * Lossless Codex watch output. Telegram has a 4096-character message limit,
 * so deliver the complete assistant message in ordered parts; for long answers,
 * also attach the full report as a readable Markdown document.
 */
import { InputFile, type Api } from "grammy";
import type { HistoryEntry } from "../sessions/types.js";
import { sendPlainTextChunks } from "./telegram-io.js";

export const LONG_REPORT_THRESHOLD = 6000;
const DOCUMENT_LIMIT = 10 * 1024 * 1024;

export async function deliverWatchReport(
  api: Api,
  chatId: number,
  entries: HistoryEntry[],
  silent: boolean,
): Promise<void> {
  for (const entry of entries) {
    if (entry.role !== "user" && entry.role !== "assistant") continue;
    if (!entry.text.trim()) continue;
    const header = entry.role === "assistant" ? "🤖 Codex\n" : "👤 Запрос\n";
    const text = header + entry.text;
    // Send the complete file first: even if a later Telegram text chunk fails,
    // the user already has an intact copy of the full report.
    if (entry.role === "assistant" && entry.text.length > LONG_REPORT_THRESHOLD) {
      const markdown = Buffer.from(entry.text, "utf8");
      if (markdown.length <= DOCUMENT_LIMIT) {
        const filename = `codex-report-${new Date(entry.timestamp ?? Date.now()).toISOString().replace(/[:.]/g, "-")}.md`;
        try {
          await api.sendDocument(chatId, new InputFile(markdown, filename), {
            caption: "📄 Полный отчёт Codex без сокращений",
            disable_notification: silent,
          });
        } catch {
          // Continue sending plain text even when document uploads are blocked.
        }
      }
    }
    await sendPlainTextChunks(api, chatId, text, { disable_notification: silent });
  }
}
