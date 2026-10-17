import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const TOKEN_FILE = "mobile-admin-token";

async function readToken(path: string): Promise<string> {
  const token = (await readFile(path, "utf8")).trim();
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) throw new Error("Файл локального ключа Codex Mobile повреждён");
  return token;
}

export async function getOrCreateMobileAdminToken(dataDir: string): Promise<string> {
  const path = join(dataDir, TOKEN_FILE);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  try { return await readToken(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const token = randomBytes(32).toString("base64url");
  try {
    await writeFile(path, token, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return readToken(path);
  }
}

export async function approveMobilePairing(input: {
  code: string;
  ownerId: number;
  dataDir: string;
  port: number;
}): Promise<void> {
  if (!/^[A-Z2-9]{10}$/i.test(input.code.trim()) || !Number.isSafeInteger(input.ownerId) || input.ownerId < 1) {
    throw new Error("Укажите действительный код и числовой owner ID");
  }
  if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65535 || input.port === 3301) {
    throw new Error("Неверный порт Codex Mobile");
  }
  const token = await readToken(join(input.dataDir, TOKEN_FILE));
  const response = await fetch(`http://127.0.0.1:${input.port}/_local/pairings/approve`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ code: input.code.trim().toUpperCase(), ownerId: input.ownerId }),
    signal: AbortSignal.timeout(5_000),
  });
  const body = await response.json().catch(() => ({})) as { error?: unknown };
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `Не удалось подтвердить устройство (HTTP ${response.status})`);
  }
}
