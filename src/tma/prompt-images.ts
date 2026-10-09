/** Strict allowlist for images sent from the authenticated Telegram Mini App. */
import { createHash } from "node:crypto";
import type { PromptImage } from "../app/types.js";

export const TMA_MAX_IMAGES = 3;
export const TMA_MAX_IMAGE_BYTES = 1536 * 1024;

export function parseTmaImages(value: unknown): PromptImage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > TMA_MAX_IMAGES) {
    throw new Error("Можно прикрепить не больше трёх изображений");
  }
  return value.map((entry: unknown): PromptImage => {
    if (!entry || typeof entry !== "object") throw new Error("Недопустимое изображение");
    const item = entry as Record<string, unknown>;
    const mimeType = item.mimeType;
    const data = item.data;
    if (mimeType !== "image/jpeg" && mimeType !== "image/png" && mimeType !== "image/webp") {
      throw new Error("Поддерживаются только JPEG, PNG и WebP");
    }
    if (typeof data !== "string" || data.length < 16 ||
        data.length > Math.ceil(TMA_MAX_IMAGE_BYTES / 3) * 4 + 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
      throw new Error("Фото повреждено или превышает 1,5 МБ");
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.length < 16 || bytes.length > TMA_MAX_IMAGE_BYTES ||
        bytes.toString("base64") !== data) {
      throw new Error("Фото повреждено или превышает 1,5 МБ");
    }
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const webp = bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP";
    if (!(mimeType === "image/jpeg" && jpeg || mimeType === "image/png" && png ||
      mimeType === "image/webp" && webp)) {
      throw new Error("Содержимое фото не соответствует его формату");
    }
    return {mimeType,data};
  });
}

/** Immutable fingerprint for idempotency across transient HTTP errors. */
export function tmaPromptFingerprint(text: string, images: PromptImage[]): string {
  const hash = createHash("sha256");
  hash.update(text);
  for (const image of images) hash.update(image.mimeType).update(image.data);
  return hash.digest("hex");
}
