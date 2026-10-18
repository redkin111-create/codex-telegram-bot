/**
 * Build ACP prompt content blocks from a PromptInput (text + images), applying
 * any reasoning preference and fork-priming context. Also merges queued inputs.
 */
import type { ContentBlock } from "../acp/types.js";
import type { PromptInput } from "../app/types.js";

export interface ContentOptions {
  reasoning?: string;
  priming?: string;
}

export function buildContentBlocks(input: PromptInput, opts: ContentOptions = {}): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  for (const img of input.images) {
    blocks.push({ type: "image", data: img.data, mimeType: img.mimeType });
  }
  for (const localPath of input.localImages ?? []) {
    blocks.push({ type: "image", localPath });
  }

  let text = input.text.trim();
  const imageCount = input.images.length + (input.localImages?.length ?? 0);
  if (!text && imageCount > 0) {
    text = imageCount === 1 ? "Проанализируй приложенное изображение." : "Проанализируй приложенные изображения.";
  }
  if (input.quotedText?.trim()) {
    const quoted = input.quotedText.trim();
    const body = text || "(в сообщении пользователя нет дополнительного текста)";
    text = `Пользователь отвечает на это сообщение:\n\n<<<\n${quoted}\n>>>\n\n${body}`;
  }
  if (opts.priming) {
    text = `${opts.priming}\n\n---\n\nНовое сообщение пользователя:\n${text}`;
  }
  if (opts.reasoning) {
    text = `(${opts.reasoning})\n\n${text}`;
  }

  blocks.push({ type: "text", text });
  for (const name of input.skillNames ?? []) {
    if (name) blocks.push({ type: "skill", name });
  }
  for (const id of input.appIds ?? []) {
    if (id) blocks.push({ type: "appMention", id });
  }
  return blocks;
}

/** Merge queued inputs into a single prompt (concatenated text, all images). */
export function mergeInputs(inputs: PromptInput[]): PromptInput {
  const quotes = inputs
    .map((i) => i.quotedText?.trim())
    .filter((q): q is string => !!q);
  const skillNames = [...new Set(inputs.flatMap((i) => i.skillNames ?? []))];
  const appIds = [...new Set(inputs.flatMap((i) => i.appIds ?? []))];
  return {
    text: inputs
      .map((i) => i.text)
      .filter((t) => t.trim().length > 0)
      .join("\n\n"),
    images: inputs.flatMap((i) => i.images),
    ...(inputs.some((i) => i.localImages?.length) ? { localImages: inputs.flatMap((i) => i.localImages ?? []) } : {}),
    ...(skillNames.length ? { skillNames } : {}),
    ...(appIds.length ? { appIds } : {}),
    replyTo: inputs.find((i) => i.replyTo !== undefined)?.replyTo,
    quotedText: quotes.length > 0 ? [...new Set(quotes)].join("\n\n---\n\n") : undefined,
  };
}

export function imageSummary(input: PromptInput): string {
  const count = input.images.length + (input.localImages?.length ?? 0);
  return count > 0 ? ` (+${count} image${count > 1 ? "s" : ""})` : "";
}
