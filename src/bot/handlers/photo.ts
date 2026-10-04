/**
 * Photo & image-document handler. Downloads images (including multi-image
 * albums / media groups) and submits them to Codex as image content blocks
 * alongside the caption text.
 */
import type { Bot, Context } from "grammy";
import type { PromptImage } from "../../app/types.js";
import { createLogger } from "../../logger.js";
import type { BotDeps } from "../deps.js";
import { extractReplyContext } from "../reply-context.js";
import { downloadTelegramFile, IncomingFileError, isSafeTelegramImageMime } from "../incoming-files.js";

const log = createLogger("photo");
const GROUP_DEBOUNCE_MS = 900;

interface GroupBuffer {
  chatId: number;
  caption: string;
  images: PromptImage[];
  replyTo?: number;
  quoted?: string;
  timer: NodeJS.Timeout;
}

export function registerPhotos(bot: Bot, deps: BotDeps): void {
  const groups = new Map<string, GroupBuffer>();

  const onMedia = async (ctx: Context, image: PromptImage | undefined, caption: string): Promise<void> => {
    if (!image) return;
    const chatId = ctx.chat!.id;
    const replyTo = ctx.message?.message_id;
    const quoted = extractReplyContext(ctx);

    // Don't hijack the task wizard.
    if (deps.wizard.isActive(chatId)) {
      await ctx.reply("Сначала завершите создание задачи или отмените его командой /cancel, затем отправьте изображение.");
      return;
    }

    const groupId = ctx.message?.media_group_id;
    if (!groupId) {
      await submit(deps, chatId, caption, [image], replyTo, quoted);
      return;
    }

    // Buffer album items and submit once the group settles.
    const existing = groups.get(groupId);
    if (existing) {
      clearTimeout(existing.timer);
      existing.images.push(image);
      if (caption) existing.caption = caption;
      if (quoted && !existing.quoted) existing.quoted = quoted;
      existing.timer = setTimeout(() => flush(groups, groupId, deps), GROUP_DEBOUNCE_MS);
    } else {
      groups.set(groupId, {
        chatId,
        caption,
        images: [image],
        replyTo,
        quoted,
        timer: setTimeout(() => flush(groups, groupId, deps), GROUP_DEBOUNCE_MS),
      });
    }
  };

  bot.on("message:photo", async (ctx) => {
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    const image = largest ? await download(ctx, largest.file_id, "image/jpeg", deps.cfg.token, largest.file_size) : undefined;
    if (!image) {
      await ctx.reply("❌ Не удалось безопасно загрузить изображение. Лимит — 10 МБ.");
      return;
    }
    await onMedia(ctx, image, ctx.message.caption ?? "");
  });

  bot.on("message:document", async (ctx, next) => {
    const doc = ctx.message.document;
    if (!doc.mime_type?.startsWith("image/")) return next(); // let document-handler logic pass
    if (!isSafeTelegramImageMime(doc.mime_type)) {
      await ctx.reply("❌ Поддерживаются только JPEG, PNG, GIF и WebP.");
      return;
    }
    const image = await download(ctx, doc.file_id, doc.mime_type, deps.cfg.token, doc.file_size);
    if (!image) {
      await ctx.reply("❌ Не удалось безопасно загрузить изображение. Лимит — 10 МБ.");
      return;
    }
    await onMedia(ctx, image, ctx.message.caption ?? "");
  });
}

async function flush(groups: Map<string, GroupBuffer>, groupId: string, deps: BotDeps): Promise<void> {
  const buf = groups.get(groupId);
  if (!buf) return;
  groups.delete(groupId);
  await submit(deps, buf.chatId, buf.caption, buf.images, buf.replyTo, buf.quoted);
}

async function submit(
  deps: BotDeps,
  chatId: number,
  caption: string,
  images: PromptImage[],
  replyTo?: number,
  quoted?: string,
): Promise<void> {
  const result = await deps.registry.submitPrompt(chatId, { text: caption, images, replyTo, quotedText: quoted });
  if (result.kind === "submitted" && result.outcome === "queued") {
    await deps.api.sendMessage(
      chatId,
      `📥 Изображение добавлено в очередь · позиция ${result.runtime.queueLength}`,
    );
  } else {
    await deps.api.sendMessage(chatId, "🖼 Изображение добавлено к задаче.");
  }
}

async function download(
  ctx: Context,
  fileId: string,
  mimeType: string,
  token: string,
  sizeHint?: number,
): Promise<PromptImage | undefined> {
  try {
    const buf = await downloadTelegramFile(ctx.api, token, fileId, sizeHint);
    return { data: buf.toString("base64"), mimeType };
  } catch (e) {
    log.warn(e instanceof IncomingFileError ? `image rejected: ${e.reason}` : "image download failed.");
    return undefined;
  }
}
