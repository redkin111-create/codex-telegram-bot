import { isIP } from "node:net";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Restrict phone-initiated marketplace downloads to GitHub HTTPS remotes, never local paths or SSH. */
export function validateMobileMarketplaceSource(value: string): string {
  if (typeof value !== "string") throw new Error("Укажите HTTPS-адрес или owner/repo");
  const source = value.trim();
  if (!source || source.length > 2048 || /[\u0000-\u0020\u007f]/.test(source)) {
    throw new Error("Укажите HTTPS-адрес или owner/repo без пробелов и управляющих символов");
  }
  const shorthand = /^([A-Za-z0-9][A-Za-z0-9_.-]{0,99})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})$/.exec(source);
  if (shorthand && shorthand[1] !== "." && shorthand[1] !== ".." && shorthand[2] !== "." && shorthand[2] !== "..") {
    return source;
  }

  if (!/^https:\/\//i.test(source) || /(?:^|\\|\/)\.{1,2}(?:\\|\/|$)|%2e/i.test(source)) {
    throw new Error("Укажите HTTPS-адрес или owner/repo; локальные пути и SSH не принимаются");
  }
  let url: URL;
  try { url = new URL(source); }
  catch { throw new Error("Недопустимый адрес каталога"); }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("HTTPS-адрес каталога должен быть без имени пользователя и пароля");
  }
  if ((url.port && url.port !== "443") || url.search || url.hash || hostname !== "github.com" || isIP(hostname)) {
    throw new Error("Для безопасной загрузки с телефона используйте GitHub HTTPS или owner/repo");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 2 || !/^[A-Za-z0-9_.-]{1,100}$/.test(segments[0] ?? "") ||
      !/^[A-Za-z0-9_.-]{1,100}(?:\.git)?$/.test(segments[1] ?? "") ||
      segments.some((segment) => segment === "." || segment === ".." || /%2f|%5c/i.test(segment))) {
    throw new Error("Недопустимый адрес каталога");
  }
  return url.href.replace(/\/$/, "");
}

export function validateMobileMarketplaceRef(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const ref = value.trim();
  if (ref.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) ||
      ref.includes("..") || ref.includes("//") || ref.endsWith("/") || ref.endsWith(".")) {
    throw new Error("Недопустимая ветка или версия каталога");
  }
  return ref;
}

/** Recheck the live Codex plugin catalogue before global marketplace mutations. */
export function requireManagedMarketplace(value: unknown, marketplaceName: string): string {
  if (!marketplaceName || marketplaceName.length > 120 || /[\u0000-\u001f\u007f\\/:]/.test(marketplaceName)) {
    throw new Error("Выберите каталог из списка Codex");
  }
  const matches = list(record(value)?.marketplaces).map(record).filter((entry) => entry?.name === marketplaceName);
  if (matches.length !== 1 || typeof matches[0]?.path !== "string" || matches[0].path.length === 0) {
    throw new Error("Этот каталог не управляется в мобильном клиенте");
  }
  return marketplaceName;
}
