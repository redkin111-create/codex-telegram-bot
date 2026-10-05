/** Short-lived, chat-bound download buttons for files created by Codex. */
import { randomBytes } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { InputFile, InlineKeyboard } from "grammy";

const MAX_BYTES = 10 * 1024 * 1024;
const TOKEN_TTL_MS = 15 * 60_000;
const ALLOWED = new Set([".txt", ".md", ".json", ".csv", ".log", ".pdf", ".zip", ".tar", ".gz", ".tgz", ".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const SENSITIVE = /(?:^|[._ -])(?:env|secret|credential|token|password|passwd|private|id_rsa|api[_ -]?key)/i;
const SOURCE_OR_LOCK = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]);

interface ArtifactToken {
  chatId: number;
  root: string;
  path: string;
  name: string;
  expiresAt: number;
}

export interface ArtifactOffer {
  keyboard?: InlineKeyboard;
  names: string[];
}

export class OutgoingArtifactStore {
  private readonly tokens = new Map<string, ArtifactToken>();

  offer(chatId: number, cwd: string, paths: string[], base?: InlineKeyboard): ArtifactOffer {
    const root = resolve(cwd);
    const candidates = [...new Set(paths)].filter((path) => this.isCandidate(root, path)).slice(0, 6);
    if (candidates.length === 0) return { keyboard: base, names: [] };
    const keyboard = base ?? new InlineKeyboard();
    const names: string[] = [];
    for (const path of candidates) {
      const name = path.replace(/\\/g, "/").split("/").at(-1) || "file";
      const token = randomBytes(8).toString("hex");
      this.tokens.set(token, { chatId, root, path, name, expiresAt: Date.now() + TOKEN_TTL_MS });
      keyboard.text(`📎 ${name.slice(0, 32)}`, `artifact:${token}`).row();
      names.push(name);
    }
    this.prune();
    return { keyboard, names };
  }

  async send(api: { sendDocument: (...args: any[]) => Promise<unknown> }, chatId: number, token: string): Promise<boolean> {
    const record = this.tokens.get(token);
    if (!record || record.chatId !== chatId || record.expiresAt <= Date.now()) return false;
    const absolute = resolve(record.path);
    if (!this.isInside(record.root, absolute)) return false;
    try {
      const rootReal = await realpath(record.root);
      const fileInfo = await lstat(absolute);
      if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size > MAX_BYTES) return false;
      const real = await realpath(absolute);
      if (!this.isInside(rootReal, real)) return false;
      const bytes = await readFile(real);
      if (bytes.length > MAX_BYTES) return false;
      await api.sendDocument(chatId, new InputFile(bytes, record.name), { caption: `📎 ${record.name}` });
      return true;
    } catch {
      return false;
    }
  }

  private isCandidate(root: string, rawPath: string): boolean {
    const path = resolve(root, rawPath);
    if (!this.isInside(root, path)) return false;
    const rel = relative(root, path).replace(/\\/g, "/");
    const parts = rel.split("/");
    if (parts.some((part) => part === ".git" || part === "node_modules" || part.startsWith("."))) return false;
    const name = parts.at(-1) || "";
    if (SENSITIVE.test(name) || name.toLowerCase() === ".env" || SOURCE_OR_LOCK.has(name.toLowerCase())) return false;
    if (!ALLOWED.has(extname(name).toLowerCase())) return false;
    try {
      const rootReal = realpathSync(root);
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) return false;
      return this.isInside(rootReal, realpathSync(path));
    } catch {
      return false;
    }
  }

  private isInside(root: string, path: string): boolean {
    const rel = relative(root, path);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, item] of this.tokens) if (item.expiresAt <= now) this.tokens.delete(token);
  }
}
