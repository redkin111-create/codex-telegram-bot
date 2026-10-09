/** Verify Telegram Mini App initData server-side. Never trust initDataUnsafe. */
import { createHmac, timingSafeEqual } from "node:crypto";

export class TmaAuthError extends Error {
  constructor(message = "Недействительная авторизация Telegram") {
    super(message);
    this.name = "TmaAuthError";
  }
}

/** @returns Telegram user id (the owner's private chat id). */
export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  allowedUsers: ReadonlySet<string>,
  nowSec = Math.floor(Date.now() / 1000),
): number {
  if (!initData || initData.length > 8192 || !botToken) throw new TmaAuthError();
  const pairs = new URLSearchParams(initData);
  const seen = new Set<string>();
  const check: string[] = [];
  for (const [key, value] of pairs) {
    if (seen.has(key)) throw new TmaAuthError("Повторяющееся поле initData");
    seen.add(key);
    if (key !== "hash") check.push(key + "=" + value);
  }
  const supplied = pairs.get("hash");
  if (!supplied || !/^[0-9a-f]{64}$/i.test(supplied)) throw new TmaAuthError();
  const authDate = Number(pairs.get("auth_date"));
  if (!Number.isSafeInteger(authDate) || authDate > nowSec + 30 || nowSec - authDate > 3600) {
    throw new TmaAuthError("Срок авторизации Telegram истёк. Откройте приложение заново.");
  }
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(check.sort().join("\n")).digest();
  if (!timingSafeEqual(expected, Buffer.from(supplied, "hex"))) throw new TmaAuthError();
  let user: unknown;
  try { user = JSON.parse(pairs.get("user") ?? "null"); }
  catch { throw new TmaAuthError(); }
  const id = (user && typeof user === "object") ? (user as {id?:unknown}).id : undefined;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || !allowedUsers.has(String(id))) {
    throw new TmaAuthError("Доступ к приложению запрещён");
  }
  return id;
}
