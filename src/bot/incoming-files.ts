/** Safe storage and bounded download helpers for Telegram attachments. */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Api } from "grammy";

export const MAX_TELEGRAM_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
const ALLOWED_EXTENSIONS = new Set([".txt", ".md", ".json", ".csv", ".log", ".pdf", ".zip"]);
const SAFE_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export function isSafeTelegramImageMime(value?: string): boolean {
  return SAFE_IMAGE_MIMES.has((value || "").toLowerCase().split(";")[0]!.trim());
}

export class IncomingFileError extends Error {
  constructor(readonly reason: "too-large" | "unsupported" | "download") {
    super(reason);
  }
}

export function safeAttachmentFilename(value?: string): string {
  const leaf = (value || "file").replace(/\\/g, "/").split("/").at(-1) || "file";
  const safe = leaf.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^\p{L}\p{N}._ -]+/gu, "_").replace(/\s+/g, " ").trim().slice(0, 120);
  return safe.replace(/^\.+/, "") || "file";
}

export function isAllowedTelegramDocument(fileName?: string, mimeType?: string): boolean {
  const mime = (mimeType || "").toLowerCase().split(";")[0]!.trim();
  if (isSafeTelegramImageMime(mime)) return true;
  return ALLOWED_EXTENSIONS.has(extname(safeAttachmentFilename(fileName)).toLowerCase());
}

export async function downloadTelegramFile(
  api: Api,
  token: string,
  fileId: string,
  sizeHint?: number,
): Promise<Buffer> {
  if (typeof sizeHint === "number" && sizeHint > MAX_TELEGRAM_ATTACHMENT_BYTES) {
    throw new IncomingFileError("too-large");
  }
  const file = await api.getFile(fileId);
  if (!file.file_path) throw new IncomingFileError("download");
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!response.ok || !response.body) throw new IncomingFileError("download");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_TELEGRAM_ATTACHMENT_BYTES) {
    await response.body.cancel().catch(() => {});
    throw new IncomingFileError("too-large");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const part of response.body) {
    const chunk = Buffer.from(part);
    total += chunk.length;
    if (total > MAX_TELEGRAM_ATTACHMENT_BYTES) {
      await response.body.cancel().catch(() => {});
      throw new IncomingFileError("too-large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

export async function saveIncomingAttachment(
  dataDir: string,
  originalName: string,
  contents: Buffer,
): Promise<{ path: string; name: string }> {
  if (contents.length > MAX_TELEGRAM_ATTACHMENT_BYTES) throw new IncomingFileError("too-large");
  const name = safeAttachmentFilename(originalName);
  const directory = join(dataDir, "telegram-incoming");
  await mkdir(directory, { recursive: true });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new IncomingFileError("download");
  const path = join(directory, `${randomUUID()}-${name}`);
  await writeFile(path, contents, { flag: "wx", mode: 0o600 });
  return { path, name };
}

/** Remove only old ordinary files from the bot-owned incoming directory. */
export async function cleanupIncomingAttachments(dataDir: string, now = Date.now()): Promise<number> {
  const directory = join(dataDir, "telegram-incoming");
  let entries;
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return 0;
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(directory, entry.name);
    try {
      const info = await lstat(path);
      if (info.isFile() && now - info.mtimeMs > RETAIN_MS) {
        await unlink(path);
        removed++;
      }
    } catch { /* best-effort cleanup */ }
  }
  return removed;
}

export async function removeIncomingAttachment(dataDir: string, path: string): Promise<boolean> {
  const root = resolve(dataDir, "telegram-incoming");
  const absolute = resolve(path);
  const rel = relative(root, absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || resolve(absolute, "..") !== root) return false;
  try {
    const directoryInfo = await lstat(root);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) return false;
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    await unlink(absolute);
    return true;
  } catch {
    return false;
  }
}
