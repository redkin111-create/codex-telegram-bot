/**
 * Agent image return — detects image files the agent produced this turn
 * (screenshots, diagrams…) from its output and tool inputs, and sends them
 * back to Telegram. Only fresh files (modified during the turn) are sent.
 */
import { type Api, InputFile } from "grammy";
import { realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { createLogger } from "../logger.js";

const log = createLogger("image-return");

const PATH_RE = /[^\s"'`<>|()*\[\]]+\.(?:png|jpe?g|gif|webp|bmp)/gi;
const QUOTED_PATH_RE = /["'`]([^"'`\r\n]+\.(?:png|jpe?g|gif|webp|bmp))["'`]/gi;
const ABSOLUTE_PATH_RE = /(?<![A-Za-z0-9_.-])(?:[a-z]:\\|\\\\|\/)[^"'`<>|\r\n]*?\.(?:png|jpe?g|gif|webp|bmp)(?=$|[\s"'`<>|.,;:!?)}\]])/gi;
const PHOTO_EXT = new Set(["png", "jpg", "jpeg", "webp"]);
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 45 * 1024 * 1024;

/** Pull candidate image paths out of arbitrary text, resolved against cwd. */
export function extractImagePaths(text: string, cwd: string): string[] {
  const out = new Set<string>();
  const quoted = [...text.matchAll(QUOTED_PATH_RE)].map((m) => m[1]!);
  const absolute = [...text.matchAll(ABSOLUTE_PATH_RE)].map((m) => m[0]);
  const unquoted = text.replace(QUOTED_PATH_RE, " ").replace(ABSOLUTE_PATH_RE, " ");
  const candidates = [
    ...quoted,
    ...absolute,
    ...[...unquoted.matchAll(PATH_RE)].map((m) => m[0]),
  ];
  for (const candidate of candidates) {
    const raw = candidate.replace(/[).,;:]+$/, "");
    const isAbsoluteImagePath = isAbsolute(raw) || /^[a-z]:[\\/]/i.test(raw) || /^\\\\/.test(raw);
    out.add(isAbsoluteImagePath ? raw : join(cwd, raw));
  }
  return [...out];
}

export interface SendImagesOptions {
  /** Only send files modified at/after this epoch ms (fresh this turn). */
  since: number;
  /** Paths already sent (mutated to dedupe). */
  already: Set<string>;
  /** Max images to send in this call. */
  max: number;
  /** User prompt to thread the image under. */
  replyTo?: number;
  /** Restrict externally observed screenshot paths to the chosen workspace. */
  allowedRoot?: string;
}

/** Send the valid, fresh, not-yet-sent images. Returns how many were sent. */
export async function sendImages(
  api: Api,
  chatId: number,
  paths: string[],
  opts: SendImagesOptions,
): Promise<number> {
  let sent = 0;
  let realRoot: string | undefined;
  if (opts.allowedRoot) {
    try { realRoot = realpathSync(opts.allowedRoot); }
    catch { return 0; }
  }
  for (const path of paths) {
    if (sent >= opts.max) break;
    if (opts.already.has(path)) continue;
    if (realRoot) {
      try {
        const rel = relative(realRoot, realpathSync(path));
        if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
      } catch { continue; }
    }
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size === 0 || st.size > MAX_FILE_BYTES) continue;
    if (st.mtimeMs < opts.since - 2000) continue; // skip pre-existing files
    try {
      const ext = path.toLowerCase().split(".").pop() ?? "";
      const asPhoto = PHOTO_EXT.has(ext) && st.size <= MAX_PHOTO_BYTES;
      const file = new InputFile(path);
      const reply = opts.replyTo === undefined ? {} : {
        reply_parameters: { message_id: opts.replyTo, allow_sending_without_reply: true },
      };
      if (asPhoto) await api.sendPhoto(chatId, file, { caption: basename(path), ...reply });
      else await api.sendDocument(chatId, file, { caption: basename(path), ...reply });
      opts.already.add(path);
      sent++;
    } catch (e) {
      log.debug(`failed to send ${path}:`, (e as Error).message);
    }
  }
  return sent;
}
