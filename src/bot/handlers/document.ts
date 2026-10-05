/**
 * Document handler — non-image file attachments.
 *
 * The photo handler (registered earlier) claims image documents and passes
 * everything else through to here. We download the file and either:
 *   • inline its text (the common "long message became a .txt" case, plus code,
 *     logs, JSON, CSV, …), truncated to `DOC_MAX_CHARS`, or
 *   • for a binary file, save it under `<dataDir>/downloads` and tell the agent
 *     the path so it can open it with its own tools.
 *
 * Like photos/voice, submissions respect the follow-up queue and any reply
 * context (see reply-context.ts).
 */
import { extname } from "node:path";
import type { Bot, Context } from "grammy";
import { textPrompt } from "../../app/types.js";
import { createLogger } from "../../logger.js";
import { briefErrorMessage } from "../prompt-retry.js";
import type { BotDeps } from "../deps.js";
import {
  decodeText,
  formatBinaryFilePrompt,
  formatTextFilePrompt,
  looksLikeText,
} from "../file-ingest.js";
import { extractReplyContext } from "../reply-context.js";
import { downloadTelegramFile, isAllowedTelegramDocument, IncomingFileError, removeIncomingAttachment, safeAttachmentFilename, saveIncomingAttachment } from "../incoming-files.js";

const log = createLogger("document");

export function registerDocuments(bot: Bot, deps: BotDeps): void {
  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    // Image documents are downloaded & attached by the photo handler; it only
    // forwards non-image documents here. This guard is a defensive no-op.
    if (doc.mime_type?.startsWith("image/")) return;

    const chatId = ctx.chat.id;
    if (deps.wizard.isActive(chatId)) {
      await ctx.reply("Сначала завершите создание задачи или отмените его командой /cancel, затем отправьте файл.");
      return;
    }

    const name = safeAttachmentFilename(doc.file_name);
    if (!isAllowedTelegramDocument(name, doc.mime_type)) {
      await ctx.reply("❌ Этот тип файла не поддерживается. Отправьте TXT, MD, JSON, CSV, LOG, PDF, ZIP или изображение.");
      return;
    }
    await ctx.replyWithChatAction("typing").catch(() => {});

    let buf: Buffer;
    try {
      buf = await downloadTelegramFile(ctx.api, deps.cfg.token, doc.file_id, doc.file_size);
    } catch (e) {
      log.warn("Telegram document download failed.");
      await ctx.reply(e instanceof IncomingFileError && e.reason === "too-large"
        ? "❌ Файл слишком большой для передачи в Codex (лимит 10 МБ)."
        : "❌ Не удалось скачать файл из Telegram.");
      return;
    }

    const caption = ctx.message.caption ?? "";
    const quoted = extractReplyContext(ctx);
    const replyTo = ctx.message.message_id;

    let promptText: string;
    let attachmentContext: string;
    let savedPath: string | undefined;
    if (looksLikeText(buf, doc.mime_type, name)) {
      const full = decodeText(buf);
      const max = deps.cfg.docMaxChars;
      const truncated = max > 0 && full.length > max;
      const content = truncated ? full.slice(0, max) : full;
      promptText = formatTextFilePrompt(name, content, caption, truncated);
      attachmentContext = formatTextFilePrompt(name, content, "", truncated);
    } else if ([".pdf", ".zip"].includes(extname(name).toLowerCase()) && isExpectedBinary(buf, name)) {
      try {
        savedPath = (await saveIncomingAttachment(deps.cfg.dataDir, name, buf)).path;
      } catch {
        await ctx.reply("❌ Не удалось безопасно сохранить вложение.");
        return;
      }
      promptText = formatBinaryFilePrompt(name, doc.mime_type, buf.length, caption, savedPath);
      attachmentContext = formatBinaryFilePrompt(name, doc.mime_type, buf.length, "", savedPath);
    } else {
      await ctx.reply("❌ Содержимое не похоже на поддерживаемый документ.");
      return;
    }

    try {
      const input = textPrompt(promptText, replyTo, quoted);
      input.attachmentNames = [name];
      input.attachmentContext = attachmentContext;
      input.displayText = caption.trim();
      if (savedPath) input.attachmentPaths = [savedPath];
      const result = await deps.registry.submitPrompt(chatId, input);
      if (result.kind !== "submitted") return;
      if (result.outcome === "queued") {
        await ctx.reply(`📥 Файл «${name}» добавлен в очередь · позиция ${result.runtime.queueLength}`);
      } else {
        await ctx.reply(`📎 Файл отправлен в текущую задачу: ${name}`);
      }
    } catch (e) {
      log.warn(`submit failed for "${name}":`, (e as Error).message);
      if (savedPath) await removeIncomingAttachment(deps.cfg.dataDir, savedPath);
      await ctx.reply(`\u274C Не удалось обработать файл «${name}»: ${briefErrorMessage(e as Error)}`);
    }
  });
}

function isExpectedBinary(buf: Buffer, name: string): boolean {
  const ext = extname(name).toLowerCase();
  if (ext === ".pdf") return buf.subarray(0, 5).toString("ascii") === "%PDF-";
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b
    && [0x03, 0x05, 0x07].includes(buf[2]!) && [0x04, 0x06, 0x08].includes(buf[3]!);
}
